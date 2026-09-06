/**
 * Forwarding rules: one person's notifications sent to another for a period.
 *
 * Updated with PUT against CreateForwardingRuleRequest — there is no partial
 * update, so every field goes every time.
 */

import { z } from "zod";

import { renderForwardingRule, renderForwardingRules } from "../../services/render/routing.js";
import type { ForwardingRule } from "../../types.js";
import { defineResourceFamily, type ResourceConfig } from "../family.js";

const forwardingWriteShape = {
  from_user_id: z
    .string()
    .min(1)
    .describe("Account id whose notifications are being forwarded away."),
  to_user_id: z.string().min(1).describe("Account id that will receive them instead."),
  start_date: z.string().describe("ISO 8601 instant the forwarding starts."),
  end_date: z
    .string()
    .describe("ISO 8601 instant it stops. Required — forwarding cannot be open-ended."),
};

const toForwardingBody = (params: Record<string, unknown>) => ({
  fromUserId: params.from_user_id,
  toUserId: params.to_user_id,
  startDate: params.start_date,
  endDate: params.end_date,
});

const forwardingBodyFields = ["fromUserId", "toUserId", "startDate", "endDate"];

export const forwardingResource: ResourceConfig = {
  toolset: "forwarding",
  path: "/v1/forwarding-rules",
  noun: "forwarding_rule",
  plural: "forwarding_rules",
  idParam: "forwarding_rule_id",
  idField: z.string().min(1).describe("Forwarding rule id, from jsm_list_forwarding_rules."),
  updateMethod: "PUT",
};

export const forwardingTools = defineResourceFamily<ForwardingRule>(forwardingResource, {
  list: {
    name: "jsm_list_forwarding_rules",
    title: "List notification forwarding rules",
    description: `List forwarding rules — periods where one person's notifications go to somebody else.

This is the other reason the person a schedule names is not the person actually being notified. If someone on call says they were never told, check overrides on the schedule and forwarding rules here.

Args:
  - show_all (boolean, optional): include rules belonging to other users, not just the credentials' own
  - limit (number): 1-100, default 20
  - offset (number): records to skip, default 0
  - response_format ('markdown' | 'json'): default 'markdown'

Returns (json format): { "forwarding_rules": [ { "id": string, "fromUser": {...}, "toUser": {...}, "startDate": string, "endDate": string } ], "pagination": {...} }

By default this shows only the credentials' own rules. Pass show_all=true when investigating on someone else's behalf, or you will conclude there is no forwarding when there is.`,
    query: {
      show_all: z
        .boolean()
        .optional()
        .describe("Include every user's forwarding rules, not just the credentials' own."),
    },
    queryFields: ["showAll"],
    toParams: (params) => ({ showAll: params.show_all }),
    render: (items) => ["# Forwarding rules", "", renderForwardingRules(items)].join("\n"),
    emptyMessage:
      "No forwarding rules found. Note this shows only your own rules unless you pass show_all=true.",
  },
  get: {
    name: "jsm_get_forwarding_rule",
    title: "Get one forwarding rule",
    description: `Read one forwarding rule: who is forwarding to whom, and for how long.

Args:
  - forwarding_rule_id (string)
  - response_format ('markdown' | 'json'): default 'markdown'

Returns: { "forwarding_rule": { "id": string, "fromUser": {...}, "toUser": {...}, "startDate": string, "endDate": string } }`,
    render: (item) => renderForwardingRule(item),
  },
  create: {
    name: "jsm_create_forwarding_rule",
    title: "Forward someone's notifications",
    description: `Forward one person's notifications to another for a period.

Args:
  - from_user_id (string): whose notifications are being forwarded away
  - to_user_id (string): who receives them instead
  - start_date (string), end_date (string): the ISO 8601 window — all four are required

Returns: { "forwarding_rule": { "id": string, ... } }

Synchronous.

Check the direction before calling: from_user_id stops being notified and to_user_id starts. Getting them the wrong way round silently removes the wrong person from the on-call path, and looks like nothing happened.

If the window has already started, this takes effect immediately.`,
    input: forwardingWriteShape,
    toBody: toForwardingBody,
    bodyFields: forwardingBodyFields,
    render: (item) => renderForwardingRule(item),
  },
  update: {
    name: "jsm_update_forwarding_rule",
    title: "Update a forwarding rule",
    description: `Change a forwarding rule's people or its window.

Args:
  - forwarding_rule_id (string): the rule to change
  - from_user_id, to_user_id, start_date, end_date: all required

Returns: { "forwarding_rule": { "id": string, ... } }

This is a PUT and takes the whole rule — there is no partial update, so all four fields go every time. Read the current values with jsm_get_forwarding_rule unless you mean to set all of them.`,
    input: forwardingWriteShape,
    toBody: toForwardingBody,
    bodyFields: forwardingBodyFields,
    render: (item) => renderForwardingRule(item),
  },
  remove: {
    name: "jsm_delete_forwarding_rule",
    title: "Delete a forwarding rule",
    description: `Delete a forwarding rule, so notifications go back to the original person.

Args:
  - forwarding_rule_id (string)

Returns: { "deleted": true, "forwarding_rule_id": string }

If the rule is currently active, this changes who is notified immediately — the original person starts being paged again. That is usually the intent, but say so when reporting back.

Requires delete:ops-config:jira-service-management, which Atlassian account API tokens do not carry — see the README.`,
  },
});
