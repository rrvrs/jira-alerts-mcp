/**
 * Escalations: who gets woken next when nobody acknowledges, and after how long.
 */

import { z } from "zod";

import { renderEscalation, renderEscalations } from "../../services/render/routing.js";
import type { Escalation } from "../../types.js";
import { defineResourceFamily, type ResourceConfig } from "../family.js";
import { teamIdField } from "../teams/shapes.js";

const escalationWriteShape = {
  name: z.string().min(1).describe("Name of the escalation policy."),
  description: z.string().optional().describe("What this escalation is for."),
  enabled: z
    .boolean()
    .optional()
    .describe("A disabled escalation never fires, so unacknowledged alerts go no further."),
  rules: z
    .array(
      z.object({
        condition: z
          .enum(["if-not-acked", "if-not-closed"])
          .describe("What has to still be true for this step to fire."),
        notify_type: z
          .enum(["default", "next", "previous", "users", "admins", "all", "random"])
          .describe(
            "Which members of the recipient to notify. 'default' means whoever the recipient " +
              "resolves to — usually what you want.",
          ),
        delay: z
          .number()
          .int()
          .min(0)
          .describe("Minutes to wait after the alert before this step fires."),
        recipient_id: z.string().optional().describe("Id of the user, schedule or team to notify."),
        recipient_type: z
          .enum(["user", "schedule", "team"])
          .describe("What recipient_id refers to."),
      }),
    )
    .min(1, "an escalation with no rules notifies nobody")
    .describe(
      "The escalation steps, each with its own delay. Delays are measured from the alert, not " +
        "from the previous step — two steps at delay 5 fire together rather than five minutes apart.",
    ),
};

const toEscalationBody = (params: Record<string, unknown>) => ({
  name: params.name,
  description: params.description,
  enabled: params.enabled,
  rules: (params.rules as Array<Record<string, unknown>> | undefined)?.map((rule) => ({
    condition: rule.condition,
    notifyType: rule.notify_type,
    delay: rule.delay,
    recipient: { id: rule.recipient_id, type: rule.recipient_type },
  })),
});

const escalationBodyFields = ["name", "description", "enabled", "rules"];

export const escalationResource: ResourceConfig = {
  toolset: "routing",
  path: "/v1/teams/{teamId}/escalations",
  noun: "escalation",
  plural: "escalations",
  idParam: "escalation_id",
  idField: z.string().min(1).describe("Escalation id, from jsm_list_escalations."),
  parents: [{ param: "team_id", token: "teamId", field: teamIdField }],
};

export const escalationTools = defineResourceFamily<Escalation>(escalationResource, {
  list: {
    name: "jsm_list_escalations",
    title: "List a team's escalations",
    description: `List a team's escalation policies — what happens when an alert goes unacknowledged.

This is the answer to "who gets woken if the first responder misses it, and when". jsm_escalate_alert takes an escalation id from here.

Args:
  - team_id (string): the team, from jsm_list_teams
  - limit (number): 1-100, default 20
  - offset (number): records to skip, default 0
  - response_format ('markdown' | 'json'): default 'markdown'

Returns (json format): { "escalations": [ { "id": string, "name": string, "enabled": boolean, "rules": [ { "condition": string, "delay": number, "notifyType": string, "recipient": {...} } ] } ], "pagination": {...} }

An escalation with no rules notifies nobody, and a disabled one never fires at all. Both are called out, because both look like an ordinary configuration and mean that nothing happens when an alert is missed.`,
    render: (items) => ["# Escalations", "", renderEscalations(items)].join("\n"),
    emptyMessage:
      "This team has no escalations, so an unacknowledged alert goes no further than its first responder.",
  },
  get: {
    name: "jsm_get_escalation",
    title: "Get one escalation",
    description: `Read one escalation policy: every step, its delay, and who it notifies.

Args:
  - team_id (string), escalation_id (string)
  - response_format ('markdown' | 'json'): default 'markdown'

Returns: { "escalation": { "id": string, "name": string, "rules": [...] } }

Delays are measured from the alert rather than from the previous step, so two rules with the same delay fire together.`,
    render: (item) => renderEscalation(item),
  },
  create: {
    name: "jsm_create_escalation",
    title: "Create an escalation",
    description: `Create an escalation policy for a team.

Args:
  - team_id (string): the owning team
  - name (string): required
  - rules (array): required — [{ condition, notify_type, delay, recipient_id, recipient_type }]
  - description (string, optional), enabled (boolean, optional)

Returns: { "escalation": { "id": string, ... } }

Synchronous.

Each rule's \`delay\` is minutes from the alert, not from the previous step. A policy meant to try the primary at 0, the secondary at 10 and the manager at 20 uses delays 0, 10 and 20 — not 0, 10 and 10.

Creating an escalation does not route anything to it. A routing rule has to name it, or it never fires.`,
    input: escalationWriteShape,
    toBody: toEscalationBody,
    bodyFields: escalationBodyFields,
    render: (item) => renderEscalation(item),
  },
  update: {
    name: "jsm_update_escalation",
    title: "Update an escalation",
    description: `Change an escalation's name, rules or enabled flag.

Args:
  - team_id (string), escalation_id (string)
  - name, description, enabled, rules

Returns: { "escalation": { "id": string, ... } }

IMPORTANT: \`rules\` replaces the whole list — read the current ones with jsm_get_escalation and send them back with your change, or the steps you left out stop firing.

Setting enabled=false stops unacknowledged alerts escalating at all. That is a real change to who gets woken; confirm it before doing it to a live policy.`,
    input: escalationWriteShape,
    toBody: toEscalationBody,
    bodyFields: escalationBodyFields,
    render: (item) => renderEscalation(item),
  },
  remove: {
    name: "jsm_delete_escalation",
    title: "Delete an escalation",
    description: `Delete an escalation policy.

Args:
  - team_id (string), escalation_id (string)

Returns: { "deleted": true, "escalation_id": string }

Any routing rule pointing at this escalation stops escalating, and unacknowledged alerts then go no further than their first responder. Check jsm_list_routing_rules for references before deleting, and prefer enabled=false if you only want to pause it.

Requires delete:ops-config:jira-service-management, which Atlassian account API tokens do not carry — see the README.`,
  },
});
