/**
 * Notification rules and their steps: what one person is told about, through
 * which contact method, and after how long.
 */

import { z } from "zod";

import {
  renderNotificationRule,
  renderNotificationRules,
  renderNotificationStep,
  renderNotificationSteps,
} from "../../services/render/routing.js";
import type { NotificationRule, NotificationRuleStep } from "../../types.js";
import { defineResourceFamily, type ResourceConfig } from "../family.js";

const ruleIdField = z
  .string()
  .min(1)
  .describe("Notification rule id, from jsm_list_notification_rules.");

const notificationWriteShape = {
  name: z.string().min(1).describe("Name of the rule."),
  action_type: z
    .enum([
      "create-alert",
      "acknowledged-alert",
      "closed-alert",
      "assigned-alert",
      "add-note",
      "schedule-start",
      "schedule-end",
      "incoming-call-routing",
    ])
    .describe("Which event this rule reacts to. 'create-alert' is the one that pages people."),
  enabled: z
    .boolean()
    .describe("Required. A disabled rule notifies nobody, however many steps it has."),
  order: z.number().int().min(0).optional().describe("Position among the user's rules."),
  schedules: z
    .array(z.string())
    .optional()
    .describe("Restrict the rule to particular schedules, by id. Omit to apply to all of them."),
};

const toNotificationBody = (params: Record<string, unknown>) => ({
  name: params.name,
  actionType: params.action_type,
  enabled: params.enabled,
  order: params.order,
  schedules: params.schedules,
});

const notificationBodyFields = ["name", "actionType", "enabled", "order", "schedules"];

export const notificationRuleResource: ResourceConfig = {
  toolset: "routing",
  path: "/v1/notification-rules",
  noun: "notification_rule",
  plural: "notification_rules",
  idParam: "notification_rule_id",
  idField: ruleIdField,
};

export const notificationRuleTools = defineResourceFamily<NotificationRule>(
  notificationRuleResource,
  {
    list: {
      name: "jsm_list_notification_rules",
      title: "List notification rules",
      description: `List the notification rules on the account the credentials belong to — what this person is told about, and when.

Routing decides which team an alert reaches; these decide whether the individual actually hears about it. Both have to line up for someone to be paged.

Args:
  - limit (number): 1-100, default 20
  - offset (number): records to skip, default 0
  - response_format ('markdown' | 'json'): default 'markdown'

Returns (json format): { "notification_rules": [ { "id": string, "name": string, "actionType": string, "enabled": boolean, "steps": [...] } ], "pagination": {...} }

These belong to the credentials' own account. There is no parameter for reading somebody else's, so you cannot answer "why wasn't Priya notified?" from here with a shared token.

A disabled rule notifies nobody however many steps it has, and is marked as such.`,
      render: (items) => ["# Notification rules", "", renderNotificationRules(items)].join("\n"),
      emptyMessage:
        "No notification rules on this account, which means nothing here decides how this person is told about alerts.",
    },
    get: {
      name: "jsm_get_notification_rule",
      title: "Get one notification rule",
      description: `Read one notification rule: what it fires on and how it notifies.

Args:
  - notification_rule_id (string)
  - response_format ('markdown' | 'json'): default 'markdown'

Returns: { "notification_rule": { "id": string, "name": string, "actionType": string, "enabled": boolean, "steps": [...] } }

The steps carry the actual contact methods and delays; jsm_list_notification_steps reads them individually.`,
      render: (item) => renderNotificationRule(item),
    },
    create: {
      name: "jsm_create_notification_rule",
      title: "Create a notification rule",
      description: `Create a notification rule on the credentials' own account.

Args:
  - name (string), action_type (string), enabled (boolean): all required
  - order (number, optional), schedules (string[], optional)

Returns: { "notification_rule": { "id": string, ... } }

Synchronous.

A rule created here has no steps, so it notifies nobody until you add one with jsm_create_notification_step. That two-step shape is the same as schedules and rotations.

'create-alert' is the action type that pages people; the others react to something that has already happened.`,
      input: notificationWriteShape,
      toBody: toNotificationBody,
      bodyFields: notificationBodyFields,
      render: (item) => renderNotificationRule(item),
    },
    update: {
      name: "jsm_update_notification_rule",
      title: "Update a notification rule",
      description: `Change a notification rule's name, event, order, schedules or enabled flag.

Args:
  - notification_rule_id (string)
  - name, action_type, enabled: required
  - order, schedules: optional

Returns: { "notification_rule": { "id": string, ... } }

Setting enabled=false stops this person being notified through this rule, silently. That is the reversible way to mute someone who is on leave, and an easy one to forget to undo.`,
      input: notificationWriteShape,
      toBody: toNotificationBody,
      bodyFields: notificationBodyFields,
      render: (item) => renderNotificationRule(item),
    },
    remove: {
      name: "jsm_delete_notification_rule",
      title: "Delete a notification rule",
      description: `Delete a notification rule and every step in it.

Args:
  - notification_rule_id (string)

Returns: { "deleted": true, "notification_rule_id": string }

This person then hears nothing for the event the rule covered. jsm_update_notification_rule with enabled=false is the reversible alternative.

Requires delete:ops-config:jira-service-management, which Atlassian account API tokens do not carry — see the README.`,
    },
  },
);

const stepWriteShape = {
  contact_method: z
    .enum(["email", "sms", "voice", "mobile"])
    .describe("Which contact method to use. It must already exist — see jsm_list_contacts."),
  contact_to: z
    .string()
    .min(1)
    .describe("The address or number, matching an existing contact method on the account."),
  send_after: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Minutes to wait after the event before this step notifies. 0 is immediate."),
  enabled: z.boolean().describe("Required. A disabled step sends nothing."),
};

const toStepBody = (params: Record<string, unknown>) => ({
  contact: { method: params.contact_method, to: params.contact_to },
  sendAfter: params.send_after,
  enabled: params.enabled,
});

const stepBodyFields = ["contact", "sendAfter", "enabled"];

export const notificationStepResource: ResourceConfig = {
  toolset: "routing",
  path: "/v1/notification-rules/{ruleId}/steps",
  noun: "notification_step",
  plural: "notification_steps",
  idParam: "step_id",
  idField: z.string().min(1).describe("Step id, from jsm_list_notification_steps."),
  parents: [{ param: "notification_rule_id", token: "ruleId", field: ruleIdField }],
};

export const notificationStepTools = defineResourceFamily<NotificationRuleStep>(
  notificationStepResource,
  {
    list: {
      name: "jsm_list_notification_steps",
      title: "List the steps of a notification rule",
      description: `List a notification rule's steps — the contact methods it uses and how long it waits before each.

Args:
  - notification_rule_id (string): the rule
  - limit (number): 1-100, default 20
  - offset (number): records to skip, default 0
  - response_format ('markdown' | 'json'): default 'markdown'

Returns (json format): { "notification_steps": [ { "id": string, "sendAfter": number, "enabled": boolean, "contact": { "method": string, "to": string } } ], "pagination": {...} }

A rule with no enabled steps notifies nobody, whatever the rule itself says. Disabled steps are marked.`,
      render: (steps) => ["# Notification steps", "", renderNotificationSteps(steps)].join("\n"),
      emptyMessage:
        "This rule has no steps, so it notifies nobody. Add one with jsm_create_notification_step.",
    },
    get: {
      name: "jsm_get_notification_step",
      title: "Get one notification step",
      description: `Read one step of a notification rule.

Args:
  - notification_rule_id (string), step_id (string)
  - response_format ('markdown' | 'json'): default 'markdown'

Returns: { "notification_step": { "id": string, "sendAfter": number, "enabled": boolean, "contact": {...} } }`,
      render: (step) => renderNotificationStep(step),
    },
    create: {
      name: "jsm_create_notification_step",
      title: "Add a step to a notification rule",
      description: `Add a step to a notification rule: notify one contact method, after a delay.

Args:
  - notification_rule_id (string): the rule to add to
  - contact_method ('email' | 'sms' | 'voice' | 'mobile'), contact_to (string): required
  - enabled (boolean): required
  - send_after (number, optional): minutes to wait; 0 notifies immediately

Returns: { "notification_step": { "id": string, ... } }

Synchronous.

The contact method has to already exist on the account — check jsm_list_contacts first. A step naming an address that is not a registered contact method is accepted and then delivers nothing.

Steps are how a rule escalates through someone's own devices: email at 0, SMS at 5, voice at 10.`,
      input: stepWriteShape,
      toBody: toStepBody,
      bodyFields: stepBodyFields,
      render: (step) => renderNotificationStep(step),
    },
    update: {
      name: "jsm_update_notification_step",
      title: "Update a notification step",
      description: `Change a step's contact method, delay or enabled flag.

Args:
  - notification_rule_id (string), step_id (string)
  - contact_method, contact_to, enabled: required
  - send_after (number, optional)

Returns: { "notification_step": { "id": string, ... } }

Disabling a step is silent: the rule still exists and still looks configured, and that contact method simply stops being used.`,
      input: stepWriteShape,
      toBody: toStepBody,
      bodyFields: stepBodyFields,
      render: (step) => renderNotificationStep(step),
    },
    remove: {
      name: "jsm_delete_notification_step",
      title: "Delete a notification step",
      description: `Delete a step from a notification rule.

Args:
  - notification_rule_id (string), step_id (string)

Returns: { "deleted": true, "step_id": string }

Removing the last step leaves a rule that notifies nobody while still appearing enabled. Check jsm_list_notification_steps first.

Requires delete:ops-config:jira-service-management, which Atlassian account API tokens do not carry — see the README.`,
    },
  },
);
