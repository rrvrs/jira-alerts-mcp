/**
 * Routing rules: which alerts reach which schedule or escalation, and in what
 * order the rules are tried.
 */

import { z } from "zod";

import { renderRoutingRule, renderRoutingRules } from "../../services/render/routing.js";
import type { RoutingRule } from "../../types.js";
import { defineTool } from "../define.js";
import { executeWrite } from "../execute-write.js";
import { defineResourceFamily, type ResourceConfig } from "../family.js";
import { teamIdField } from "../teams/shapes.js";

const routingRuleIdField = z
  .string()
  .min(1)
  .describe("Routing rule id, from jsm_list_routing_rules.");

const routingWriteShape = {
  name: z.string().optional().describe("Name of the rule."),
  order: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Position in the team's rule list. Rules are evaluated in order and the first match wins, " +
        "so order is behaviour rather than presentation.",
    ),
  notify_type: z
    .enum(["escalation", "schedule", "none"])
    .describe(
      "What to route matching alerts to. 'none' is a real setting and means matching alerts are " +
        "routed nowhere — the usual way alerts get dropped by configuration rather than by fault.",
    ),
  notify_id: z
    .string()
    .optional()
    .describe("Id of the escalation or schedule. Not required when notify_type is 'none'."),
  timezone: z.string().optional().describe("IANA time zone id for this rule's time restriction."),
};

const toRoutingBody = (params: Record<string, unknown>) => ({
  name: params.name,
  order: params.order,
  timezone: params.timezone,
  notify: {
    type: params.notify_type,
    ...(params.notify_type === "none" ? {} : { id: params.notify_id }),
  },
});

const routingBodyFields = ["name", "order", "timezone", "notify"];

export const routingRuleResource: ResourceConfig = {
  toolset: "routing",
  path: "/v1/teams/{teamId}/routing-rules",
  noun: "routing_rule",
  plural: "routing_rules",
  idParam: "routing_rule_id",
  idField: routingRuleIdField,
  parents: [{ param: "team_id", token: "teamId", field: teamIdField }],
};

export const routingRuleTools = defineResourceFamily<RoutingRule>(routingRuleResource, {
  list: {
    name: "jsm_list_routing_rules",
    title: "List a team's routing rules",
    description: `List a team's routing rules, in the order they are evaluated.

Routing rules decide which schedule or escalation an alert reaches. When an alert paged nobody, or paged the wrong rotation, the explanation is almost always here.

Args:
  - team_id (string): the team, from jsm_list_teams
  - limit (number): 1-100, default 20
  - offset (number): records to skip, default 0
  - response_format ('markdown' | 'json'): default 'markdown'

Returns (json format): { "routing_rules": [ { "id": string, "name": string, "order": number, "notify": { "id": string, "type": "escalation" | "schedule" | "none" }, "criteria": {...} } ], "pagination": {...} }

Order matters: rules are evaluated in order and the first match wins, so a broad rule near the top can shadow every rule below it.

A rule with notify type 'none' matches and routes nowhere. That is called out explicitly — it looks like ordinary configuration and it is how alerts get dropped silently.`,
    render: (items) => ["# Routing rules", "", renderRoutingRules(items)].join("\n"),
    emptyMessage:
      "This team has no routing rules, so its alerts follow the default routing rather than reaching a named schedule or escalation.",
  },
  get: {
    name: "jsm_get_routing_rule",
    title: "Get one routing rule",
    description: `Read one routing rule: what it matches, where it routes, and its position.

Args:
  - team_id (string), routing_rule_id (string)
  - response_format ('markdown' | 'json'): default 'markdown'

Returns: { "routing_rule": { "id": string, "order": number, "notify": {...}, "criteria": {...} } }`,
    render: (item) => renderRoutingRule(item),
  },
  create: {
    name: "jsm_create_routing_rule",
    title: "Create a routing rule",
    description: `Create a routing rule for a team.

Args:
  - team_id (string): the owning team
  - notify_type ('escalation' | 'schedule' | 'none'): required
  - notify_id (string): the escalation or schedule id; omit only for notify_type='none'
  - name (string, optional), order (number, optional), timezone (string, optional)

Returns: { "routing_rule": { "id": string, ... } }

Synchronous.

THIS CHANGES WHO GETS PAGED. Rules are evaluated in order and the first match wins, so inserting one near the top can shadow every rule beneath it and silently redirect alerts that were reaching the right people. Read the existing rules with jsm_list_routing_rules first, and confirm the position with the user.

This tool creates a rule with no criteria, which matches everything. That is rarely what you want anywhere but the bottom of the list.`,
    input: routingWriteShape,
    toBody: toRoutingBody,
    bodyFields: routingBodyFields,
    render: (item) => renderRoutingRule(item),
  },
  update: {
    name: "jsm_update_routing_rule",
    title: "Update a routing rule",
    description: `Change a routing rule's name, target, order or timezone.

Args:
  - team_id (string), routing_rule_id (string)
  - name, order, notify_type, notify_id, timezone

Returns: { "routing_rule": { "id": string, ... } }

THIS CHANGES WHO GETS PAGED, immediately and for every matching alert. Setting notify_type='none' makes matching alerts route nowhere at all.

To move a rule up or down the list, prefer jsm_change_routing_rule_order — it is explicit about what it does.`,
    input: routingWriteShape,
    toBody: toRoutingBody,
    bodyFields: routingBodyFields,
    render: (item) => renderRoutingRule(item),
  },
  remove: {
    name: "jsm_delete_routing_rule",
    title: "Delete a routing rule",
    description: `Delete a routing rule.

Args:
  - team_id (string), routing_rule_id (string)

Returns: { "deleted": true, "routing_rule_id": string }

Alerts that matched this rule fall through to the next one, which may route them somewhere else entirely or nowhere at all. Read the full list first so you can say where they will go instead.

Requires delete:ops-config:jira-service-management. That grant belongs to the individual token rather than to API-token auth — another token on the same account can hold it — so a 401 here means reissue JSM_API_TOKEN with the delete scopes included, or supply JSM_OAUTH_TOKEN, not that token auth cannot delete. See the README.`,
  },
});

export const changeRoutingRuleOrder = defineTool({
  name: "jsm_change_routing_rule_order",
  toolset: "routing",
  endpoint: {
    method: "PATCH",
    path: "/v1/teams/{teamId}/routing-rules/{id}/change-order",
    body: ["order"],
  },
  title: "Reorder a routing rule",
  description: `Move a routing rule to a different position in its team's list.

Args:
  - team_id (string), routing_rule_id (string): the rule to move
  - order (number): its new position

Returns: { "confirmed": true, "routing_rule_id": string }

The API answers 204 with no body, so nothing about the rule comes back — re-read it with jsm_get_routing_rule if you need to show the new position.

Order is behaviour, not presentation: rules are evaluated top down and the first match wins. Moving a broad rule upwards can shadow everything below it, so alerts that were reaching one rotation start reaching another with no other change.

Read jsm_list_routing_rules first and say what the new order will be before calling this.`,
  inputSchema: {
    team_id: teamIdField,
    routing_rule_id: routingRuleIdField,
    order: z.number().int().min(0).describe("The rule's new position in the list."),
  },
  outputSchema: { confirmed: z.boolean(), routing_rule_id: z.string() },
  annotations: {
    readOnlyHint: false,
    // Reordering silently changes which alerts reach whom.
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (params, client) =>
    executeWrite<RoutingRule>(client, {
      label: "Reorder routing rule",
      method: "PATCH",
      path:
        `/v1/teams/${encodeURIComponent(params.team_id)}/routing-rules/` +
        `${encodeURIComponent(params.routing_rule_id)}/change-order`,
      body: { order: params.order },
      // 204, no body. Declaring the updated rule as the output made every call
      // fail validation with "expected object, received string" — verified
      // against a live tenant on 2026-09-05.
      mode: "confirmed",
      subject: { key: "routing_rule_id", value: params.routing_rule_id, noun: "routing rule" },
    }),
});
