/**
 * Shared shapes for alert and notification policies.
 *
 * The API models both as one endpoint with a `type` discriminator, and both
 * DTOs mark every field optional. `filter`, `timeRestriction` and the action
 * objects are typed as bare `object` in the spec with no further schema, so
 * they are accepted as records here and their descriptions point at reading an
 * existing policy — inventing a shape for them would be guessing in a place
 * where a wrong guess silently changes which alerts match.
 */

import { z } from "zod";

export const policyIdField = z
  .string()
  .min(1)
  .describe("Policy id, from jsm_list_alert_policies or jsm_list_team_policies.");

export const policyTypeField = z
  .enum(["alert", "notification"])
  .describe(
    "Which kind of policy. An alert policy rewrites alerts as they arrive (priority, message, " +
      "tags); a notification policy changes whether and when they notify anyone.",
  );

const openObject = z
  .record(z.string(), z.unknown())
  .describe(
    "The API types this as a bare object with no schema of its own. Read an existing policy with " +
      "the matching get tool and follow the shape it returns rather than inventing one.",
  );

/** Fields both policy types share. */
export const policyCommonShape = {
  name: z.string().min(1).describe("Name of the policy."),
  description: z.string().optional().describe("What this policy is for."),
  enabled: z.boolean().describe("Required. A disabled policy has no effect on any alert."),
  filter: openObject
    .optional()
    .describe(
      "Which alerts this policy applies to. Omitting it matches EVERY alert — read an existing " +
        "policy's filter and follow its shape rather than leaving this out.",
    ),
  time_restriction: openObject.optional().describe("When this policy is active, if not always."),
};

/** Fields only an alert policy uses. */
export const alertPolicyShape = {
  alias: z.string().optional().describe("Overrides the alert's deduplication alias."),
  message: z.string().optional().describe("Rewrites the alert's message."),
  alert_description: z.string().optional().describe("Rewrites the alert's description."),
  source: z.string().optional().describe("Rewrites the alert's source."),
  entity: z.string().optional().describe("Rewrites the alert's entity."),
  responders: z.array(z.string()).optional().describe("Responder ids to set on matching alerts."),
  actions: z.array(z.string()).optional().describe("Custom action names to set."),
  tags: z.array(z.string()).optional().describe("Tags to set on matching alerts."),
  details: openObject.optional().describe("Extra properties to set on matching alerts."),
  continue_processing: z
    .boolean()
    .optional()
    .describe(
      "Whether later policies still apply after this one matches. False stops the chain here, " +
        "which is how one policy silently disables every policy beneath it.",
    ),
  update_priority: z
    .boolean()
    .optional()
    .describe("Whether to rewrite the alert's priority to priority_value."),
  priority_value: z
    .enum(["P1", "P2", "P3", "P4", "P5"])
    .optional()
    .describe(
      "The priority to set when update_priority is true. Lowering priority can take an alert out " +
        "of the escalation path entirely.",
    ),
  keep_original_responders: z.boolean().optional().describe("Add responders rather than replace."),
  keep_original_details: z.boolean().optional().describe("Merge details rather than replace."),
  keep_original_actions: z.boolean().optional().describe("Merge actions rather than replace."),
  keep_original_tags: z.boolean().optional().describe("Merge tags rather than replace."),
};

/**
 * Position in the list. Team policies carry it; CreateGlobalPolicyRequest does
 * not declare it at all, so a global policy is repositioned only through
 * jsm_change_policy_order. Caught by the drift guard rather than by review.
 */
export const policyOrderShape = {
  order: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Position in the policy list. Policies are applied in order, so this is behaviour rather " +
        "than presentation.",
    ),
};

/** Fields only a notification policy uses. */
export const notificationPolicyShape = {
  suppress: z
    .boolean()
    .optional()
    .describe(
      "Suppress notifications for matching alerts entirely. The alert is still created and still " +
        "appears in the queue — it simply pages nobody, which is the quietest and most easily " +
        "missed configuration in the API.",
    ),
  delay_action: openObject.optional().describe("Delay notifications for matching alerts."),
  deduplication_action: openObject.optional().describe("Deduplicate matching alerts."),
  auto_close_action: openObject.optional().describe("Automatically close matching alerts."),
  auto_restart_action: openObject.optional().describe("Automatically restart notifications."),
};

/** Maps the snake_case inputs onto the API's camelCase body. */
export function toPolicyBody(params: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    type: params.policy_type,
    name: params.name,
    description: params.description,
    enabled: params.enabled,
    order: params.order,
    filter: params.filter,
    timeRestriction: params.time_restriction,
    alias: params.alias,
    message: params.message,
    alertDescription: params.alert_description,
    source: params.source,
    entity: params.entity,
    responders: params.responders,
    actions: params.actions,
    tags: params.tags,
    details: params.details,
    continue: params.continue_processing,
    updatePriority: params.update_priority,
    priorityValue: params.priority_value,
    keepOriginalResponders: params.keep_original_responders,
    keepOriginalDetails: params.keep_original_details,
    keepOriginalActions: params.keep_original_actions,
    keepOriginalTags: params.keep_original_tags,
    suppress: params.suppress,
    delayAction: params.delay_action,
    deduplicationAction: params.deduplication_action,
    autoCloseAction: params.auto_close_action,
    autoRestartAction: params.auto_restart_action,
  };
  // Undefined values are dropped by JSON.stringify anyway; removing them here
  // keeps the wire payload readable in tests and logs.
  for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key];
  return body;
}

export const policyBodyFields = [
  "type",
  "name",
  "description",
  "enabled",
  "filter",
  "timeRestriction",
  "alias",
  "message",
  "alertDescription",
  "source",
  "entity",
  "responders",
  "actions",
  "tags",
  "details",
  "continue",
  "updatePriority",
  "priorityValue",
  "keepOriginalResponders",
  "keepOriginalDetails",
  "keepOriginalActions",
  "keepOriginalTags",
];

/** Team policies additionally carry `order` in the body. */
export const teamPolicyBodyFields = [
  "order",
  "suppress",
  "delayAction",
  "deduplicationAction",
  "autoCloseAction",
  "autoRestartAction",
];
