/**
 * Tests for the alert read tools.
 *
 * Most of these go through a real McpServer over an in-memory transport, so
 * output-schema validation runs. That matters: an earlier version of this file
 * drove handlers directly, and as a result asserted that an empty result set
 * was fine when the SDK was in fact rejecting it with `-32602`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { MAX_ALERT_WINDOW } from "../constants.js";
import type { JsmClient } from "../services/client.js";
import type { ToolResult } from "../services/format.js";
import type { Alert } from "../types.js";
import { registerAlertReadTools } from "./alerts.js";
import { callTool, connectTools, stubClient, textOf } from "./test-support.js";

type Handler = (params: Record<string, unknown>) => Promise<ToolResult>;

/**
 * Captures handlers without a transport. Only for assertions about what a tool
 * does *before* it would reach the API — anything about the returned result
 * must go through connectTools instead, or schema violations slip through.
 */
function captureHandlers(client: JsmClient): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const stub = {
    registerTool(name: string, _config: unknown, handler: Handler) {
      handlers.set(name, handler);
      return {};
    },
  };
  registerAlertReadTools(stub as unknown as McpServer, client);
  return handlers;
}

function alertFixture(index: number, padding = ""): Alert {
  return {
    id: `9b251e07-73c9-4907-9996-8cb53a6a20d0-17044406503${String(index).padStart(2, "0")}`,
    tinyId: String(index),
    message: `Alert ${index}${padding}`,
    status: "open",
    acknowledged: false,
    createdAt: "2026-07-01T00:00:00.000Z",
  };
}

describe("jsm_list_alerts window guard", () => {
  it("rejects paging past the API's 20,000-record window without issuing a request", async () => {
    const { client, calls } = stubClient();
    const listAlerts = captureHandlers(client).get("jsm_list_alerts");
    assert.ok(listAlerts, "jsm_list_alerts should be registered");

    const result = await listAlerts({
      offset: MAX_ALERT_WINDOW,
      limit: 20,
      sort: "createdAt",
      order: "desc",
      response_format: "markdown",
    });

    assert.equal(result.isError, true);
    assert.match(textOf(result), new RegExp(`${MAX_ALERT_WINDOW}-record window`));
    // The point of the guard is saving a round trip on a guaranteed 400.
    assert.equal(calls.length, 0, "should not have called the API");
  });

  it("tells the model to narrow the query rather than to page differently", async () => {
    const { client } = stubClient();
    const mcp = await connectTools(registerAlertReadTools, client);
    const result = await callTool(mcp, "jsm_list_alerts", { offset: 19_950, limit: 100 });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /Narrow the search with 'query'/);
  });

  it("allows a request that lands exactly on the window boundary", async () => {
    const { client, calls } = stubClient({ items: [alertFixture(1)] });
    const mcp = await connectTools(registerAlertReadTools, client);

    const result = await callTool(mcp, "jsm_list_alerts", {
      offset: MAX_ALERT_WINDOW - 20,
      limit: 20,
    });

    assert.notEqual(result.isError, true);
    assert.equal(calls.length, 1);
  });

  it("passes the search arguments through to the alerts endpoint", async () => {
    const { client, calls } = stubClient({ items: [alertFixture(1)] });
    const mcp = await connectTools(registerAlertReadTools, client);

    await callTool(mcp, "jsm_list_alerts", { query: "status:open", limit: 50, offset: 10 });

    assert.equal(calls[0]?.path, "/v1/alerts");
    assert.equal(calls[0]?.params?.query, "status:open");
    assert.equal(calls[0]?.params?.limit, 50);
    assert.equal(calls[0]?.params?.offset, 10);
  });
});

describe("empty result sets", () => {
  // Regression: every list tool declares an outputSchema, and the SDK rejects a
  // non-error result carrying no structuredContent. Returning ok(text) from the
  // empty branch turned "no alerts matched" into a protocol error.
  it("returns the search hint, not a schema error, when nothing matches", async () => {
    const { client } = stubClient({ items: [] });
    const mcp = await connectTools(registerAlertReadTools, client);
    const result = await callTool(mcp, "jsm_list_alerts", { query: "status:open" });

    assert.notEqual(result.isError, true);
    assert.doesNotMatch(textOf(result), /Output validation error/);
    assert.match(textOf(result), /No alerts matched 'status:open'/);
    assert.deepEqual(result.structuredContent?.alerts, []);
  });

  it("distinguishes an empty site from an empty query result", async () => {
    const { client } = stubClient({ items: [] });
    const mcp = await connectTools(registerAlertReadTools, client);
    const result = await callTool(mcp, "jsm_list_alerts", {});

    assert.notEqual(result.isError, true);
    assert.match(textOf(result), /No alerts found on this site/);
  });

  it("reports an empty note timeline without a schema error", async () => {
    const { client } = stubClient({ items: [] });
    const mcp = await connectTools(registerAlertReadTools, client);
    const result = await callTool(mcp, "jsm_list_alert_notes", { alert_id: "abc-123" });

    assert.notEqual(result.isError, true);
    assert.match(textOf(result), /No notes on this alert/);
  });
});

describe("truncated list responses", () => {
  /** 100 alerts fat enough to trip the 25,000-character limit. */
  const oversized = {
    items: Array.from({ length: 100 }, (_, i) => alertFixture(i, `: ${"detail ".repeat(60)}`)),
  };

  it("reports the count it actually returned, not the count it fetched", async () => {
    const { client } = stubClient(oversized);
    const mcp = await connectTools(registerAlertReadTools, client);
    const result = await callTool(mcp, "jsm_list_alerts", { limit: 100, offset: 0 });

    const alerts = result.structuredContent?.alerts as unknown[];
    const pagination = result.structuredContent?.pagination as Record<string, unknown>;

    assert.ok(alerts.length < 100, "fixture should have been truncated");
    assert.equal(pagination.count, alerts.length);
    assert.equal(pagination.truncated, true);
  });

  it("resumes at the first record it withheld, so nothing is skipped", async () => {
    // Regression: next_offset used to be offset + limit, which paged straight
    // past every alert truncation had dropped.
    const { client } = stubClient(oversized);
    const mcp = await connectTools(registerAlertReadTools, client);
    const result = await callTool(mcp, "jsm_list_alerts", { limit: 100, offset: 40 });

    const alerts = result.structuredContent?.alerts as unknown[];
    const pagination = result.structuredContent?.pagination as Record<string, unknown>;

    assert.equal(pagination.next_offset, 40 + alerts.length);
    assert.equal(pagination.has_more, true);
  });

  it("flags truncation in json mode, where the prose notice is dropped", async () => {
    const { client } = stubClient(oversized);
    const mcp = await connectTools(registerAlertReadTools, client);
    const result = await callTool(mcp, "jsm_list_alerts", {
      limit: 100,
      response_format: "json",
    });

    // renderFormat's JSON branch discards the rendered markdown, so the
    // "_Truncated: showing N of M_" notice never reaches the model here. The
    // structured flag is the only signal, and it has to be present.
    assert.equal(textOf(result).includes("Truncated"), false);
    assert.equal((result.structuredContent?.pagination as Record<string, unknown>).truncated, true);
  });

  it("keeps markdown mode's human-readable truncation notice", async () => {
    const { client } = stubClient(oversized);
    const mcp = await connectTools(registerAlertReadTools, client);
    const result = await callTool(mcp, "jsm_list_alerts", { limit: 100 });

    assert.match(textOf(result), /Truncated: showing \d+ of 100 records/);
  });
});

describe("registerAlertReadTools", () => {
  it("registers exactly the read tools the README documents", () => {
    const { client } = stubClient();
    const names = [...captureHandlers(client).keys()].sort();

    assert.deepEqual(names, [
      "jsm_get_alert",
      "jsm_get_request_status",
      "jsm_list_alert_logs",
      "jsm_list_alert_notes",
      "jsm_list_alerts",
    ]);
  });
});
