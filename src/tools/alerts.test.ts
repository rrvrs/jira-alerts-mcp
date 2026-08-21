/**
 * Tests for the alert read tools' local guards.
 *
 * Tools are registered against a stub server that captures each handler, so
 * the handlers can be invoked directly with no MCP transport and no HTTP.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { MAX_ALERT_WINDOW } from "../constants.js";
import { JsmClient, loadConfig } from "../services/client.js";
import type { ToolResult } from "../services/format.js";
import type { Alert, Paged } from "../types.js";
import { registerAlertReadTools } from "./alerts.js";

type Handler = (params: Record<string, unknown>) => Promise<ToolResult>;

/** Registers the read tools against a stub server and returns their handlers by name. */
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

const config = loadConfig({
  JSM_CLOUD_ID: "cloud-id",
  JSM_OAUTH_TOKEN: "bearer",
} as NodeJS.ProcessEnv);

/**
 * A client that fails the test if any request is attempted, and otherwise
 * serves a fixed page. `calls` records what the tool asked for.
 */
function stubClient(page: Paged<Alert> = { items: [] }) {
  const calls: Array<{ path: string; params?: Record<string, unknown> }> = [];
  const client = new (class extends JsmClient {
    override async getCollection<T>(
      path: string,
      params?: Record<string, unknown>,
    ): Promise<Paged<T>> {
      calls.push({ path, params });
      return page as unknown as Paged<T>;
    }
  })(config);

  return { client, calls };
}

const listParams = {
  limit: 20,
  offset: 0,
  sort: "createdAt",
  order: "desc",
  response_format: "markdown",
};

describe("jsm_list_alerts window guard", () => {
  it("rejects paging past the API's 20,000-record window without issuing a request", async () => {
    const { client, calls } = stubClient();
    const listAlerts = captureHandlers(client).get("jsm_list_alerts");
    assert.ok(listAlerts, "jsm_list_alerts should be registered");

    const result = await listAlerts({ ...listParams, offset: MAX_ALERT_WINDOW, limit: 20 });

    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", new RegExp(`${MAX_ALERT_WINDOW}-record window`));
    // The point of the guard is saving a round trip on a guaranteed 400.
    assert.equal(calls.length, 0, "should not have called the API");
  });

  it("tells the model to narrow the query rather than to page differently", async () => {
    const { client } = stubClient();
    const listAlerts = captureHandlers(client).get("jsm_list_alerts")!;

    const result = await listAlerts({ ...listParams, offset: 19_950, limit: 100 });
    assert.match(result.content[0]?.text ?? "", /Narrow the search with 'query'/);
  });

  it("allows a request that lands exactly on the window boundary", async () => {
    const { client, calls } = stubClient();
    const listAlerts = captureHandlers(client).get("jsm_list_alerts")!;

    const result = await listAlerts({
      ...listParams,
      offset: MAX_ALERT_WINDOW - 20,
      limit: 20,
    });

    assert.notEqual(result.isError, true);
    assert.equal(calls.length, 1);
  });

  it("passes the search arguments through to the alerts endpoint", async () => {
    const { client, calls } = stubClient();
    const listAlerts = captureHandlers(client).get("jsm_list_alerts")!;

    await listAlerts({ ...listParams, query: "status:open", limit: 50, offset: 10 });

    assert.equal(calls[0]?.path, "/v1/alerts");
    assert.equal(calls[0]?.params?.query, "status:open");
    assert.equal(calls[0]?.params?.limit, 50);
    assert.equal(calls[0]?.params?.offset, 10);
  });

  it("reports an empty result set as success, not as an error", async () => {
    const { client } = stubClient({ items: [] });
    const listAlerts = captureHandlers(client).get("jsm_list_alerts")!;

    const result = await listAlerts({ ...listParams, query: "status:open" });
    assert.notEqual(result.isError, true);
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
