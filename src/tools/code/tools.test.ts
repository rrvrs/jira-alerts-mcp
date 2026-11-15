/**
 * The four dispatchers, driven the way a client drives them.
 *
 * Through connectTools, so argument parsing and output-schema validation run —
 * the path that catches the class of bug catalogue.test.ts's header describes,
 * where a handler returns something sensible and the SDK rejects it.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { allTools } from "../../server.js";
import { callTool, connectTools, stubClient, textOf } from "../test-support.js";
import { sandboxSupport } from "./child-engine.js";
import type { ScriptEngine } from "./engine.js";
import { createCodeMode } from "./index.js";
import { resolveLimits } from "./limits.js";

const ALL = new Set(allTools.map((tool) => tool.name));

/**
 * An engine that runs nothing. Injected so the registered tool list is the
 * same on every runtime these tests run on: without it jsm_run is present on
 * Node 26 and absent on Node 24, and half the assertions below would depend on
 * which one CI picked.
 */
const inertEngine: ScriptEngine = {
  run: async () => ({ logs: [], truncated: false }),
  dispose: async () => {},
};

const SANDBOX_UNSUPPORTED = sandboxSupport().supported
  ? false
  : "needs Node 25+: the permission model does not gate the network before that";

function mode(
  options: {
    reachable?: Set<string>;
    destructive?: boolean;
    readOnly?: boolean;
    /** "real" runs scripts in the actual sandbox; the default runs nothing. */
    engine?: "real";
    sandbox?: { supported: boolean; reason?: string };
    page?: Parameters<typeof stubClient>[0];
    stub?: Parameters<typeof stubClient>[1];
  } = {},
) {
  const stub = stubClient(options.page ?? { items: [] }, options.stub ?? { write: {} });
  const built = createCodeMode({
    catalogue: allTools,
    reachable: options.reachable ?? ALL,
    client: stub.client,
    limits: resolveLimits(),
    permissions: { destructive: options.destructive ?? false },
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
    ...(options.engine === "real" ? {} : { engine: inertEngine }),
    ...(options.sandbox ? { sandbox: options.sandbox } : {}),
  });
  return { stub, ...built };
}

async function connect(options: Parameters<typeof mode>[0] = {}) {
  const built = mode(options);
  const mcp = await connectTools(built.tools, built.stub.client);
  return { ...built, mcp };
}

describe("the code-mode tool list", () => {
  it("is five tools, and only four of them when read-only", () => {
    assert.deepEqual(
      mode().tools.map((tool) => tool.name),
      ["jsm_search_api", "jsm_read_api", "jsm_call", "jsm_run", "jsm_apply"],
    );
    // Same split JSM_READ_ONLY makes for the classic tools: the write
    // dispatcher goes, the read ones stay — jsm_run included, because it
    // cannot write at all.
    assert.deepEqual(
      mode({ readOnly: true }).tools.map((tool) => tool.name),
      ["jsm_search_api", "jsm_read_api", "jsm_call", "jsm_run"],
    );
  });

  it("writes descriptions in the house style", () => {
    // The same rule catalogue.test.ts applies to the catalogue. It matters more
    // here: these four descriptions do the work ninety-four used to.
    for (const tool of mode().tools) {
      assert.ok(tool.description.length > 80, `${tool.name}: description is too thin`);
      assert.match(tool.description, /Args:/, `${tool.name}: no Args: block`);
      assert.match(tool.description, /Returns/, `${tool.name}: does not say what it returns`);
      assert.match(tool.description, /Examples:/, `${tool.name}: no Examples: block`);
    }
  });

  it("annotates the read dispatchers read-only and jsm_apply destructive", () => {
    // The whole approval story rests on this being honest.
    const tools = new Map(mode().tools.map((tool) => [tool.name, tool]));
    assert.equal(tools.get("jsm_call")?.annotations.readOnlyHint, true);
    assert.equal(tools.get("jsm_call")?.annotations.destructiveHint, false);
    assert.equal(tools.get("jsm_run")?.annotations.readOnlyHint, true);
    assert.equal(tools.get("jsm_run")?.annotations.destructiveHint, false);
    assert.equal(tools.get("jsm_apply")?.annotations.readOnlyHint, false);
    assert.equal(tools.get("jsm_apply")?.annotations.destructiveHint, true);
  });

  it("registers over a real MCP connection with strict input schemas", async () => {
    const { mcp } = await connect();
    try {
      const listed = await mcp.listTools();
      assert.equal(listed.tools.length, 5);
      for (const tool of listed.tools) {
        assert.ok(tool.outputSchema, `${tool.name}: no output schema survived`);
        assert.equal(
          (tool.inputSchema as { additionalProperties?: boolean }).additionalProperties,
          false,
          `${tool.name}: lost additionalProperties:false`,
        );
      }
    } finally {
      await mcp.close();
    }
  });
});

describe("jsm_search_api", () => {
  it("finds an operation and names it as jsm_call would take it", async () => {
    const { mcp } = await connect();
    try {
      const result = await callTool(mcp, "jsm_search_api", { query: "on call" });
      assert.match(textOf(result), /getOnCall/);
      const payload = result.structuredContent as { operations: Array<{ operation: string }> };
      assert.ok(payload.operations.some((entry) => entry.operation === "getOnCall"));
    } finally {
      await mcp.close();
    }
  });

  it("reports an unloaded family as unavailable, with how to load it", async () => {
    // Not as absent: a model told nothing exists reports that the server cannot
    // do it, which is the wrong answer and the one this flag prevents.
    const { mcp } = await connect({ reachable: new Set(["jsm_list_alerts"]) });
    try {
      const result = await callTool(mcp, "jsm_search_api", { query: "routing" });
      assert.match(textOf(result), /NOT AVAILABLE HERE/);
      assert.match(textOf(result), /JSM_TOOLSETS/);
    } finally {
      await mcp.close();
    }
  });

  it("serves three detail levels, cheapest first", async () => {
    const { mcp } = await connect();
    try {
      const names = await callTool(mcp, "jsm_search_api", { detail: "names", limit: 100 });
      const summaries = await callTool(mcp, "jsm_search_api", { detail: "summaries", limit: 100 });
      const signatures = await callTool(mcp, "jsm_search_api", {
        detail: "signatures",
        limit: 100,
      });

      assert.ok(textOf(names).length < textOf(summaries).length);
      assert.ok(textOf(summaries).length < textOf(signatures).length);
      assert.match(textOf(signatures), /```ts/);
    } finally {
      await mcp.close();
    }
  });

  it("says plainly when nothing matched", async () => {
    const { mcp } = await connect();
    try {
      const result = await callTool(mcp, "jsm_search_api", { query: "zzzznotathing" });
      assert.match(textOf(result), /Nothing matched/);
    } finally {
      await mcp.close();
    }
  });
});

describe("jsm_read_api", () => {
  it("returns the operation's own description, verbatim", async () => {
    // Verbatim is the point. The descriptions carry what the spec does not say,
    // and rewriting them is how that knowledge stops being written.
    const { mcp } = await connect();
    try {
      const result = await callTool(mcp, "jsm_read_api", { operations: ["listAlerts"] });
      const original = allTools.find((tool) => tool.name === "jsm_list_alerts")?.description ?? "";
      assert.ok(textOf(result).includes(original), "the description was not reproduced in full");
      assert.match(textOf(result), /listAlerts\(args: \{/);
    } finally {
      await mcp.close();
    }
  });

  it("accepts a tool name as readily as a code name", async () => {
    const { mcp } = await connect();
    try {
      const result = await callTool(mcp, "jsm_read_api", { operations: ["jsm_list_alerts"] });
      assert.match(textOf(result), /## listAlerts/);
    } finally {
      await mcp.close();
    }
  });

  it("answers for the names it knows and lists the ones it does not", async () => {
    // Failing the whole call over one misspelling would waste the other four.
    const { mcp } = await connect();
    try {
      const result = await callTool(mcp, "jsm_read_api", {
        operations: ["listAlerts", "nonsense"],
      });
      assert.match(textOf(result), /## listAlerts/);
      assert.match(textOf(result), /No operation named `nonsense`/);
      const payload = result.structuredContent as { unknown: string[] };
      assert.deepEqual(payload.unknown, ["nonsense"]);
    } finally {
      await mcp.close();
    }
  });
});

describe("jsm_call", () => {
  it("returns the API's data for a read", async () => {
    const { mcp, stub } = await connect({ page: { items: [{ id: "a1", message: "disk full" }] } });
    try {
      const result = await callTool(mcp, "jsm_call", {
        operation: "listAlerts",
        args: { query: "status:open" },
      });
      assert.match(textOf(result), /disk full/);
      assert.equal(stub.calls[0]?.path, "/v1/alerts");
      assert.equal(stub.calls[0]?.params?.query, "status:open");
    } finally {
      await mcp.close();
    }
  });

  it("refuses a write and points at jsm_apply", async () => {
    const { mcp, stub } = await connect();
    try {
      const result = await callTool(mcp, "jsm_call", {
        operation: "acknowledgeAlert",
        args: { alert_id: "a1" },
      });
      assert.equal(result.isError, true);
      assert.match(textOf(result), /jsm_apply/);
      assert.equal(stub.calls.length, 0, "a refused write must not reach the network");
    } finally {
      await mcp.close();
    }
  });

  it("embeds the operation index, so the common case needs no lookup", () => {
    const call = mode().tools.find((tool) => tool.name === "jsm_call");
    assert.ok(call);
    assert.match(call.description, /listAlerts/);
    assert.match(call.description, /getOnCall/);
  });

  it("trims a large result to the response limit and says it did", async () => {
    // Until a sandbox exists the reader of these rows is the model, so
    // something has to keep a sweep from becoming megabytes of context.
    const items = Array.from({ length: 2_000 }, (_, index) => ({
      id: `a${index}`,
      message: "x".repeat(200),
    }));
    const { mcp } = await connect({ page: { items } });
    try {
      const result = await callTool(mcp, "jsm_call", {
        operation: "listAlerts",
        args: { limit: 100 },
      });
      assert.match(textOf(result), /Trimmed to fit/);
      assert.ok(textOf(result).length < 30_000, `response was ${textOf(result).length} chars`);

      // The structured payload is trimmed with the text. It used not to be:
      // the text came back at 17,000 characters beside 64,000 of structured
      // content, and many clients hand the model both.
      const payload = result.structuredContent as { truncated: boolean };
      assert.equal(payload.truncated, true);
      const structuredSize = JSON.stringify(result.structuredContent).length;
      assert.ok(structuredSize < 30_000, `structuredContent was ${structuredSize} chars`);
    } finally {
      await mcp.close();
    }
  });

  it("reports an exact count under all_pages even when the sample is trimmed", async () => {
    const { mcp } = await connect({
      page: { items: Array.from({ length: 40 }, (_, i) => ({ id: i, pad: "y".repeat(800) })) },
    });
    try {
      const result = await callTool(mcp, "jsm_call", {
        operation: "listAlerts",
        args: { limit: 40 },
        all_pages: true,
        max_records: 120,
      });
      const payload = result.structuredContent as { count: number; complete: boolean };
      assert.equal(payload.count, 120);
      assert.equal(payload.complete, false);

      // The count has to be in what the model reads, not only beside it. The
      // text used to say "'count' above is exact" with no count above.
      assert.match(textOf(result), /"count": 120/);
      assert.match(textOf(result), /"complete": false/);

      // And a sweep's structured content is a sample, not the sweep: this was
      // 3.2 MB for five thousand records.
      const structuredSize = JSON.stringify(result.structuredContent).length;
      assert.ok(structuredSize < 30_000, `structuredContent was ${structuredSize} chars`);
    } finally {
      await mcp.close();
    }
  });

  it("reports a bad operation name as a dispatch error, with a suggestion", async () => {
    const { mcp } = await connect();
    try {
      const result = await callTool(mcp, "jsm_call", { operation: "listAlert" });
      assert.equal(result.isError, true);
      assert.match(textOf(result), /Error \(dispatch\)/);
      assert.match(textOf(result), /listAlerts/);
      // The invocation id is how a user's "it failed" reaches a log line.
      assert.match(textOf(result), /Invocation [0-9a-f-]{8}/);
    } finally {
      await mcp.close();
    }
  });
});

describe("jsm_apply", () => {
  it("runs a write and reports the receipt", async () => {
    const { mcp, stub } = await connect({ stub: { write: { result: "ok", requestId: "r1" } } });
    try {
      const result = await callTool(mcp, "jsm_apply", {
        operation: "acknowledgeAlert",
        args: { alert_id: "a1" },
      });
      assert.equal(result.isError, undefined);
      assert.match(textOf(result), /r1/);
      assert.equal(stub.calls[0]?.path, "/v1/alerts/a1/acknowledge");
      assert.equal(stub.calls[0]?.method, "POST");
    } finally {
      await mcp.close();
    }
  });

  it("sends a read back to jsm_call rather than asking for a write approval", async () => {
    const { mcp } = await connect();
    try {
      const result = await callTool(mcp, "jsm_apply", { operation: "listAlerts" });
      assert.equal(result.isError, true);
      assert.match(textOf(result), /belongs in jsm_call/);
    } finally {
      await mcp.close();
    }
  });

  it("refuses a destructive operation unless the operator enabled it", async () => {
    const { mcp, stub } = await connect();
    try {
      const result = await callTool(mcp, "jsm_apply", {
        operation: "deleteSchedule",
        args: { schedule_id: "s1" },
      });
      assert.equal(result.isError, true);
      assert.match(textOf(result), /JSM_CODE_DESTRUCTIVE/);
      // Offers the alternative that keeps a per-tool approval, rather than only
      // telling the user to disable a safeguard.
      assert.match(textOf(result), /JSM_TOOLSETS=code,schedules/);
      assert.equal(stub.calls.length, 0);
    } finally {
      await mcp.close();
    }
  });

  it("allows a destructive operation when the operator enabled it", async () => {
    const { mcp, stub } = await connect({ destructive: true });
    try {
      const result = await callTool(mcp, "jsm_apply", {
        operation: "deleteSchedule",
        args: { schedule_id: "s1" },
      });
      assert.equal(result.isError, undefined);
      assert.equal(stub.calls[0]?.method, "DELETE");
    } finally {
      await mcp.close();
    }
  });

  it("says in its own description which way the destructive switch is set", () => {
    // A model that cannot tell will either promise a delete it cannot do or
    // refuse one it can.
    const off = mode().tools.find((tool) => tool.name === "jsm_apply");
    const on = mode({ destructive: true }).tools.find((tool) => tool.name === "jsm_apply");
    assert.match(off?.description ?? "", /DISABLED on this install/);
    assert.match(on?.description ?? "", /ENABLED on this install/);
  });
});

describe("discovery tools stay inside the response limit", () => {
  it("fits jsm_search_api's widest answer", async () => {
    // detail=signatures with limit=100 returned 60,000 characters of text and
    // 74,000 of structured content — from the tool whose whole job is keeping
    // definitions out of the context window.
    const { mcp } = await connect();
    try {
      const result = await callTool(mcp, "jsm_search_api", { detail: "signatures", limit: 100 });
      assert.ok(textOf(result).length < 27_000, `text was ${textOf(result).length} chars`);
      const structuredSize = JSON.stringify(result.structuredContent).length;
      assert.ok(structuredSize < 30_000, `structuredContent was ${structuredSize} chars`);
      assert.match(textOf(result), /Trimmed to fit/);
      // What was dropped is still findable: the total is reported.
      const payload = result.structuredContent as { matched: number; operations: unknown[] };
      assert.equal(payload.matched, allTools.length);
      assert.ok(payload.operations.length < allTools.length);
    } finally {
      await mcp.close();
    }
  });

  it("fits jsm_read_api by dropping whole operations, never by shortening one", async () => {
    const names = [
      "listAlerts",
      "getAlert",
      "createAlert",
      "getOnCall",
      "getNextOnCall",
      "getScheduleTimeline",
      "createSchedule",
      "createRotation",
      "createEscalation",
      "createNotificationRule",
    ];
    const { mcp } = await connect();
    try {
      const result = await callTool(mcp, "jsm_read_api", { operations: names });
      assert.ok(textOf(result).length < 27_000, `text was ${textOf(result).length} chars`);

      const payload = result.structuredContent as {
        operations: Array<{ operation: string; documentation: string }>;
        not_shown?: string[];
      };
      // Everything asked for is either documented in full or named as dropped.
      assert.equal(payload.operations.length + (payload.not_shown?.length ?? 0), names.length);
      for (const entry of payload.operations) {
        const original = allTools.find((tool) => tool.description === entry.documentation);
        assert.ok(original, `${entry.operation}: its description was altered`);
      }
    } finally {
      await mcp.close();
    }
  });
});

describe("jsm_run", () => {
  it("is not registered where its sandbox cannot be trusted, and says why", () => {
    // Node 24's permission model does not gate the network. A tool that is
    // listed and refuses every call is worse than one that is absent and
    // explained: the model plans around a capability it does not have.
    const reason = "jsm_run needs Node 25 or later";
    const built = mode({ sandbox: { supported: false, reason } });
    assert.ok(!built.tools.some((tool) => tool.name === "jsm_run"));
    assert.deepEqual(built.sandbox, { supported: false, reason });
    // The others are untouched.
    assert.ok(built.tools.some((tool) => tool.name === "jsm_call"));
  });

  it("reads many records and returns what the script logged", {
    skip: SANDBOX_UNSUPPORTED,
  }, async () => {
    const items = Array.from({ length: 100 }, (_, index) => ({
      id: `s${index}`,
      name: `sched-${index}`,
      enabled: index % 10 !== 0,
    }));
    const { mcp } = await connect({ engine: "real", page: { items, totalCount: 100 } });
    try {
      const result = await callTool(mcp, "jsm_run", {
        script: `
          const all = await jsm.listAllSchedules({});
          const off = all.items.filter(s => s.enabled === false);
          console.log(off.length + ' of ' + all.items.length + ' schedules are disabled');
        `,
      });
      assert.equal(result.isError, undefined);
      assert.equal(textOf(result), "10 of 100 schedules are disabled");
      const payload = result.structuredContent as { requests: number; operations: string[] };
      assert.deepEqual(payload.operations, ["listSchedules"]);
      assert.equal(payload.requests, 1);
    } finally {
      await mcp.close();
    }
  });

  it("refuses a write from inside a script and names it as a refusal", {
    skip: SANDBOX_UNSUPPORTED,
  }, async () => {
    const { mcp, stub } = await connect({ engine: "real" });
    try {
      const result = await callTool(mcp, "jsm_run", {
        script: `await jsm.deleteAlert({ alert_id: 'a1' }); console.log('deleted');`,
      });
      assert.equal(result.isError, true);
      assert.match(textOf(result), /Error \(dispatch\)/);
      assert.doesNotMatch(textOf(result), /^deleted$/m);
      assert.equal(stub.calls.length, 0, "a refused write must not reach the network");
    } finally {
      await mcp.close();
    }
  });

  it("never returns more than the response limit, whatever the script logs", {
    skip: SANDBOX_UNSUPPORTED,
  }, async () => {
    // One line of JSON.stringify over a sweep came back as 1.9 MB.
    const items = Array.from({ length: 100 }, (_, index) => ({ id: index, pad: "p".repeat(400) }));
    const { mcp } = await connect({ engine: "real", page: { items } });
    try {
      const result = await callTool(mcp, "jsm_run", {
        script: `
          const all = await jsm.listAllAlerts({}, { max: 2000 });
          console.log(JSON.stringify(all.items));
          for (let i = 0; i < 400; i++) console.log('line ' + i + ' ' + 'x'.repeat(200));
        `,
      });
      assert.ok(textOf(result).length < 27_000, `text was ${textOf(result).length} chars`);
      const structuredSize = JSON.stringify(result.structuredContent).length;
      assert.ok(structuredSize < 30_000, `structuredContent was ${structuredSize} chars`);
    } finally {
      await mcp.close();
    }
  });
});
