/**
 * Tests for the schedule configuration toolset.
 *
 * family.test.ts covers the factory in general; these cover what is specific to
 * this family and would be silently wrong: the nested paths, the fact that an
 * override is addressed by alias rather than id, that it updates with PUT, and
 * the responder mapping for 'noone'.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { scheduleConfigTools } from "./index.js";
import { callTool, connectTools, stubClient, textOf } from "../test-support.js";

/** Asserts a request was actually made before reading its body. */
function bodyOf(made: { body?: unknown } | undefined): Record<string, unknown> {
  assert.ok(made, "expected the tool to issue a request");
  return made.body as Record<string, unknown>;
}

const SCHEDULE = "54ed7b28-fc01-4ba8-afb0-a12988fa4f6e";
const ROTATION = "250750ca-e4d2-45ba-b2e5-ea2941e1c9f7";

describe("schedule configuration tools", () => {
  it("nests a rotation under its schedule, encoding both ids", async () => {
    const { client, calls } = stubClient({ items: [] }, { write: { id: ROTATION } });
    const mcp = await connectTools(scheduleConfigTools, client);

    await callTool(mcp, "jsm_get_rotation", { schedule_id: "a/b", rotation_id: "c d" });

    assert.equal(calls[0]?.path, "/v1/schedules/a%2Fb/rotations/c%20d");
  });

  it("lists rotations from the nested collection path", async () => {
    const { client, calls } = stubClient({ items: [{ id: ROTATION, name: "Primary" }] });
    const mcp = await connectTools(scheduleConfigTools, client);

    const result = await callTool(mcp, "jsm_list_rotations", { schedule_id: SCHEDULE });

    assert.equal(calls[0]?.path, `/v1/schedules/${SCHEDULE}/rotations`);
    assert.match(textOf(result), /Primary/);
  });

  it("says a rotation with no participants pages nobody", async () => {
    // The failure this family exists to make visible: a schedule that looks
    // configured and pages no one. Rendering an empty list would hide it.
    const { client } = stubClient({ items: [{ id: ROTATION, name: "Primary", participants: [] }] });
    const mcp = await connectTools(scheduleConfigTools, client);

    const result = await callTool(mcp, "jsm_list_rotations", { schedule_id: SCHEDULE });

    assert.match(textOf(result), /pages nobody/);
  });

  it("says a schedule with no rotations pages nobody", async () => {
    const { client } = stubClient({ items: [{ id: SCHEDULE, name: "Payments", rotations: [] }] });
    const mcp = await connectTools(scheduleConfigTools, client);

    const result = await callTool(mcp, "jsm_get_schedule", { schedule_id: SCHEDULE });

    assert.match(textOf(result), /no rotations, so nobody is ever on call/);
  });

  it("addresses an override by alias, and updates it with PUT", async () => {
    // Both are spec facts, and both fail loudly-but-late if wrong: PATCH here
    // is a 405, and an id in place of an alias is a 404.
    const { client, calls } = stubClient({ items: [] }, { write: { alias: "cover-1" } });
    const mcp = await connectTools(scheduleConfigTools, client);

    await callTool(mcp, "jsm_update_override", {
      schedule_id: SCHEDULE,
      override_alias: "cover-1",
      responder_type: "user",
      responder_id: "acc-1",
      start_date: "2026-09-06T09:00:00Z",
      end_date: "2026-09-07T09:00:00Z",
    });

    assert.equal(calls[0]?.method, "PUT");
    assert.equal(calls[0]?.path, `/v1/schedules/${SCHEDULE}/overrides/cover-1`);
    assert.deepEqual(bodyOf(calls[0]).responder, { type: "user", id: "acc-1" });
  });

  it("sends no responder id for type 'noone'", async () => {
    // The spec is explicit that id is null when the type is `noone`. Sending an
    // id alongside it would describe a cover that is deliberately not one.
    const { client, calls } = stubClient({ items: [] }, { write: { alias: "gap-1" } });
    const mcp = await connectTools(scheduleConfigTools, client);

    await callTool(mcp, "jsm_create_override", {
      schedule_id: SCHEDULE,
      responder_type: "noone",
      start_date: "2026-09-06T09:00:00Z",
      end_date: "2026-09-07T09:00:00Z",
    });

    assert.deepEqual(bodyOf(calls[0]).responder, { type: "noone" });
  });

  it("renders 'noone' as an unstaffed shift, not as a responder", async () => {
    const { client } = stubClient({
      items: [{ alias: "gap-1", responder: { type: "noone" }, startDate: "s", endDate: "e" }],
    });
    const mcp = await connectTools(scheduleConfigTools, client);

    const result = await callTool(mcp, "jsm_list_overrides", { schedule_id: SCHEDULE });

    assert.match(textOf(result), /deliberately left unstaffed/);
  });

  it("maps snake_case inputs onto the API's camelCase body", async () => {
    const { client, calls } = stubClient({ items: [] }, { write: { id: ROTATION } });
    const mcp = await connectTools(scheduleConfigTools, client);

    await callTool(mcp, "jsm_create_rotation", {
      schedule_id: SCHEDULE,
      type: "weekly",
      start_date: "2026-09-01T09:00:00Z",
      length: 2,
      participants: [{ id: "acc-1", type: "user" }],
    });

    const body = bodyOf(calls[0]);
    assert.equal(body.startDate, "2026-09-01T09:00:00Z");
    assert.equal(body.length, 2);
    assert.deepEqual(body.participants, [{ id: "acc-1", type: "user" }]);
    assert.ok(!("start_date" in body), "the API reads startDate, not start_date");
  });

  it("marks every configuration delete destructive", async () => {
    for (const name of ["jsm_delete_schedule", "jsm_delete_rotation", "jsm_delete_override"]) {
      const tool = scheduleConfigTools.find((t) => t.name === name);
      assert.equal(tool?.annotations.destructiveHint, true, `${name} must be destructive`);
      assert.equal(tool?.annotations.readOnlyHint, false, name);
    }
  });
});
