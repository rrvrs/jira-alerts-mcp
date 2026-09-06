/**
 * Tests for the two tools that can do the most damage: deleting an alert
 * outright, and running somebody else's automation against production.
 *
 * Their annotations are what a client reads to decide whether to prompt, so the
 * annotations are asserted rather than assumed.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { alertActionTools } from "./index.js";
import { callTool, connectTools, stubClient, textOf } from "../test-support.js";

const ALERT_ID = "9b251e07-73c9-4907-9996-8cb53a6a20d0-1704440650350";

const tool = (name: string) => alertActionTools.find((entry) => entry.name === name);

describe("jsm_delete_alert", () => {
  it("deletes the alert itself, with no action segment on the path", async () => {
    const { client, calls } = stubClient({ items: [] }, { write: { requestId: "r" } });
    const mcp = await connectTools(alertActionTools, client);

    await callTool(mcp, "jsm_delete_alert", { alert_id: ALERT_ID });

    assert.equal(calls[0]?.method, "DELETE");
    // A trailing slash here would be a different resource, and is what building
    // this on top of the action helper would have produced.
    assert.equal(calls[0]?.path, `/v1/alerts/${ALERT_ID}`);
  });

  it("is annotated destructive, so clients prompt before running it", () => {
    assert.equal(tool("jsm_delete_alert")?.annotations.destructiveHint, true);
    assert.equal(tool("jsm_delete_alert")?.annotations.readOnlyHint, false);
  });

  it("tells the model to prefer closing, in the text the model actually reads", () => {
    const description = tool("jsm_delete_alert")?.description ?? "";

    assert.match(description, /jsm_close_alert/);
    assert.match(description, /no undo/);
    assert.match(description, /delete:ops-alert/);
  });
});

describe("jsm_execute_alert_action", () => {
  it("sends action_name as the API's actionName", async () => {
    const { client, calls } = stubClient({ items: [] }, { write: { requestId: "r" } });
    const mcp = await connectTools(alertActionTools, client);

    const result = await callTool(mcp, "jsm_execute_alert_action", {
      alert_id: ALERT_ID,
      action_name: "RestartServer",
    });

    const made = calls[0];
    assert.ok(made, "expected the tool to issue a request");
    assert.equal(made.path, `/v1/alerts/${ALERT_ID}/action`);
    assert.equal((made.body as { actionName: string }).actionName, "RestartServer");
    assert.match(textOf(result), /RestartServer/);
  });

  it("warns against guessing a name, since an unknown one succeeds silently", () => {
    const description = tool("jsm_execute_alert_action")?.description ?? "";

    assert.match(description, /Do not guess/);
    assert.match(description, /silently does nothing/);
  });

  it("is annotated destructive and non-idempotent", () => {
    // What a custom action does is defined outside this server, so the honest
    // annotation is the pessimistic one.
    const annotations = tool("jsm_execute_alert_action")?.annotations;
    assert.equal(annotations?.destructiveHint, true);
    assert.equal(annotations?.idempotentHint, false);
  });
});

describe("the alert-actions toolset as a whole", () => {
  it("declares an endpoint for every tool, so the drift guard covers all of them", () => {
    const missing = alertActionTools.filter((entry) => !entry.endpoint).map((entry) => entry.name);
    assert.deepEqual(missing, []);
  });

  it("marks every tool as a write, so read-only mode withholds the whole set", () => {
    const readable = alertActionTools
      .filter((entry) => entry.annotations.readOnlyHint)
      .map((entry) => entry.name);
    assert.deepEqual(readable, []);
  });
});
