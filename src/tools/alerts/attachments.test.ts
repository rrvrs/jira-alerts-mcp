/**
 * Tests for reading and removing alert attachments.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { alertActionTools } from "../actions/index.js";
import { alertReadTools } from "./index.js";
import { callTool, connectTools, stubClient, textOf } from "../test-support.js";

const ALERT_ID = "9b251e07-73c9-4907-9996-8cb53a6a20d0-1704440650350";

describe("jsm_list_alert_attachments", () => {
  it("pages by cursor, sending `after` and `size`", async () => {
    const { client, calls } = stubClient({
      items: [{ id: "1725", attachmentName: "graph.png", insertedAt: "2026-09-05T10:00:00.000Z" }],
    });
    const mcp = await connectTools(alertReadTools, client);

    await callTool(mcp, "jsm_list_alert_attachments", {
      alert_id: ALERT_ID,
      limit: 50,
      cursor: "abc",
    });

    assert.equal(calls[0]?.path, `/v1/alerts/${ALERT_ID}/attachments`);
    assert.equal(calls[0]?.params?.after, "abc");
    assert.equal(calls[0]?.params?.size, 50);
  });

  it("names the files rather than only their ids", async () => {
    const { client } = stubClient({
      items: [{ id: "1725", attachmentName: "graph.png", insertedAt: "2026-09-05T10:00:00.000Z" }],
    });
    const mcp = await connectTools(alertReadTools, client);

    const text = textOf(await callTool(mcp, "jsm_list_alert_attachments", { alert_id: ALERT_ID }));

    assert.match(text, /graph\.png/);
    assert.match(text, /1725/);
  });

  it("answers an empty list as an ordinary result, with a structured payload", async () => {
    const { client } = stubClient({ items: [] });
    const mcp = await connectTools(alertReadTools, client);

    const result = await callTool(mcp, "jsm_list_alert_attachments", { alert_id: ALERT_ID });

    assert.equal(result.isError, undefined);
    assert.deepEqual((result.structuredContent as { attachments: unknown[] }).attachments, []);
  });
});

describe("jsm_get_alert_attachment", () => {
  it("returns the download URL and warns that it needs no credentials", async () => {
    const { client, calls } = stubClient(
      { items: [] },
      { routes: [{ match: "/attachments/", one: { url: "https://files.example/x?sig=1" } }] },
    );
    const mcp = await connectTools(alertReadTools, client);

    const result = await callTool(mcp, "jsm_get_alert_attachment", {
      alert_id: ALERT_ID,
      attachment_id: "1725",
    });

    assert.equal(calls[0]?.path, `/v1/alerts/${ALERT_ID}/attachments/1725`);
    assert.match(textOf(result), /https:\/\/files\.example/);
    assert.match(textOf(result), /temporary/);
    assert.equal(
      (result.structuredContent as { url?: string }).url,
      "https://files.example/x?sig=1",
    );
  });

  it("says so plainly when the API returns no URL", async () => {
    const { client } = stubClient({ items: [] }, { routes: [{ match: "/attachments/", one: {} }] });
    const mcp = await connectTools(alertReadTools, client);

    const result = await callTool(mcp, "jsm_get_alert_attachment", {
      alert_id: ALERT_ID,
      attachment_id: "1725",
    });

    assert.equal(result.isError, undefined);
    assert.match(textOf(result), /no download URL/);
  });
});

describe("jsm_delete_alert_attachment", () => {
  it("ships a structured payload for the 204", async () => {
    const { client, calls } = stubClient({ items: [] }, { write: undefined });
    const mcp = await connectTools(alertActionTools, client);

    const result = await callTool(mcp, "jsm_delete_alert_attachment", {
      alert_id: ALERT_ID,
      attachment_id: "1725",
    });

    assert.equal(calls[0]?.method, "DELETE");
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, { deleted: true, attachment_id: "1725" });
  });

  it("is annotated destructive", () => {
    const tool = alertActionTools.find((entry) => entry.name === "jsm_delete_alert_attachment");
    assert.equal(tool?.annotations.destructiveHint, true);
  });
});
