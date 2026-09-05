/**
 * Tests for the shared write executor and the paging dialects.
 *
 * Driven through connectTools rather than by calling executeWrite directly.
 * That is the point of several of these: a 204 and an empty page both produce a
 * result with no obvious structured payload, and the SDK rejects such a result
 * outright when an outputSchema is declared. Calling the function would return
 * a plausible object and prove nothing.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";

import { ResponseFormat } from "../schemas/common.js";
import { alertActionTools } from "./actions/index.js";
import { defineTool, type AnyToolDefinition } from "./define.js";
import { executeWrite } from "./execute-write.js";
import { executeList } from "./list-executor.js";
import type { PagingDialect } from "./paging.js";
import { callTool, connectTools, httpError, stubClient, textOf } from "./test-support.js";

const ALERT_ID = "9b251e07-73c9-4907-9996-8cb53a6a20d0-1704440650350";

/** A throwaway tool, so a write mode can be exercised before a real tool uses it. */
function writeProbe(
  name: string,
  options: Omit<Parameters<typeof executeWrite>[1], "label">,
): AnyToolDefinition {
  return defineTool({
    name,
    toolset: "alert-actions",
    title: name,
    description: "Test probe.",
    inputSchema: {},
    outputSchema: { deleted: z.boolean().optional() },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (_params, client) => executeWrite(client, { label: "Probe", ...options }),
  });
}

/** A throwaway list tool, for exercising a paging dialect end to end. */
function listProbe(paging: PagingDialect, itemsKey?: string): AnyToolDefinition {
  return defineTool({
    name: "probe_list",
    toolset: "alerts",
    title: "probe_list",
    description: "Test probe.",
    inputSchema: {},
    outputSchema: {
      things: z.array(z.object({}).passthrough()),
      pagination: z.object({}).passthrough(),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (_params, client) =>
      executeList({
        client,
        path: "/v1/things",
        key: "things",
        context: "list things",
        limit: 3,
        paging,
        ...(itemsKey ? { itemsKey } : {}),
        render: (items) => `${items.length} things`,
        emptyMessage: "No things.",
        hint: "Page for more.",
        format: ResponseFormat.MARKDOWN,
      }),
  });
}

describe("executeWrite — async mode", () => {
  it("reports the receipt and points at the verification path", async () => {
    const { client, calls } = stubClient(
      { items: [] },
      { write: { result: "Request will be processed", requestId: "req-1" } },
    );
    const mcp = await connectTools(alertActionTools, client);

    const result = await callTool(mcp, "jsm_acknowledge_alert", { alert_id: ALERT_ID });

    assert.equal(calls[0]?.method, "POST");
    assert.equal(calls[0]?.path, `/v1/alerts/${ALERT_ID}/acknowledge`);
    assert.match(textOf(result), /req-1/);
    assert.match(textOf(result), /jsm_get_request_status/);
    // The word survived generalising the receipt away from alerts.
    assert.match(textOf(result), /for alert/);
    assert.deepEqual(result.structuredContent, {
      requestId: "req-1",
      result: "Request will be processed",
      alert_id: ALERT_ID,
    });
  });

  it("sends the note and actor in the body, not the query string", async () => {
    const { client, calls } = stubClient({ items: [] }, { write: { requestId: "r" } });
    const mcp = await connectTools(alertActionTools, client);

    await callTool(mcp, "jsm_close_alert", {
      alert_id: ALERT_ID,
      note: "resolved",
      user: "RVS",
    });

    assert.deepEqual(calls[0]?.body, { user: "RVS", source: undefined, note: "resolved" });
    assert.equal(calls[0]?.params, undefined);
  });

  it("percent-encodes the alert id into the path", async () => {
    const { client, calls } = stubClient({ items: [] }, { write: { requestId: "r" } });
    const mcp = await connectTools(alertActionTools, client);

    await callTool(mcp, "jsm_acknowledge_alert", { alert_id: "a/b c" });

    assert.equal(calls[0]?.path, "/v1/alerts/a%2Fb%20c/acknowledge");
  });

  it("turns an API failure into an in-result error, not a protocol error", async () => {
    const { client } = stubClient({ items: [] }, { writeError: httpError(403) });
    const mcp = await connectTools(alertActionTools, client);

    const result = await callTool(mcp, "jsm_acknowledge_alert", { alert_id: ALERT_ID });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /permission denied/);
  });
});

describe("executeWrite — sync and deleted modes", () => {
  it("ships a structured payload for a 204, which the SDK would otherwise reject", async () => {
    const { client, calls } = stubClient({ items: [] }, { write: undefined });
    const mcp = await connectTools(
      [
        writeProbe("probe_delete", {
          method: "DELETE",
          path: "/v1/alerts/x/notes/1",
          mode: "deleted",
          subject: { key: "note_id", value: "1", noun: "note" },
        }),
      ],
      client,
    );

    const result = await callTool(mcp, "probe_delete");

    assert.equal(calls[0]?.method, "DELETE");
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, { deleted: true, note_id: "1" });
    // No async receipt: there is no request id to poll for a synchronous write.
    assert.doesNotMatch(textOf(result), /jsm_get_request_status/);
  });

  it("renders the returned object for a synchronous write", async () => {
    const { client } = stubClient({ items: [] }, { write: { note: "edited", id: "1" } });
    const mcp = await connectTools(
      [
        writeProbe("probe_patch", {
          method: "PATCH",
          path: "/v1/alerts/x/notes/1",
          mode: "sync",
          body: { note: "edited" },
          subject: { key: "note_id", value: "1", noun: "note" },
          render: (data) => `Updated: ${(data as { note: string }).note}`,
        }),
      ],
      client,
    );

    const result = await callTool(mcp, "probe_patch");

    assert.match(textOf(result), /Updated: edited/);
    assert.doesNotMatch(textOf(result), /asynchronously/);
  });
});

describe("paging dialects", () => {
  it("sends `size` by default, which is what most endpoints read", async () => {
    const { client, calls } = stubClient({ items: [{ id: "a" }] });
    const mcp = await connectTools([listProbe({ kind: "offset" })], client);

    await callTool(mcp, "probe_list");

    assert.equal(calls[0]?.params?.size, 3);
    assert.equal(calls[0]?.params?.limit, undefined);
  });

  it("sends `limit` for the audit-log dialect, which does not know `size`", async () => {
    const { client, calls } = stubClient({ items: [{ id: "a" }] });
    const mcp = await connectTools([listProbe({ kind: "token" })], client);

    await callTool(mcp, "probe_list");

    assert.equal(calls[0]?.params?.limit, 3);
    assert.equal(calls[0]?.params?.size, undefined);
  });

  it("sends no page size to an endpoint that takes none", async () => {
    const { client, calls } = stubClient({ items: [{ id: "a" }] });
    const mcp = await connectTools([listProbe({ kind: "none" })], client);

    await callTool(mcp, "probe_list");

    assert.equal(calls[0]?.params?.size, undefined);
    assert.equal(calls[0]?.params?.limit, undefined);
  });

  it("never claims a next page on an unpaged endpoint, even on a full-looking page", async () => {
    // Three items for a limit of three: the "a full page means more" heuristic
    // would say has_more here, and would say it again on every retry.
    const { client } = stubClient({ items: [{ id: "a" }, { id: "b" }, { id: "c" }] });
    const mcp = await connectTools([listProbe({ kind: "none" })], client);

    const result = await callTool(mcp, "probe_list");
    const pagination = (result.structuredContent as { pagination: { has_more: boolean } })
      .pagination;

    assert.equal(pagination.has_more, false);
  });

  it("still reports a next page on a full offset-paged response", async () => {
    const { client } = stubClient({ items: [{ id: "a" }, { id: "b" }, { id: "c" }] });
    const mcp = await connectTools([listProbe({ kind: "offset" })], client);

    const result = await callTool(mcp, "probe_list");
    const pagination = (result.structuredContent as { pagination: { has_more: boolean } })
      .pagination;

    assert.equal(pagination.has_more, true);
  });

  it("passes an itemsKey through to the client for an off-convention envelope", async () => {
    const { client, calls } = stubClient({ items: [{ id: "a" }] });
    const mcp = await connectTools([listProbe({ kind: "none" }, "platformTeams")], client);

    await callTool(mcp, "probe_list");

    assert.equal(calls[0]?.itemsKey, "platformTeams");
  });
});
