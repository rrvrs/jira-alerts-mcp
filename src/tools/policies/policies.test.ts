/**
 * Tests for the policies toolset.
 *
 * The collapse decisions are the interesting part here. Five operations are
 * identical across the global and team scopes and share a tool; three are not,
 * because the team list requires a `type` the global one does not accept and
 * the two creates differ in what they require. Getting that wrong would either
 * ship a tool that 400s or one whose description has to explain when half its
 * parameters apply.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { policyTools } from "./index.js";
import { callTool, connectTools, stubClient, textOf } from "../test-support.js";

const TEAM = "00dfafff-17de-4e19-8906-6487cd17c9aa";

function bodyOf(made: { body?: unknown } | undefined): Record<string, unknown> {
  assert.ok(made, "expected the tool to issue a request");
  return made.body as Record<string, unknown>;
}

describe("policies toolset", () => {
  it("shares one tool across both scopes where the shapes match", async () => {
    const { client, calls } = stubClient({ items: [{ id: "p1" }] });
    const mcp = await connectTools(policyTools, client);

    await callTool(mcp, "jsm_get_policy", { policy_id: "p1" });
    await callTool(mcp, "jsm_get_policy", { policy_id: "p1", team_id: TEAM });

    assert.equal(calls[0]?.path, "/v1/alerts/policies/p1");
    assert.equal(calls[1]?.path, `/v1/teams/${TEAM}/policies/p1`);
  });

  it("keeps the two list tools separate, because the team one requires a type", async () => {
    // Conditional requiredness is exactly what the collapse rule refuses: one
    // tool would have to say "required, but only sometimes".
    const names = policyTools.map((t) => t.name);
    assert.ok(names.includes("jsm_list_alert_policies"));
    assert.ok(names.includes("jsm_list_team_policies"));

    const team = policyTools.find((t) => t.name === "jsm_list_team_policies");
    assert.ok(team?.inputSchema.policy_type, "the team list must take a policy_type");
    const global = policyTools.find((t) => t.name === "jsm_list_alert_policies");
    assert.ok(!("policy_type" in global!.inputSchema), "the global list must not");
  });

  it("sends the required type parameter on a team policy list", async () => {
    const { client, calls } = stubClient({ items: [] });
    const mcp = await connectTools(policyTools, client);

    await callTool(mcp, "jsm_list_team_policies", { team_id: TEAM, policy_type: "notification" });

    assert.equal(calls[0]?.path, `/v1/teams/${TEAM}/policies`);
    assert.equal(calls[0]?.params?.type, "notification");
  });

  it("does not send `order` on a global policy, which does not declare it", async () => {
    // CreateGlobalPolicyRequest has no `order`; only the team DTOs do. A global
    // policy is repositioned through jsm_change_policy_order instead.
    const global = policyTools.find((t) => t.name === "jsm_create_alert_policy");
    assert.ok(!("order" in global!.inputSchema));
    const team = policyTools.find((t) => t.name === "jsm_create_team_policy");
    assert.ok("order" in team!.inputSchema);
  });

  it("maps snake_case inputs onto the API's camelCase body", async () => {
    const { client, calls } = stubClient({ items: [] }, { write: { id: "p1" } });
    const mcp = await connectTools(policyTools, client);

    await callTool(mcp, "jsm_create_team_policy", {
      team_id: TEAM,
      policy_type: "alert",
      name: "Downgrade noise",
      enabled: true,
      update_priority: true,
      priority_value: "P5",
      continue_processing: false,
      keep_original_tags: true,
    });

    const body = bodyOf(calls[0]);
    assert.equal(body.updatePriority, true);
    assert.equal(body.priorityValue, "P5");
    // `continue` is a reserved word, so the input is continue_processing.
    assert.equal(body.continue, false);
    assert.equal(body.keepOriginalTags, true);
    assert.ok(!("continue_processing" in body));
  });

  it("omits fields the caller did not set, rather than sending nulls", async () => {
    const { client, calls } = stubClient({ items: [] }, { write: { id: "p1" } });
    const mcp = await connectTools(policyTools, client);

    await callTool(mcp, "jsm_create_team_policy", {
      team_id: TEAM,
      policy_type: "alert",
      name: "Minimal",
      enabled: true,
    });

    assert.deepEqual(bodyOf(calls[0]), { type: "alert", name: "Minimal", enabled: true });
  });

  it("says a policy with no filter matches every alert", async () => {
    const { client } = stubClient({ items: [{ id: "p1", name: "Catch-all", type: "alert" }] });
    const mcp = await connectTools(policyTools, client);

    assert.match(
      textOf(await callTool(mcp, "jsm_list_alert_policies", {})),
      /no filter — this policy matches every alert/,
    );
  });

  it("says a suppressing notification policy pages nobody", async () => {
    const { client } = stubClient({
      items: [
        { id: "p1", name: "Quiet hours", type: "notification", suppress: true, filter: { a: 1 } },
      ],
    });
    const mcp = await connectTools(policyTools, client);

    assert.match(
      textOf(
        await callTool(mcp, "jsm_list_team_policies", {
          team_id: TEAM,
          policy_type: "notification",
        }),
      ),
      /suppresses notifications — matching alerts page nobody/,
    );
  });

  it("marks disabling destructive and enabling not", async () => {
    const off = policyTools.find((t) => t.name === "jsm_disable_policy");
    const on = policyTools.find((t) => t.name === "jsm_enable_policy");
    assert.equal(off?.annotations.destructiveHint, true);
    assert.equal(on?.annotations.destructiveHint, false);
  });

  it("reorders through the change-order sub-path in either scope", async () => {
    const { client, calls } = stubClient({ items: [] }, { write: { id: "p1", order: 3 } });
    const mcp = await connectTools(policyTools, client);

    await callTool(mcp, "jsm_change_policy_order", { policy_id: "p1", order: 3 });
    await callTool(mcp, "jsm_change_policy_order", { policy_id: "p1", team_id: TEAM, order: 3 });

    assert.equal(calls[0]?.path, "/v1/alerts/policies/p1/change-order");
    assert.equal(calls[1]?.path, `/v1/teams/${TEAM}/policies/p1/change-order`);
    assert.deepEqual(bodyOf(calls[0]), { order: 3 });
  });

  it("updates a policy with PUT, because there is no partial update", async () => {
    const { client, calls } = stubClient({ items: [] }, { write: { id: "p1" } });
    const mcp = await connectTools(policyTools, client);

    await callTool(mcp, "jsm_update_alert_policy", {
      policy_id: "p1",
      policy_type: "alert",
      name: "n",
      enabled: true,
      message: "m",
    });

    assert.equal(calls[0]?.method, "PUT");
    assert.equal(calls[0]?.path, "/v1/alerts/policies/p1");
  });
});
