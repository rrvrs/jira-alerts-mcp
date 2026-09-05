/**
 * Heartbeats, and the ping in particular.
 *
 * The family had no test file. That mattered most for the ping, whose response
 * is nothing like the other four: it answers `{message: "PONG - Heartbeat
 * received"}`, not a heartbeat record.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { heartbeatTools } from "./index.js";
import { callTool, connectTools, stubClient, textOf } from "../test-support.js";

const TEAM = "team-1";

describe("heartbeats", () => {
  it("addresses a heartbeat by name in the query string, not by a path id", async () => {
    const { client, calls } = stubClient({ items: [] }, { write: { name: "nightly" } });
    const mcp = await connectTools(heartbeatTools, client);

    await callTool(mcp, "jsm_delete_heartbeat", { team_id: TEAM, name: "nightly" });

    assert.equal(calls[0]?.method, "DELETE");
    assert.equal(calls[0]?.path, `/v1/teams/${TEAM}/heartbeats`);
    assert.deepEqual(calls[0]?.params, { name: "nightly" });
  });

  it("reports a ping as an acknowledgement, not as a heartbeat", async () => {
    // Rendering the pong through renderHeartbeat printed "**(unnamed)**" with
    // no interval and no status — which reads like a heartbeat that exists and
    // is broken. Caught by calling it against a live tenant.
    const { client } = stubClient(
      { items: [] },
      { write: { message: "PONG - Heartbeat received" } },
    );
    const mcp = await connectTools(heartbeatTools, client);

    const result = await callTool(mcp, "jsm_ping_heartbeat", { team_id: TEAM, name: "nightly" });

    assert.ok(!result.isError, textOf(result));
    assert.deepEqual(result.structuredContent, {
      pinged: true,
      name: "nightly",
      message: "PONG - Heartbeat received",
    });
    assert.match(textOf(result), /Ping accepted for heartbeat `nightly`/);
    assert.doesNotMatch(textOf(result), /unnamed/);
  });

  it("says a ping proves nothing about the heartbeat", async () => {
    // A live tenant answered PONG for a heartbeat name that does not exist,
    // on a site whose plan excludes heartbeats entirely. Anyone reading the
    // result has to be told that, or a green ping reads as working monitoring.
    const ping = heartbeatTools.find((tool) => tool.name === "jsm_ping_heartbeat");
    assert.match(ping?.description ?? "", /whether or not a heartbeat by that name exists/);

    const { client } = stubClient(
      { items: [] },
      { write: { message: "PONG - Heartbeat received" } },
    );
    const mcp = await connectTools(heartbeatTools, client);
    const result = await callTool(mcp, "jsm_ping_heartbeat", { team_id: TEAM, name: "nope" });

    assert.match(textOf(result), /does not confirm the heartbeat exists/);
  });

  it("annotates the ping as a write, because it clears a firing alert", async () => {
    const ping = heartbeatTools.find((tool) => tool.name === "jsm_ping_heartbeat");
    assert.equal(ping?.annotations.readOnlyHint, false);
    assert.equal(ping?.annotations.destructiveHint, true);
  });
});
