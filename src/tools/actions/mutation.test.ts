/**
 * Tests for the alert mutations: field updates and note editing.
 *
 * Two things here are not like the rest of the family and are worth pinning
 * down. The field updates are PATCH, and they send only the value — the
 * endpoints enumerate one property each, so an actor override would be
 * invented. The note endpoints are synchronous, so neither may point at
 * jsm_get_request_status: there is no request to look up.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { alertActionTools } from "./index.js";
import { callTool, connectTools, stubClient, textOf } from "../test-support.js";

const ALERT_ID = "9b251e07-73c9-4907-9996-8cb53a6a20d0-1704440650350";

async function call(
  tool: string,
  args: Record<string, unknown>,
  write: unknown = { requestId: "r" },
) {
  const { client, calls } = stubClient({ items: [] }, { write });
  const mcp = await connectTools(alertActionTools, client);
  const result = await callTool(mcp, tool, { alert_id: ALERT_ID, ...args });
  return { result, made: calls[0] };
}

describe("jsm_update_alert_field", () => {
  it("PATCHes the endpoint named by `field`", async () => {
    const { made } = await call("jsm_update_alert_field", { field: "priority", value: "P1" });

    assert.equal(made?.method, "PATCH");
    assert.equal(made?.path, `/v1/alerts/${ALERT_ID}/priority`);
    assert.deepEqual(made?.body, { priority: "P1" });
  });

  it("routes message and description to their own endpoints", async () => {
    const message = await call("jsm_update_alert_field", { field: "message", value: "new" });
    assert.equal(message.made?.path, `/v1/alerts/${ALERT_ID}/message`);
    assert.deepEqual(message.made?.body, { message: "new" });

    const description = await call("jsm_update_alert_field", { field: "description", value: "d" });
    assert.equal(description.made?.path, `/v1/alerts/${ALERT_ID}/description`);
    assert.deepEqual(description.made?.body, { description: "d" });
  });

  it("sends no actor fields, which these endpoints do not declare", async () => {
    const { made } = await call("jsm_update_alert_field", { field: "message", value: "new" });

    assert.deepEqual(Object.keys(made?.body as object), ["message"]);
  });

  it("rejects a non-priority value before spending a round trip on a 422", async () => {
    const { result, made } = await call("jsm_update_alert_field", {
      field: "priority",
      value: "high",
    });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /P1, P2, P3, P4, P5/);
    assert.equal(made, undefined, "no request should have been issued");
  });

  it("is annotated destructive, because it overwrites rather than appends", async () => {
    const tool = alertActionTools.find((entry) => entry.name === "jsm_update_alert_field");
    assert.equal(tool?.annotations.destructiveHint, true);
  });
});

describe("jsm_update_alert_note", () => {
  it("renders the note the API returned rather than an async receipt", async () => {
    const { result, made } = await call(
      "jsm_update_alert_note",
      { note_id: "n1", note: "corrected" },
      { id: "n1", note: "corrected", owner: "rvs", createdAt: "2026-09-05T10:00:00.000Z" },
    );

    assert.equal(made?.method, "PATCH");
    assert.equal(made?.path, `/v1/alerts/${ALERT_ID}/notes/n1`);
    assert.match(textOf(result), /corrected/);
    // Synchronous: there is no requestId, so pointing at the poller would send
    // the model looking up a request that was never created.
    assert.doesNotMatch(textOf(result), /jsm_get_request_status/);
  });

  it("percent-encodes both ids into the path", async () => {
    const { made } = await call(
      "jsm_update_alert_note",
      { note_id: "n/1", note: "x" },
      { id: "n" },
    );
    assert.match(made?.path ?? "", /\/notes\/n%2F1$/);
  });
});

describe("jsm_delete_alert_note", () => {
  it("ships a structured payload for the 204 the API answers with", async () => {
    // A result with no structuredContent is rejected by the SDK when an
    // outputSchema is declared, so this is the assertion that the envelope is
    // valid, not just plausible.
    const { result, made } = await call("jsm_delete_alert_note", { note_id: "n1" }, undefined);

    assert.equal(made?.method, "DELETE");
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, { deleted: true, note_id: "n1" });
  });

  it("is annotated destructive", () => {
    const tool = alertActionTools.find((entry) => entry.name === "jsm_delete_alert_note");
    assert.equal(tool?.annotations.destructiveHint, true);
  });
});
