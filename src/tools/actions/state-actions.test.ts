/**
 * Tests for the alert state actions: unacknowledge, snooze, assign, escalate.
 *
 * All four are async POSTs through alertAction, so what is worth asserting is
 * the body mapping — every one of them renames a snake_case argument to a
 * camelCase field the API reads, and getting that wrong fails as a 422 against
 * a tenant and as nothing at all offline.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { alertActionTools } from "./index.js";
import { callTool, connectTools, stubClient, textOf } from "../test-support.js";

const ALERT_ID = "9b251e07-73c9-4907-9996-8cb53a6a20d0-1704440650350";

async function call(tool: string, args: Record<string, unknown>) {
  const { client, calls } = stubClient({ items: [] }, { write: { requestId: "req-1" } });
  const mcp = await connectTools(alertActionTools, client);
  const result = await callTool(mcp, tool, { alert_id: ALERT_ID, ...args });
  return { result, call: calls[0] };
}

/** The request body, asserted to exist so tests fail on "no call made" clearly. */
function bodyOf(made: { body?: unknown } | undefined): Record<string, unknown> {
  assert.ok(made, "expected the tool to issue a request");
  return made.body as Record<string, unknown>;
}

describe("jsm_unacknowledge_alert", () => {
  it("posts to the unacknowledge action", async () => {
    const { call: made } = await call("jsm_unacknowledge_alert", {});
    assert.equal(made?.method, "POST");
    assert.equal(made?.path, `/v1/alerts/${ALERT_ID}/unacknowledge`);
  });
});

describe("jsm_snooze_alert", () => {
  it("sends end_time as the API's endTime", async () => {
    const { call: made } = await call("jsm_snooze_alert", { end_time: "2026-09-05T18:00:00Z" });
    assert.equal(bodyOf(made).endTime, "2026-09-05T18:00:00Z");
    assert.equal("end_time" in bodyOf(made), false);
  });

  it("rejects a bare local time, which the API cannot place on a timeline", async () => {
    const { result } = await call("jsm_snooze_alert", { end_time: "2026-09-05 18:00" });
    assert.equal(result.isError, true);
  });

  it("requires an end time — there is no default snooze length", async () => {
    const { result } = await call("jsm_snooze_alert", {});
    assert.equal(result.isError, true);
  });
});

describe("jsm_assign_alert", () => {
  it("sends account_id as the API's accountId", async () => {
    const { call: made } = await call("jsm_assign_alert", { account_id: "712020:abc" });
    assert.equal(bodyOf(made).accountId, "712020:abc");
    assert.equal("account_id" in bodyOf(made), false);
  });
});

describe("jsm_escalate_alert", () => {
  it("sends escalation_id as the API's escalationId", async () => {
    const { call: made, result } = await call("jsm_escalate_alert", { escalation_id: "esc-1" });
    assert.equal(bodyOf(made).escalationId, "esc-1");
    assert.match(textOf(result), /jsm_get_request_status/);
  });
});

describe("the state actions as a group", () => {
  const names = [
    "jsm_unacknowledge_alert",
    "jsm_snooze_alert",
    "jsm_assign_alert",
    "jsm_escalate_alert",
  ];

  it("are all registered in the alert-actions toolset", () => {
    for (const name of names) {
      const tool = alertActionTools.find((entry) => entry.name === name);
      assert.equal(tool?.toolset, "alert-actions", name);
    }
  });

  it("are all annotated as writes, so read-only mode withholds them", () => {
    for (const name of names) {
      const tool = alertActionTools.find((entry) => entry.name === name);
      assert.equal(tool?.annotations.readOnlyHint, false, name);
    }
  });

  it("all point at the async verification path", async () => {
    // These four change who gets paged. A tool that reported success without
    // saying the change has not landed yet is the specific failure the shared
    // executor exists to prevent.
    for (const [name, args] of [
      ["jsm_unacknowledge_alert", {}],
      ["jsm_snooze_alert", { end_time: "2026-09-05T18:00:00Z" }],
      ["jsm_assign_alert", { account_id: "712020:abc" }],
      ["jsm_escalate_alert", { escalation_id: "esc-1" }],
    ] as const) {
      const { result } = await call(name, args);
      assert.match(textOf(result), /jsm_get_request_status/, name);
    }
  });
});
