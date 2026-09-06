/**
 * Tests for the routing toolset.
 *
 * The theme is that every silent "notifies nobody" state has to be visible.
 * Each of these is ordinary-looking configuration that means an alert reaches
 * no one, and each one renders as a field rather than as a problem unless the
 * renderer says so.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { routingTools } from "./index.js";
import { callTool, connectTools, stubClient, textOf } from "../test-support.js";

const TEAM = "00dfafff-17de-4e19-8906-6487cd17c9aa";

function bodyOf(made: { body?: unknown } | undefined): Record<string, unknown> {
  assert.ok(made, "expected the tool to issue a request");
  return made.body as Record<string, unknown>;
}

describe("routing toolset", () => {
  it("nests escalation rules the way the API spells them", async () => {
    const { client, calls } = stubClient({ items: [] }, { write: { id: "e1" } });
    const mcp = await connectTools(routingTools, client);

    await callTool(mcp, "jsm_create_escalation", {
      team_id: TEAM,
      name: "Primary",
      rules: [
        {
          condition: "if-not-acked",
          notify_type: "default",
          delay: 10,
          recipient_id: "s1",
          recipient_type: "schedule",
        },
      ],
    });

    assert.deepEqual(bodyOf(calls[0]).rules, [
      {
        condition: "if-not-acked",
        notifyType: "default",
        delay: 10,
        recipient: { id: "s1", type: "schedule" },
      },
    ]);
  });

  it("says an escalation with no rules notifies nobody", async () => {
    const { client } = stubClient({ items: [{ id: "e1", name: "Primary", rules: [] }] });
    const mcp = await connectTools(routingTools, client);

    assert.match(
      textOf(await callTool(mcp, "jsm_list_escalations", { team_id: TEAM })),
      /no rules — this escalation notifies nobody/,
    );
  });

  it("refuses an escalation with no rules", async () => {
    const { client, calls } = stubClient({ items: [] }, { write: {} });
    const mcp = await connectTools(routingTools, client);

    const result = await callTool(mcp, "jsm_create_escalation", {
      team_id: TEAM,
      name: "Primary",
      rules: [],
    });

    assert.equal(result.isError, true);
    assert.equal(calls.length, 0);
  });

  it("omits the notify id when a routing rule routes nowhere", async () => {
    // notify type 'none' is a real setting: the rule matches and routes
    // nowhere. Sending an id alongside it would describe a target it has not.
    const { client, calls } = stubClient({ items: [] }, { write: { id: "r1" } });
    const mcp = await connectTools(routingTools, client);

    await callTool(mcp, "jsm_create_routing_rule", { team_id: TEAM, notify_type: "none" });

    assert.deepEqual(bodyOf(calls[0]).notify, { type: "none" });
  });

  it("says a routing rule with notify 'none' drops matching alerts", async () => {
    const { client } = stubClient({
      items: [{ id: "r1", name: "Catch-all", notify: { type: "none" } }],
    });
    const mcp = await connectTools(routingTools, client);

    assert.match(
      textOf(await callTool(mcp, "jsm_list_routing_rules", { team_id: TEAM })),
      /routed nowhere/,
    );
  });

  it("marks reordering destructive, because order is behaviour", async () => {
    // Rules are evaluated top down and the first match wins, so moving one
    // silently changes which alerts reach whom.
    const reorder = routingTools.find((t) => t.name === "jsm_change_routing_rule_order");
    assert.equal(reorder?.annotations.destructiveHint, true);
  });

  it("reorders through the change-order sub-path", async () => {
    const { client, calls } = stubClient({ items: [] }, { write: { id: "r1", order: 2 } });
    const mcp = await connectTools(routingTools, client);

    await callTool(mcp, "jsm_change_routing_rule_order", {
      team_id: TEAM,
      routing_rule_id: "r1",
      order: 2,
    });

    assert.equal(calls[0]?.method, "PATCH");
    assert.equal(calls[0]?.path, `/v1/teams/${TEAM}/routing-rules/r1/change-order`);
    assert.deepEqual(bodyOf(calls[0]), { order: 2 });
  });

  it("survives the 204 the reorder endpoint actually returns", async () => {
    // This shipped broken. The endpoint answers 204 with no body, which
    // deserialises to an empty string, and the tool declared the updated rule
    // as its output — so every call died on the SDK's own output validation
    // with "expected object, received string". The old test stubbed an object
    // the API never sends, which is exactly why it passed.
    const { client } = stubClient({ items: [] }, { write: "" });
    const mcp = await connectTools(routingTools, client);

    const result = await callTool(mcp, "jsm_change_routing_rule_order", {
      team_id: TEAM,
      routing_rule_id: "r1",
      order: 2,
    });

    assert.ok(!result.isError, textOf(result));
    assert.deepEqual(result.structuredContent, { confirmed: true, routing_rule_id: "r1" });
    // Not `deleted` — a model reading that would report the rule as removed.
    assert.ok(!("deleted" in (result.structuredContent ?? {})));
  });

  it("maps show_all onto the API's own parameter name", async () => {
    const { client, calls } = stubClient({ items: [] });
    const mcp = await connectTools(routingTools, client);

    await callTool(mcp, "jsm_list_forwarding_rules", { show_all: true });

    assert.equal(calls[0]?.params?.showAll, true);
    assert.ok(!("show_all" in (calls[0]?.params ?? {})));
  });

  it("updates a forwarding rule with PUT, not PATCH", async () => {
    const { client, calls } = stubClient({ items: [] }, { write: { id: "f1" } });
    const mcp = await connectTools(routingTools, client);

    await callTool(mcp, "jsm_update_forwarding_rule", {
      forwarding_rule_id: "f1",
      from_user_id: "a",
      to_user_id: "b",
      start_date: "2026-09-06T09:00:00Z",
      end_date: "2026-09-07T09:00:00Z",
    });

    assert.equal(calls[0]?.method, "PUT");
  });

  it("nests a notification step's contact the way the API spells it", async () => {
    const { client, calls } = stubClient({ items: [] }, { write: { id: "s1" } });
    const mcp = await connectTools(routingTools, client);

    await callTool(mcp, "jsm_create_notification_step", {
      notification_rule_id: "n1",
      contact_method: "sms",
      contact_to: "+100",
      send_after: 5,
      enabled: true,
    });

    assert.equal(calls[0]?.path, "/v1/notification-rules/n1/steps");
    assert.deepEqual(bodyOf(calls[0]).contact, { method: "sms", to: "+100" });
    assert.equal(bodyOf(calls[0]).sendAfter, 5);
  });

  it("marks a disabled notification step as sending nothing", async () => {
    const { client } = stubClient({
      items: [{ id: "s1", enabled: false, sendAfter: 0, contact: { method: "sms", to: "+100" } }],
    });
    const mcp = await connectTools(routingTools, client);

    assert.match(
      textOf(await callTool(mcp, "jsm_list_notification_steps", { notification_rule_id: "n1" })),
      /this step sends nothing/,
    );
  });
});
