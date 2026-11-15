import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { JsmClient } from "../../services/client.js";
import { stubClient } from "../test-support.js";
import { BUDGETED_METHODS, budgetedClient } from "./budgeted-client.js";
import { BudgetError, createCallContext } from "./context.js";
import { resolveLimits } from "./limits.js";

const context = (overrides: Partial<ReturnType<typeof resolveLimits>> = {}) =>
  createCallContext({ limits: { ...resolveLimits(), ...overrides } });

describe("budgetedClient", () => {
  it("wraps every public method JsmClient has", () => {
    // The guarantee is "a request that is not charged is a request that was not
    // made". A method added to JsmClient and not wrapped here would break it
    // silently, so the check is mechanical rather than a convention.
    const actual = Object.getOwnPropertyNames(JsmClient.prototype)
      .filter((name) => name !== "constructor")
      .sort();
    assert.deepEqual(actual, [...BUDGETED_METHODS].sort());
  });

  it("charges exactly once per public call, not once per layer", async () => {
    // getCollection calls request internally. A wrapper that re-entered itself
    // would charge twice and halve every operator's budget.
    const ctx = context();
    try {
      const stub = stubClient({ items: [{ id: "a" }] });
      const client = budgetedClient(stub.client, ctx);

      await client.getCollection("/v1/alerts", { size: 20 });
      assert.equal(ctx.budget.requests, 1);

      await client.getOne("/v1/alerts/1");
      assert.equal(ctx.budget.requests, 2);
    } finally {
      ctx.deadline.dispose();
    }
  });

  it("refuses the request that would exceed the budget, before issuing it", async () => {
    const ctx = context({ maxRequests: 2 });
    try {
      const stub = stubClient({ items: [] });
      const client = budgetedClient(stub.client, ctx);

      await client.getOne("/v1/alerts/1");
      await client.getOne("/v1/alerts/2");
      await assert.rejects(() => client.getOne("/v1/alerts/3"), BudgetError);

      // The refused call must not have reached the network.
      assert.deepEqual(
        stub.calls.map((call) => call.path),
        ["/v1/alerts/1", "/v1/alerts/2"],
      );
    } finally {
      ctx.deadline.dispose();
    }
  });

  it("reports an expired deadline as a deadline, not as a spent request budget", async () => {
    // Checked before charging, so the error names the thing that actually ran
    // out. Getting this backwards sends the model to lower its page size when
    // the real problem is that the work does not fit in the time.
    let now = 0;
    const ctx = createCallContext({ limits: resolveLimits(), now: () => now });
    try {
      now = 999_999;
      const stub = stubClient({ items: [] });
      const client = budgetedClient(stub.client, ctx);

      await assert.rejects(
        () => client.getOne("/v1/alerts/1"),
        (error: unknown) => {
          assert.ok(error instanceof BudgetError);
          assert.equal(error.budget, "timeoutMs");
          return true;
        },
      );
      assert.equal(ctx.budget.requests, 0, "a deadline failure must not spend the request budget");
      assert.equal(stub.calls.length, 0);
    } finally {
      ctx.deadline.dispose();
    }
  });

  it("passes the deadline signal down, so a slow request cannot outlive the call", async () => {
    const ctx = context();
    try {
      const stub = stubClient({ items: [] });
      const client = budgetedClient(stub.client, ctx);
      await client.request("POST", "/v1/alerts", { body: { message: "x" } });

      // stubClient records what the tool passed through; the signal reaching
      // the real axios config is what makes REQUEST_TIMEOUT_MS stop being the
      // effective ceiling.
      assert.equal(stub.calls.length, 1);
      assert.equal(stub.calls[0]?.method, "POST");
    } finally {
      ctx.deadline.dispose();
    }
  });

  it("keeps a caller's own signal rather than overriding it", async () => {
    const ctx = context();
    const own = new AbortController();
    try {
      const seen: Array<AbortSignal | undefined> = [];
      const stub = stubClient({ items: [] });
      const spy = {
        ...stub.client,
        getOne: async (
          _p: string,
          _params?: Record<string, unknown>,
          options?: { signal?: AbortSignal },
        ) => {
          seen.push(options?.signal);
          return {};
        },
      } as unknown as JsmClient;

      await budgetedClient(spy, ctx).getOne("/v1/alerts/1", undefined, { signal: own.signal });
      assert.equal(seen[0], own.signal);
    } finally {
      ctx.deadline.dispose();
    }
  });

  it("never runs more concurrent requests than the inflight budget allows", async () => {
    const ctx = context({ maxInflight: 2, maxRequests: 20 });
    try {
      let active = 0;
      let peak = 0;
      const slow = {
        getOne: async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return {};
        },
      } as unknown as JsmClient;

      const client = budgetedClient(slow, ctx);
      await Promise.all(Array.from({ length: 10 }, (_, i) => client.getOne(`/v1/alerts/${i}`)));

      // handleApiError has a 429 branch, which is evidence the API throttles.
      // This is what keeps a script's Promise.all from being the thing that
      // trips it.
      assert.equal(peak, 2, `peak concurrency was ${peak}`);
    } finally {
      ctx.deadline.dispose();
    }
  });
});
