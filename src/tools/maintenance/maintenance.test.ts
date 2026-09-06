/**
 * Tests for maintenance windows and heartbeats.
 *
 * The maintenance cases are mostly about the team-scoped twin: one tool, two
 * endpoints, and a path chosen by whether team_id was supplied. Getting that
 * backwards would silently read or write the wrong collection.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { heartbeatTools } from "../heartbeats/index.js";
import { maintenanceWindowTools } from "./index.js";
import { callTool, connectTools, stubClient, textOf } from "../test-support.js";

const TEAM = "00dfafff-17de-4e19-8906-6487cd17c9aa";

function bodyOf(made: { body?: unknown } | undefined): Record<string, unknown> {
  assert.ok(made, "expected the tool to issue a request");
  return made.body as Record<string, unknown>;
}

describe("maintenance windows", () => {
  it("uses the global collection when no team is given", async () => {
    const { client, calls } = stubClient({ items: [] });
    const mcp = await connectTools(maintenanceWindowTools, client);

    await callTool(mcp, "jsm_list_maintenances", {});

    assert.equal(calls[0]?.path, "/v1/maintenances");
  });

  it("switches to the team collection when a team is given", async () => {
    const { client, calls } = stubClient({ items: [] });
    const mcp = await connectTools(maintenanceWindowTools, client);

    await callTool(mcp, "jsm_list_maintenances", { team_id: TEAM });

    assert.equal(calls[0]?.path, `/v1/teams/${TEAM}/maintenances`);
  });

  it("sends the state filter it declares", async () => {
    // It did not for a release: `type` was declared in the input shape, the
    // description and the manifest, and dropped before the request — so a
    // model asking which windows are open now was served expired ones too and
    // could report a finished window as active.
    const { client, calls } = stubClient({ items: [] });
    const mcp = await connectTools(maintenanceWindowTools, client);

    await callTool(mcp, "jsm_list_maintenances", { type: "past" });

    assert.equal(calls[0]?.params?.type, "past");
  });

  it("rejects a state the API does not accept", async () => {
    // The description used to offer 'active' as an example. The spec's enum is
    // all | non-expired | past, so the example was never a valid value — and
    // while the filter was being dropped, nothing ever said so.
    const { client, calls } = stubClient({ items: [] });
    const mcp = await connectTools(maintenanceWindowTools, client);

    const result = await callTool(mcp, "jsm_list_maintenances", { type: "active" });

    assert.equal(result.isError, true);
    assert.equal(calls.length, 0, "a rejected argument must not reach the API");
  });

  it("declares both endpoints it can reach", async () => {
    // The manifest has to describe the request. One tool reaching two paths
    // means two declarations, both checked against the spec.
    const list = maintenanceWindowTools.find((t) => t.name === "jsm_list_maintenances");
    assert.ok(list, "jsm_list_maintenances should be registered");
    const declared = list.endpoint;
    assert.ok(Array.isArray(declared));
    assert.deepEqual(
      declared.map((e) => e.path),
      ["/v1/maintenances", "/v1/teams/{teamId}/maintenances"],
    );
  });

  it("nests the rule entity the way the API spells it", async () => {
    const { client, calls } = stubClient({ items: [] }, { write: { id: "m1" } });
    const mcp = await connectTools(maintenanceWindowTools, client);

    await callTool(mcp, "jsm_create_maintenance", {
      description: "deploy",
      start_date: "2026-09-06T22:00:00Z",
      end_date: "2026-09-06T23:00:00Z",
      rules: [{ entity_id: "i1", entity_type: "integration", state: "disabled" }],
    });

    assert.deepEqual(bodyOf(calls[0]).rules, [
      { entity: { id: "i1", type: "integration" }, state: "disabled" },
    ]);
  });

  it("refuses a window with no rules, which would silence nothing", async () => {
    const { client, calls } = stubClient({ items: [] }, { write: {} });
    const mcp = await connectTools(maintenanceWindowTools, client);

    const result = await callTool(mcp, "jsm_create_maintenance", {
      description: "deploy",
      start_date: "2026-09-06T22:00:00Z",
      end_date: "2026-09-06T23:00:00Z",
      rules: [],
    });

    assert.equal(result.isError, true);
    assert.equal(calls.length, 0);
  });

  it("says a window with no rules silences nothing", async () => {
    const { client } = stubClient({ items: [{ id: "m1", description: "deploy", rules: [] }] });
    const mcp = await connectTools(maintenanceWindowTools, client);

    assert.match(
      textOf(await callTool(mcp, "jsm_list_maintenances", {})),
      /silences nothing — this window has no rules/,
    );
  });

  it("cancels against the scope it was given", async () => {
    const { client, calls } = stubClient({ items: [] }, { write: { id: "m1" } });
    const mcp = await connectTools(maintenanceWindowTools, client);

    await callTool(mcp, "jsm_cancel_maintenance", { maintenance_id: "m1" });
    await callTool(mcp, "jsm_cancel_maintenance", { maintenance_id: "m1", team_id: TEAM });

    assert.equal(calls[0]?.path, "/v1/maintenances/m1/cancel");
    assert.equal(calls[1]?.path, `/v1/teams/${TEAM}/maintenances/m1/cancel`);
  });
});

describe("heartbeats", () => {
  it("identifies a heartbeat by a query parameter, not a path id", async () => {
    // The whole reason this family is hand-written: there is no item path.
    const { client, calls } = stubClient({ items: [] }, { write: { name: "nightly" } });
    const mcp = await connectTools(heartbeatTools, client);

    await callTool(mcp, "jsm_delete_heartbeat", { team_id: TEAM, name: "nightly backup" });

    assert.equal(calls[0]?.method, "DELETE");
    assert.equal(calls[0]?.path, `/v1/teams/${TEAM}/heartbeats`);
    assert.equal(calls[0]?.params?.name, "nightly backup");
  });

  it("pings through the ping sub-path, carrying the name as a parameter", async () => {
    const { client, calls } = stubClient({ items: [] }, { write: { name: "nightly" } });
    const mcp = await connectTools(heartbeatTools, client);

    await callTool(mcp, "jsm_ping_heartbeat", { team_id: TEAM, name: "nightly" });

    assert.equal(calls[0]?.path, `/v1/teams/${TEAM}/heartbeats/ping`);
    assert.equal(calls[0]?.params?.name, "nightly");
  });

  it("marks the ping destructive, because it clears a firing alert", async () => {
    // A ping asserts on the job's behalf that it is alive. Sending one by hand
    // silences a real alert, so it warrants a prompt even though it deletes
    // nothing.
    const ping = heartbeatTools.find((t) => t.name === "jsm_ping_heartbeat");
    assert.equal(ping?.annotations.destructiveHint, true);
    assert.equal(ping?.annotations.readOnlyHint, false);
  });

  it("distinguishes an expired heartbeat from a disabled one", async () => {
    const { client } = stubClient({
      items: [
        { name: "a", status: "Unresponsive", interval: 1, intervalUnit: "Hours" },
        { name: "b", status: "Off", enabled: false },
      ],
    });
    const mcp = await connectTools(heartbeatTools, client);

    const text = textOf(await callTool(mcp, "jsm_list_heartbeats", { team_id: TEAM }));
    assert.match(text, /no ping arrived in time/);
    assert.match(text, /disabled — a missed ping raises nothing/);
  });

  it("maps interval_unit onto the API's camelCase field", async () => {
    const { client, calls } = stubClient({ items: [] }, { write: { name: "nightly" } });
    const mcp = await connectTools(heartbeatTools, client);

    await callTool(mcp, "jsm_create_heartbeat", {
      team_id: TEAM,
      name: "nightly",
      interval: 26,
      interval_unit: "hours",
    });

    const body = bodyOf(calls[0]);
    assert.equal(body.intervalUnit, "hours");
    assert.ok(!("interval_unit" in body));
  });
});
