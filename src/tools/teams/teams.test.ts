/**
 * Tests for the teams toolset.
 *
 * The two envelope cases here are the reason `itemsKey` and the "none" paging
 * dialect exist. Both failed silently before: they returned "none found"
 * against a populated site, which is a wrong answer rather than an error, and
 * no amount of reading the handler would have shown it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { teamTools } from "./index.js";
import { callTool, connectTools, stubClient, textOf } from "../test-support.js";

const TEAM = "00dfafff-17de-4e19-8906-6487cd17c9aa";

function bodyOf(made: { body?: unknown } | undefined): Record<string, unknown> {
  assert.ok(made, "expected the tool to issue a request");
  return made.body as Record<string, unknown>;
}

describe("teams toolset", () => {
  it("reads teams from the platformTeams envelope", async () => {
    const { client, calls } = stubClient({ items: [{ teamId: TEAM, teamName: "Payments" }] });
    const mcp = await connectTools(teamTools, client);

    const result = await callTool(mcp, "jsm_list_teams", {});

    assert.equal(calls[0]?.itemsKey, "platformTeams");
    assert.match(textOf(result), /Payments/);
  });

  it("sends no paging parameters to the unpaged team endpoints", async () => {
    // GET /v1/teams declares none. Sending size and offset was harmless on the
    // wire and wrong in the manifest, which is the one place a reader checks.
    const { client, calls } = stubClient({ items: [{ teamId: TEAM, teamName: "Payments" }] });
    const mcp = await connectTools(teamTools, client);

    await callTool(mcp, "jsm_list_teams", { limit: 50, offset: 10 });

    assert.equal(calls[0]?.params?.size, undefined);
    assert.equal(calls[0]?.params?.offset, undefined);
  });

  it("reports has_more false on an unpaged endpoint, however full the page", async () => {
    // The heuristic this guards: `fetched >= limit` would claim another page
    // forever on an endpoint that returns everything at once.
    const items = Array.from({ length: 20 }, (_, i) => ({
      teamId: `t${i}`,
      teamName: `Team ${i}`,
    }));
    const { client } = stubClient({ items });
    const mcp = await connectTools(teamTools, client);

    const result = await callTool(mcp, "jsm_list_teams", { limit: 20 });

    const payload = result.structuredContent as { pagination: { has_more: boolean } };
    assert.equal(payload.pagination.has_more, false);
  });

  it("declares only the query parameters it actually sends", async () => {
    const listTeams = teamTools.find((t) => t.name === "jsm_list_teams");
    assert.deepEqual(listTeams?.endpoint, { method: "GET", path: "/v1/teams", query: [] });

    // Inputs are snake_case, the API is camelCase; the manifest must describe
    // the request, not the tool.
    const listContacts = teamTools.find((t) => t.name === "jsm_list_contacts");
    assert.deepEqual(listContacts?.endpoint, {
      method: "GET",
      path: "/v1/users/contacts",
      query: ["size", "offset", "targetAccountId"],
    });
  });

  it("maps the contact filter onto the API's own parameter name", async () => {
    const { client, calls } = stubClient({ items: [] });
    const mcp = await connectTools(teamTools, client);

    await callTool(mcp, "jsm_list_contacts", { target_account_id: "acc-1" });

    assert.equal(calls[0]?.params?.targetAccountId, "acc-1");
    assert.ok(!("target_account_id" in (calls[0]?.params ?? {})));
  });

  it("says a disabled contact method delivers nothing", async () => {
    // The reason someone "was not paged" — and invisible if status is just
    // rendered as a field.
    const { client } = stubClient({
      items: [{ id: "c1", method: "sms", to: "+100", status: { enabled: false } }],
    });
    const mcp = await connectTools(teamTools, client);

    const result = await callTool(mcp, "jsm_list_contacts", {});

    assert.match(textOf(result), /disabled/);
    assert.match(textOf(result), /nothing is delivered here/);
  });

  it("deactivating a contact is destructive; activating is not", async () => {
    const off = teamTools.find((t) => t.name === "jsm_deactivate_contact");
    const on = teamTools.find((t) => t.name === "jsm_activate_contact");
    assert.equal(
      off?.annotations.destructiveHint,
      true,
      "stopping notifications warrants a prompt",
    );
    assert.equal(on?.annotations.destructiveHint, false);
  });

  it("patches the action sub-path when switching a contact", async () => {
    const { client, calls } = stubClient({ items: [] }, { write: { id: "c1", method: "sms" } });
    const mcp = await connectTools(teamTools, client);

    await callTool(mcp, "jsm_deactivate_contact", { contact_id: "c 1" });

    assert.equal(calls[0]?.method, "PATCH");
    assert.equal(calls[0]?.path, "/v1/users/contacts/c%201/deactivate");
  });

  it("assigns a user role through its own endpoint, in the API's casing", async () => {
    const { client, calls } = stubClient({ items: [] }, { write: {} });
    const mcp = await connectTools(teamTools, client);

    await callTool(mcp, "jsm_assign_user_role", { account_id: "acc-1", role_id: "role-1" });

    assert.equal(calls[0]?.path, "/v1/roles/assign");
    assert.deepEqual(bodyOf(calls[0]), { accountId: "acc-1", roleId: "role-1" });
  });

  it("marks granting site-wide rights destructive", async () => {
    const assign = teamTools.find((t) => t.name === "jsm_assign_user_role");
    assert.equal(assign?.annotations.destructiveHint, true);
  });
});
