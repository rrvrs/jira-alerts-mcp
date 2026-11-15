import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { allTools } from "../../server.js";
import { httpError, stubClient } from "../test-support.js";
import { createDispatcher, type AllPagesResult, type PageResult } from "./dispatch.js";
import { BudgetError, createCallContext, DispatchError, OperationError } from "./context.js";
import { resolveLimits } from "./limits.js";
import { createRegistry } from "./registry.js";

const ALL = new Set(allTools.map((tool) => tool.name));

function setup(options: {
  reachable?: Set<string>;
  allowWrites?: string[];
  limits?: Partial<ReturnType<typeof resolveLimits>>;
  page?: Parameters<typeof stubClient>[0];
  stub?: Parameters<typeof stubClient>[1];
}) {
  const stub = stubClient(options.page ?? { items: [] }, options.stub ?? { write: {} });
  const registry = createRegistry(allTools, options.reachable ?? ALL);
  const ctx = createCallContext({
    limits: { ...resolveLimits(), ...options.limits },
    ...(options.allowWrites ? { allowWrites: options.allowWrites } : {}),
  });
  return { stub, ctx, dispatcher: createDispatcher(registry, stub.client) };
}

describe("dispatcher refusals", () => {
  it("names near matches for an operation that does not exist", async () => {
    const { ctx, dispatcher } = setup({});
    try {
      await assert.rejects(
        () => dispatcher.call("listAlert", {}, ctx),
        (error: unknown) => {
          assert.ok(error instanceof DispatchError);
          assert.equal(error.kind, "dispatch");
          assert.match(error.message, /Did you mean .*listAlerts/);
          assert.match(error.message, /jsm_search_api/);
          return true;
        },
      );
    } finally {
      ctx.deadline.dispose();
    }
  });

  it("tells the operator's story for an operation whose toolset is not loaded", async () => {
    // Not "no such operation": a model told that reports the server cannot do
    // it, which is the failure jsm_list_capabilities exists to prevent.
    const { ctx, dispatcher } = setup({ reachable: new Set(["jsm_list_alerts"]) });
    try {
      await assert.rejects(
        () => dispatcher.call("listSchedules", {}, ctx),
        (error: unknown) => {
          assert.ok(error instanceof DispatchError);
          assert.match(error.message, /not available/);
          assert.match(error.message, /JSM_TOOLSETS/);
          return true;
        },
      );
    } finally {
      ctx.deadline.dispose();
    }
  });

  it("refuses a write that was not in the allowlist, and says where writes go", async () => {
    const { stub, ctx, dispatcher } = setup({});
    try {
      await assert.rejects(
        () => dispatcher.call("acknowledgeAlert", { alert_id: "a" }, ctx),
        (error: unknown) => {
          assert.ok(error instanceof DispatchError);
          assert.match(error.message, /writes, and this call may only read/);
          assert.match(error.message, /jsm_apply/);
          return true;
        },
      );
      assert.equal(stub.calls.length, 0, "a refused write must not reach the network");
    } finally {
      ctx.deadline.dispose();
    }
  });

  it("says a destructive operation is destructive when refusing it", async () => {
    const { ctx, dispatcher } = setup({});
    try {
      await assert.rejects(
        () => dispatcher.call("deleteAlert", { alert_id: "a" }, ctx),
        /is destructive and writes/,
      );
    } finally {
      ctx.deadline.dispose();
    }
  });

  it("allows a write that was named in the allowlist", async () => {
    const { stub, ctx, dispatcher } = setup({ allowWrites: ["acknowledgeAlert"] });
    try {
      await dispatcher.call("acknowledgeAlert", { alert_id: "a1" }, ctx);
      assert.equal(stub.calls[0]?.path, "/v1/alerts/a1/acknowledge");
      // Partial application has to be reportable: a script that fails after
      // three of forty writes has applied three.
      assert.deepEqual(ctx.applied, [{ operation: "acknowledgeAlert", subject: "a1" }]);
    } finally {
      ctx.deadline.dispose();
    }
  });

  it("rejects bad arguments against the tool's own schema, and points at read_api", async () => {
    const { ctx, dispatcher } = setup({});
    try {
      await assert.rejects(
        () => dispatcher.call("listAlerts", { limit: 500 }, ctx),
        (error: unknown) => {
          assert.ok(error instanceof DispatchError);
          assert.match(error.message, /limit/);
          assert.match(error.message, /jsm_read_api/);
          return true;
        },
      );
    } finally {
      ctx.deadline.dispose();
    }
  });

  it("rejects an invented argument, because the schema is strict", async () => {
    const { ctx, dispatcher } = setup({});
    try {
      await assert.rejects(() => dispatcher.call("listAlerts", { nope: 1 }, ctx), DispatchError);
    } finally {
      ctx.deadline.dispose();
    }
  });
});

describe("dispatching a read", () => {
  it("returns the rows untruncated, not a rendered page", async () => {
    // The whole reason the code API does not reuse handlers: executeList
    // truncates its structured payload to whatever fit a 25,000-character
    // markdown render, which would cap a sweep at the model's reading budget.
    const items = Array.from({ length: 400 }, (_, index) => ({
      id: `a${index}`,
      message: "x".repeat(300),
    }));
    const { ctx, dispatcher } = setup({ page: { items, totalCount: 999 } });
    try {
      const page = (await dispatcher.call("listAlerts", { limit: 100 }, ctx)) as PageResult;
      assert.equal(page.items.length, 400);
      assert.equal(page.total, 999);
      assert.equal(ctx.budget.records, 400);
    } finally {
      ctx.deadline.dispose();
    }
  });

  it("reports the next offset for an offset-paged read", async () => {
    const { ctx, dispatcher } = setup({ page: { items: [{ id: "a" }, { id: "b" }] } });
    try {
      const page = (await dispatcher.call(
        "listAlerts",
        { limit: 2, offset: 10 },
        ctx,
      )) as PageResult;
      assert.equal(page.nextOffset, 12);
      assert.equal(page.nextCursor, undefined);
    } finally {
      ctx.deadline.dispose();
    }
  });

  it("reports a cursor for a cursor-paged read, and omits it when exhausted", async () => {
    const withCursor = setup({
      page: { items: [{ id: "n1" }], paging: { next: "https://x/notes?after=CURSOR1" } },
    });
    try {
      const page = (await withCursor.dispatcher.call(
        "listAlertNotes",
        { alert_id: "a" },
        withCursor.ctx,
      )) as PageResult;
      assert.equal(page.nextCursor, "CURSOR1");
    } finally {
      withCursor.ctx.deadline.dispose();
    }

    const exhausted = setup({ page: { items: [{ id: "n1" }] } });
    try {
      const page = (await exhausted.dispatcher.call(
        "listAlertNotes",
        { alert_id: "a" },
        exhausted.ctx,
      )) as PageResult;
      // Absent rather than undefined-valued: a key reads in a script as "there
      // is a next page and I lost it".
      assert.ok(!("nextCursor" in page), `got ${JSON.stringify(page)}`);
    } finally {
      exhausted.ctx.deadline.dispose();
    }
  });

  it("runs a composite through the budgeted client, so its calls are charged", async () => {
    // jsm_get_on_call resolves the schedule, asks /on-calls and the timeline,
    // then batches an identity lookup. None of those charge for themselves —
    // the wrapped client does, which is the point of wrapping it.
    const { stub, ctx, dispatcher } = setup({
      page: { items: [] },
      stub: { routes: [{ match: "/on-calls", one: { onCallParticipants: [] } }] },
    });
    try {
      await dispatcher.call("getOnCall", { schedule_id: "s1" }, ctx);
      assert.ok(ctx.budget.requests >= 2, `charged only ${ctx.budget.requests}`);
      assert.ok(stub.calls.length >= 2);
    } finally {
      ctx.deadline.dispose();
    }
  });

  it("returns a confirmation for a 204, not undefined", async () => {
    const { ctx, dispatcher } = setup({ allowWrites: ["deleteSchedule"] });
    try {
      const result = await dispatcher.call("deleteSchedule", { schedule_id: "s1" }, ctx);
      assert.deepEqual(result, { ok: true });
    } finally {
      ctx.deadline.dispose();
    }
  });
});

describe("dispatcher error handling", () => {
  it("wraps an API failure with the prose a classic tool would have returned", async () => {
    const { ctx, dispatcher } = setup({
      stub: { routes: [{ match: "/v1/alerts", error: httpError(404) }] },
    });
    try {
      await assert.rejects(
        () => dispatcher.call("getAlert", { identifier: "nope" }, ctx),
        (error: unknown) => {
          assert.ok(error instanceof OperationError);
          assert.equal(error.kind, "operation");
          assert.equal(error.operation, "getAlert");
          assert.equal(error.status, 404);
          assert.equal(error.retryable, false);
          // handleApiError's own advice, not a second vocabulary beside it.
          assert.match(error.message, /tinyId|jsm_list_alerts/);
          return true;
        },
      );
    } finally {
      ctx.deadline.dispose();
    }
  });

  it("marks a 429 and a 5xx retryable, so a script can decide", async () => {
    for (const [status, retryable] of [
      [429, true],
      [503, true],
      [422, false],
    ] as const) {
      const { ctx, dispatcher } = setup({
        stub: { routes: [{ match: "/v1/schedules", error: httpError(status) }] },
      });
      try {
        await assert.rejects(
          () => dispatcher.call("listSchedules", {}, ctx),
          (error: unknown) => {
            assert.ok(error instanceof OperationError);
            assert.equal(error.retryable, retryable, `status ${status}`);
            return true;
          },
        );
      } finally {
        ctx.deadline.dispose();
      }
    }
  });

  it("lets a budget error through as a budget error, not as an API error", async () => {
    // The two have opposite fixes. Reporting a spent budget as an operation
    // failure sends the model to re-read the API's advice about a request it
    // never made.
    const { ctx, dispatcher } = setup({ limits: { maxRequests: 1 } });
    try {
      await dispatcher.call("listSchedules", {}, ctx);
      await assert.rejects(() => dispatcher.call("listSchedules", {}, ctx), BudgetError);
    } finally {
      ctx.deadline.dispose();
    }
  });
});

describe("callAll", () => {
  it("refuses an endpoint that cannot serve a later page", async () => {
    // GET /v1/teams accepts no paging parameters, so a full-looking first page
    // would make a naive pager loop on the same rows forever.
    const { ctx, dispatcher } = setup({});
    try {
      await assert.rejects(
        () => dispatcher.callAll("listTeams", {}, ctx),
        (error: unknown) => {
          assert.ok(error instanceof DispatchError);
          assert.match(error.message, /cannot be paged/);
          assert.match(error.message, /listTeams instead/);
          return true;
        },
      );
    } finally {
      ctx.deadline.dispose();
    }
  });

  it("walks offset pages until a short page ends it", async () => {
    let served = 0;
    const stub = stubClient({ items: [] });
    // Three full pages of 2, then a short one.
    const pages = [[{ id: 1 }, { id: 2 }], [{ id: 3 }, { id: 4 }], [{ id: 5 }]];
    const client = {
      getCollection: async () => ({
        items: pages[served++] ?? [],
        paging: undefined,
        totalCount: undefined,
      }),
    } as unknown as typeof stub.client;

    const registry = createRegistry(allTools, ALL);
    const ctx = createCallContext({ limits: resolveLimits() });
    try {
      const result = await createDispatcher(registry, client).callAll(
        "listAlerts",
        { limit: 2 },
        ctx,
      );
      assert.equal(result.pages, 3);
      assert.equal(result.items.length, 5);
      assert.equal(result.complete, true);
      assert.equal(result.stoppedBecause, undefined);
    } finally {
      ctx.deadline.dispose();
    }
  });

  it("stops at the record ceiling and says so rather than reading short in silence", async () => {
    const client = {
      getCollection: async () => ({
        items: Array.from({ length: 100 }, (_, i) => ({ id: i })),
        paging: undefined,
        totalCount: undefined,
      }),
    } as unknown as ReturnType<typeof stubClient>["client"];

    const ctx = createCallContext({ limits: resolveLimits() });
    try {
      const result = await createDispatcher(createRegistry(allTools, ALL), client).callAll(
        "listAlerts",
        { limit: 100 },
        ctx,
        250,
      );
      assert.equal(result.items.length, 250);
      assert.equal(result.complete, false);
      assert.match(result.stoppedBecause ?? "", /250-record ceiling/);
    } finally {
      ctx.deadline.dispose();
    }
  });

  it("keeps the pages it read when a budget runs out mid-sweep", async () => {
    // Losing sixty requests' worth of work to an exception is worse than
    // returning what was gathered and saying it is partial.
    const client = {
      getCollection: async () => ({
        items: Array.from({ length: 10 }, (_, i) => ({ id: i })),
        paging: undefined,
        totalCount: undefined,
      }),
    } as unknown as ReturnType<typeof stubClient>["client"];

    const ctx = createCallContext({ limits: { ...resolveLimits(), maxRequests: 3 } });
    try {
      const result: AllPagesResult = await createDispatcher(
        createRegistry(allTools, ALL),
        client,
      ).callAll("listAlerts", { limit: 10 }, ctx);

      assert.equal(result.pages, 3);
      assert.equal(result.items.length, 30);
      assert.equal(result.complete, false);
      assert.match(result.stoppedBecause ?? "", /HTTP requests/);
    } finally {
      ctx.deadline.dispose();
    }
  });

  it("follows a cursor and stops when the link runs out", async () => {
    let served = 0;
    const client = {
      getCollection: async () => {
        served += 1;
        return {
          items: [{ id: served }],
          paging: served < 3 ? { next: `https://x?after=C${served}` } : undefined,
          totalCount: undefined,
        };
      },
    } as unknown as ReturnType<typeof stubClient>["client"];

    const ctx = createCallContext({ limits: resolveLimits() });
    try {
      const result = await createDispatcher(createRegistry(allTools, ALL), client).callAll(
        "listAlertNotes",
        { alert_id: "a" },
        ctx,
      );
      assert.equal(result.pages, 3);
      assert.equal(result.complete, true);
    } finally {
      ctx.deadline.dispose();
    }
  });

  it("stops at the page limit", async () => {
    const client = {
      getCollection: async () => ({
        items: [{ id: 1 }, { id: 2 }],
        paging: undefined,
        totalCount: undefined,
      }),
    } as unknown as ReturnType<typeof stubClient>["client"];

    const ctx = createCallContext({
      limits: { ...resolveLimits(), maxPages: 2, maxRequests: 100, maxRecords: 100_000 },
    });
    try {
      const result = await createDispatcher(createRegistry(allTools, ALL), client).callAll(
        "listAlerts",
        { limit: 2 },
        ctx,
      );
      assert.equal(result.pages, 2);
      assert.equal(result.complete, false);
      assert.match(result.stoppedBecause ?? "", /2-page limit/);
    } finally {
      ctx.deadline.dispose();
    }
  });
});

describe("sweeps: the bugs a review found", () => {
  const registry = createRegistry(allTools, ALL);
  type Client = ReturnType<typeof stubClient>["client"];
  const page = (count: number, extra: Record<string, unknown> = {}) => ({
    items: Array.from({ length: count }, (_, index) => ({ index })),
    paging: undefined,
    totalCount: undefined,
    ...extra,
  });

  it("does not call a clamped page the end of the collection", async () => {
    // Asked for 100, the endpoint serves 50 at a time, 250 exist. Treating a
    // short page as the end reported 50 records with complete: true.
    let served = 0;
    const client = {
      getCollection: async () => (served++ < 5 ? page(50) : page(0)),
    } as unknown as Client;
    const ctx = createCallContext({ limits: resolveLimits() });
    try {
      const result = await createDispatcher(registry, client).callAll(
        "listAlerts",
        { limit: 100 },
        ctx,
      );
      assert.equal(result.items.length, 250);
      assert.equal(result.complete, true);
      assert.equal(result.pages, 5, "the empty page that ended it is not a page of results");
    } finally {
      ctx.deadline.dispose();
    }
  });

  it("stops at the reported total without paying for an empty page", async () => {
    let requests = 0;
    const client = {
      getCollection: async () => {
        requests += 1;
        return page(50, { totalCount: 100 });
      },
    } as unknown as Client;
    const ctx = createCallContext({ limits: resolveLimits() });
    try {
      const result = await createDispatcher(registry, client).callAll(
        "listAlerts",
        { limit: 50 },
        ctx,
      );
      assert.equal(result.items.length, 100);
      assert.equal(result.complete, true);
      assert.equal(requests, 2);
    } finally {
      ctx.deadline.dispose();
    }
  });

  it("sweeps at the largest page size unless the caller chose one", async () => {
    // Inheriting the default of 20 spent fifty requests on a thousand records.
    const sizes: unknown[] = [];
    const client = {
      getCollection: async (_path: string, params?: Record<string, unknown>) => {
        sizes.push(params?.size);
        return page(0);
      },
    } as unknown as Client;

    for (const [args, expected] of [
      [{}, 100],
      [{ limit: 30 }, 30],
    ] as const) {
      const ctx = createCallContext({ limits: resolveLimits() });
      try {
        await createDispatcher(registry, client).callAll("listAlerts", args, ctx);
        assert.equal(sizes.at(-1), expected, `args ${JSON.stringify(args)}`);
      } finally {
        ctx.deadline.dispose();
      }
    }
  });

  it("refuses a nonsensical max instead of throwing a RangeError", async () => {
    const client = { getCollection: async () => page(2) } as unknown as Client;
    for (const max of [-5, 0, 1.5, Number.NaN]) {
      const ctx = createCallContext({ limits: resolveLimits() });
      try {
        await assert.rejects(
          () => createDispatcher(registry, client).callAll("listAlerts", {}, ctx, max),
          (error: unknown) => {
            assert.ok(error instanceof DispatchError, `max=${max} threw ${String(error)}`);
            assert.match(error.message, /'max' must be a whole number/);
            return true;
          },
        );
      } finally {
        ctx.deadline.dispose();
      }
    }
  });

  it("returns what it read when the API fails part-way through", async () => {
    let served = 0;
    const client = {
      getCollection: async () => {
        if (served++ < 2) return page(10);
        throw httpError(503);
      },
    } as unknown as Client;
    const ctx = createCallContext({ limits: resolveLimits() });
    try {
      const result = await createDispatcher(registry, client).callAll(
        "listAlerts",
        { limit: 10 },
        ctx,
      );
      assert.equal(result.items.length, 20);
      assert.equal(result.complete, false);
      assert.match(result.stoppedBecause ?? "", /listAlerts/);
    } finally {
      ctx.deadline.dispose();
    }
  });

  it("still throws when the very first page fails, having gathered nothing", async () => {
    const client = {
      getCollection: async () => {
        throw httpError(403);
      },
    } as unknown as Client;
    const ctx = createCallContext({ limits: resolveLimits() });
    try {
      await assert.rejects(
        () => createDispatcher(registry, client).callAll("listAlerts", {}, ctx),
        OperationError,
      );
    } finally {
      ctx.deadline.dispose();
    }
  });
});

describe("dispatcher: the smaller findings", () => {
  const registry = createRegistry(allTools, ALL);

  it("reports a request cancelled by the deadline as a budget, not a network fault", async () => {
    // It used to read "could not reach api.atlassian.com (ERR_CANCELED). Check
    // network access and any proxy settings".
    let now = 0;
    const ctx = createCallContext({ limits: resolveLimits(), now: () => now });
    const client = {
      getCollection: async () => {
        now = 999_999;
        throw Object.assign(new Error("canceled"), { isAxiosError: true, code: "ERR_CANCELED" });
      },
    } as unknown as ReturnType<typeof stubClient>["client"];
    try {
      await assert.rejects(
        () => createDispatcher(registry, client).call("listAlerts", {}, ctx),
        (error: unknown) => {
          assert.ok(error instanceof BudgetError, `got ${String(error)}`);
          assert.equal(error.budget, "timeoutMs");
          assert.doesNotMatch(error.message, /proxy/);
          return true;
        },
      );
    } finally {
      ctx.deadline.dispose();
    }
  });

  it("does not point at jsm_apply on a server that has withheld it", async () => {
    const stub = stubClient({ items: [] });
    const ctx = createCallContext({ limits: resolveLimits() });
    try {
      await assert.rejects(
        () =>
          createDispatcher(registry, stub.client, { writesAvailable: false }).call(
            "acknowledgeAlert",
            { alert_id: "a" },
            ctx,
          ),
        (error: unknown) => {
          assert.ok(error instanceof DispatchError);
          assert.match(error.message, /read-only/);
          assert.doesNotMatch(error.message, /jsm_apply/);
          return true;
        },
      );
    } finally {
      ctx.deadline.dispose();
    }
  });
});
