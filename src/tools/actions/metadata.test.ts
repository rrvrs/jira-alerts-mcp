/**
 * Tests for tag and extra-property changes.
 *
 * Removal is DELETE with a JSON request body, which is unusual enough to be
 * worth pinning: axios does send one, and if it ever stopped, the API would see
 * an empty removal and return a perfectly successful receipt for having done
 * nothing.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { alertActionTools } from "./index.js";
import { callTool, connectTools, stubClient } from "../test-support.js";

const ALERT_ID = "9b251e07-73c9-4907-9996-8cb53a6a20d0-1704440650350";

async function call(tool: string, args: Record<string, unknown>) {
  const { client, calls } = stubClient({ items: [] }, { write: { requestId: "r" } });
  const mcp = await connectTools(alertActionTools, client);
  const result = await callTool(mcp, tool, { alert_id: ALERT_ID, ...args });
  return { result, made: calls[0] };
}

/** The request body, asserted to exist so "no call made" fails clearly. */
function bodyOf(made: { body?: unknown } | undefined): Record<string, unknown> {
  assert.ok(made, "expected the tool to issue a request");
  return made.body as Record<string, unknown>;
}

describe("alert tags", () => {
  it("adds with POST", async () => {
    const { made } = await call("jsm_add_alert_tags", { tags: ["db", "prod"] });

    assert.equal(made?.method, "POST");
    assert.equal(made?.path, `/v1/alerts/${ALERT_ID}/tags`);
    assert.deepEqual(bodyOf(made).tags, ["db", "prod"]);
  });

  it("removes with DELETE, carrying the tags in the request body", async () => {
    const { made } = await call("jsm_remove_alert_tags", { tags: ["db"] });

    assert.equal(made?.method, "DELETE");
    assert.equal(made?.path, `/v1/alerts/${ALERT_ID}/tags`);
    assert.deepEqual(bodyOf(made).tags, ["db"]);
  });

  it("rejects an empty tag list rather than sending a no-op that reports success", async () => {
    const { result, made } = await call("jsm_remove_alert_tags", { tags: [] });

    assert.equal(result.isError, true);
    assert.equal(made, undefined);
  });

  it("marks removal destructive and addition not", () => {
    const add = alertActionTools.find((tool) => tool.name === "jsm_add_alert_tags");
    const remove = alertActionTools.find((tool) => tool.name === "jsm_remove_alert_tags");

    assert.equal(add?.annotations.destructiveHint, false);
    assert.equal(remove?.annotations.destructiveHint, true);
  });
});

describe("alert extra properties", () => {
  it("sends extra_properties as the API's extraProperties", async () => {
    const { made } = await call("jsm_add_alert_extra_properties", {
      extra_properties: { runbook: "https://wiki/x", retries: 3, paged: true },
    });

    assert.deepEqual(bodyOf(made).extraProperties, {
      runbook: "https://wiki/x",
      retries: 3,
      paged: true,
    });
    assert.equal("extra_properties" in bodyOf(made), false);
  });

  it("removes by key, with the keys in the DELETE body", async () => {
    const { made } = await call("jsm_remove_alert_extra_properties", { keys: ["runbook"] });

    assert.equal(made?.method, "DELETE");
    assert.deepEqual(bodyOf(made).keys, ["runbook"]);
  });

  it("marks addition destructive too, because an existing key is overwritten", () => {
    const add = alertActionTools.find((tool) => tool.name === "jsm_add_alert_extra_properties");
    assert.equal(add?.annotations.destructiveHint, true);
  });
});
