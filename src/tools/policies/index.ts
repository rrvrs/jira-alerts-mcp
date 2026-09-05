/**
 * Alert and notification policies: what happens to an alert between arriving
 * and reaching anyone.
 *
 * The API offers these twice, globally under /v1/alerts/policies and per team
 * under /v1/teams/{teamId}/policies. Five of the eight operations have
 * identical shapes across the two and are collapsed into one tool with an
 * optional team_id. Three are not: the team list *requires* a `type` query
 * parameter the global one does not accept, and create and update differ in
 * which fields are required. That is conditional requiredness, which the
 * collapse rule exists to refuse — so those ship as separate, specific tools
 * rather than one tool whose description has to explain when half its
 * parameters apply.
 */

import { z } from "zod";

import { renderPolicies, renderPolicy } from "../../services/render/policies.js";
import type { Policy } from "../../types.js";
import { limitField, offsetField, responseFormatField } from "../../schemas/common.js";
import { paginationOutputShape } from "../../schemas/common.js";
import { type AnyToolDefinition, defineTool } from "../define.js";
import { executeList } from "../list-executor.js";
import { executeWrite } from "../execute-write.js";
import { defineResourceFamily, type ResourceConfig } from "../family.js";
import { teamIdField } from "../teams/shapes.js";
import {
  alertPolicyShape,
  policyOrderShape,
  teamPolicyBodyFields,
  notificationPolicyShape,
  policyBodyFields,
  policyCommonShape,
  policyIdField,
  policyTypeField,
  toPolicyBody,
} from "./shapes.js";

const GLOBAL = "/v1/alerts/policies";
const TEAM = "/v1/teams/{teamId}/policies";

const scopeField = teamIdField
  .optional()
  .describe(
    "Team whose policies to work with. Omit for site-wide alert policies — the two are separate " +
      "collections, and a global policy is not visible through the team endpoint.",
  );

const policyOutput = { policy: z.object({}).passthrough() };

const basePath = (teamId: string | undefined) =>
  teamId === undefined ? GLOBAL : `/v1/teams/${encodeURIComponent(teamId)}/policies`;

/** get, delete, change-order, enable and disable: identical across both scopes. */
export const policyResource: ResourceConfig = {
  toolset: "policies",
  path: GLOBAL,
  noun: "policy",
  plural: "policies",
  idParam: "policy_id",
  idField: policyIdField,
  itemToken: "policyId",
  scoped: { path: TEAM, parent: { param: "team_id", token: "teamId", field: scopeField } },
};

const sharedPolicyTools = defineResourceFamily<Policy>(policyResource, {
  get: {
    name: "jsm_get_policy",
    title: "Get one policy",
    description: `Read one alert or notification policy in full: what it matches and what it does.

Args:
  - policy_id (string): the policy
  - team_id (string, optional): for a team policy rather than a site-wide one
  - response_format ('markdown' | 'json'): default 'markdown'

Returns: { "policy": { "id": string, "type": string, "name": string, "enabled": boolean, "order": number, "filter": {...} } }

Read this before creating or updating a policy: \`filter\`, \`timeRestriction\` and the action objects have no published schema, and copying the shape of one that works is far more reliable than guessing.

Two things are called out because they look like ordinary fields: a policy with no filter matches every alert, and a notification policy with suppress=true means matching alerts page nobody.`,
    render: (item) => renderPolicy(item),
  },
  remove: {
    name: "jsm_delete_policy",
    title: "Delete a policy",
    description: `Permanently delete an alert or notification policy.

Args:
  - policy_id (string), team_id (string, optional)

Returns: { "deleted": true, "policy_id": string }

Alerts that this policy was rewriting or suppressing revert to whatever the remaining policies do, which may mean they start paging people who were not being paged before. Read it with jsm_get_policy first so you can say what changes.

jsm_disable_policy is the reversible way to stop a policy applying.

Requires delete:ops-config:jira-service-management, which Atlassian account API tokens do not carry — see the README.`,
  },
});

/** enable, disable and change-order: one tool each, both scopes. */
function policyAction(
  name: string,
  action: "enable" | "disable" | "change-order",
  options: {
    title: string;
    description: string;
    destructive: boolean;
    extraInput?: z.ZodRawShape;
    body?: (params: Record<string, unknown>) => Record<string, unknown>;
    bodyFields?: string[];
  },
): AnyToolDefinition {
  return defineTool({
    name,
    toolset: "policies",
    endpoint: [
      {
        method: "POST",
        path: `${GLOBAL}/{policyId}/${action}`,
        ...(options.bodyFields ? { body: options.bodyFields } : {}),
      },
      {
        method: "POST",
        path: `${TEAM}/{policyId}/${action}`,
        ...(options.bodyFields ? { body: options.bodyFields } : {}),
      },
    ],
    title: options.title,
    description: options.description,
    inputSchema: {
      policy_id: policyIdField,
      team_id: scopeField,
      ...(options.extraInput ?? {}),
    },
    outputSchema: policyOutput,
    annotations: {
      readOnlyHint: false,
      destructiveHint: options.destructive,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (params, client) =>
      executeWrite<Policy>(client, {
        label: `${action} policy`,
        method: "POST",
        path: `${basePath(params.team_id)}/${encodeURIComponent(params.policy_id)}/${action}`,
        ...(options.body ? { body: options.body(params) } : {}),
        mode: "sync",
        render: (item) => renderPolicy(item),
        structured: (item) => ({ policy: item as Record<string, unknown> }),
      }),
  });
}

const enablePolicy = policyAction("jsm_enable_policy", "enable", {
  title: "Enable a policy",
  description: `Turn a policy back on, so it applies to matching alerts again.

Args:
  - policy_id (string), team_id (string, optional)

Returns: { "policy": { "id": string, "enabled": true, ... } }

Read the policy first with jsm_get_policy. Enabling one that rewrites priority or suppresses notifications changes who gets paged from the next matching alert onwards.`,
  destructive: false,
});

const disablePolicy = policyAction("jsm_disable_policy", "disable", {
  title: "Disable a policy",
  description: `Stop a policy applying, without deleting it.

Args:
  - policy_id (string), team_id (string, optional)

Returns: { "policy": { "id": string, "enabled": false, ... } }

This is the reversible alternative to jsm_delete_policy, and the right tool for pausing one. It changes live behaviour: alerts this policy was suppressing start notifying people again, and alerts it was rewriting arrive unmodified.`,
  destructive: true,
});

const changePolicyOrder = policyAction("jsm_change_policy_order", "change-order", {
  title: "Reorder a policy",
  description: `Move a policy to a different position in its list.

Args:
  - policy_id (string), team_id (string, optional)
  - order (number): the new position

Returns: { "policy": { "id": string, "order": number, ... } }

Order is behaviour, not presentation: policies apply in order, and an alert policy with continue=false stops the chain where it matches. Moving one can therefore silently disable every policy beneath it.

Read jsm_list_alert_policies or jsm_list_team_policies first and say what the resulting order will be.`,
  destructive: true,
  extraInput: { order: z.number().int().min(0).describe("The policy's new position.") },
  body: (params) => ({ order: params.order }),
  bodyFields: ["order"],
});

/** The two list tools, separate because the team endpoint requires `type`. */
const listAlertPolicies = defineTool({
  name: "jsm_list_alert_policies",
  toolset: "policies",
  endpoint: { method: "GET", path: GLOBAL, query: ["size", "offset"] },
  title: "List site-wide alert policies",
  description: `List the site-wide alert policies — the rules that rewrite alerts as they arrive, before anyone is notified.

An alert policy can change an alert's priority, message, tags or responders. When an alert looks wrong in a way nobody typed, this is usually why.

Args:
  - limit (number): 1-100, default 20
  - offset (number): records to skip, default 0
  - response_format ('markdown' | 'json'): default 'markdown'

Returns (json format): { "policies": [ { "id": string, "type": string, "name": string, "enabled": boolean, "order": number, "filter": {...} } ], "pagination": {...} }

These are global policies and are always type 'alert'; notification policies exist only per team, through jsm_list_team_policies.

Policies apply in order, and one with continue=false stops the chain — so a policy near the top can prevent every policy beneath it from ever running.`,
  inputSchema: {
    limit: limitField,
    offset: offsetField,
    response_format: responseFormatField,
  },
  outputSchema: {
    policies: z.array(z.object({}).passthrough()),
    pagination: paginationOutputShape,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (params, client) =>
    executeList<Policy>({
      client,
      path: GLOBAL,
      params: { offset: params.offset },
      key: "policies",
      context: "list alert policies",
      limit: params.limit,
      offset: params.offset,
      format: params.response_format,
      render: (items) => ["# Alert policies", "", renderPolicies(items)].join("\n"),
      emptyMessage:
        "No site-wide alert policies. Note that notification policies and team alert policies are separate — read those with jsm_list_team_policies.",
      hint: "Increase 'offset' to see the rest.",
    }),
});

const listTeamPolicies = defineTool({
  name: "jsm_list_team_policies",
  toolset: "policies",
  endpoint: { method: "GET", path: TEAM, query: ["size", "offset", "type"] },
  title: "List a team's policies",
  description: `List a team's alert or notification policies.

Alert policies rewrite alerts as they arrive; notification policies decide whether and when those alerts actually notify anyone. Both are per team, and this endpoint returns one kind at a time.

Args:
  - team_id (string): the team, from jsm_list_teams
  - policy_type ('alert' | 'notification'): REQUIRED — this endpoint returns one kind per call
  - limit (number): 1-100, default 20
  - offset (number): records to skip, default 0
  - response_format ('markdown' | 'json'): default 'markdown'

Returns (json format): { "policies": [ { "id": string, "type": string, "name": string, "enabled": boolean, "order": number } ], "pagination": {...} }

policy_type is required by the API, not a filter you can omit — so answering "what policies does this team have?" takes two calls.

A notification policy with suppress=true means matching alerts page nobody while still appearing in the queue. That is the quietest configuration in the API and it is called out explicitly.`,
  inputSchema: {
    team_id: teamIdField,
    policy_type: policyTypeField,
    limit: limitField,
    offset: offsetField,
    response_format: responseFormatField,
  },
  outputSchema: {
    policies: z.array(z.object({}).passthrough()),
    pagination: paginationOutputShape,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (params, client) =>
    executeList<Policy>({
      client,
      path: `/v1/teams/${encodeURIComponent(params.team_id)}/policies`,
      params: { offset: params.offset, type: params.policy_type },
      key: "policies",
      context: "list team policies",
      limit: params.limit,
      offset: params.offset,
      format: params.response_format,
      render: (items) => ["# Team policies", "", renderPolicies(items)].join("\n"),
      emptyMessage:
        "No policies of that type on this team. Remember policy_type selects one kind — try the other before concluding the team has none.",
      hint: "Increase 'offset' to see the rest.",
    }),
});

/** Create and update, separate per scope because their required fields differ. */
function policyWriter(options: {
  name: string;
  title: string;
  description: string;
  scope: "global" | "team";
  verb: "create" | "update";
}): AnyToolDefinition {
  const isTeam = options.scope === "team";
  const isUpdate = options.verb === "update";
  const path = isTeam ? TEAM : GLOBAL;

  return defineTool({
    name: options.name,
    toolset: "policies",
    endpoint: {
      method: isUpdate ? "PUT" : "POST",
      path: isUpdate ? `${path}/{policyId}` : path,
      body: [...policyBodyFields, ...(isTeam ? teamPolicyBodyFields : [])],
    },
    title: options.title,
    description: options.description,
    inputSchema: {
      ...(isTeam ? { team_id: teamIdField } : {}),
      ...(isUpdate ? { policy_id: policyIdField } : {}),
      // A global policy can only be an alert policy; a team policy has to say
      // which kind it is, and the field sets differ accordingly.
      ...(isTeam
        ? { policy_type: policyTypeField }
        : {
            policy_type: z
              .literal("alert")
              .describe("Global policies can only be alert policies; this is the only value."),
          }),
      ...policyCommonShape,
      ...alertPolicyShape,
      ...(isTeam ? { ...policyOrderShape, ...notificationPolicyShape } : {}),
      ...(isTeam ? {} : { message: alertPolicyShape.message }),
    },
    outputSchema: policyOutput,
    annotations: {
      readOnlyHint: false,
      // An update replaces the policy wholesale; a create can silently shadow
      // the policies beneath it. Both change what happens to live alerts.
      destructiveHint: isUpdate,
      idempotentHint: isUpdate,
      openWorldHint: true,
    },
    handler: async (params, client) => {
      const teamId = isTeam ? (params.team_id as string) : undefined;
      const collection = basePath(teamId);
      const target = isUpdate
        ? `${collection}/${encodeURIComponent(params.policy_id as string)}`
        : collection;

      return executeWrite<Policy>(client, {
        label: `${options.verb} policy`,
        method: isUpdate ? "PUT" : "POST",
        path: target,
        body: toPolicyBody(params as Record<string, unknown>),
        mode: "sync",
        render: (item) => renderPolicy(item),
        structured: (item) => ({ policy: item as Record<string, unknown> }),
      });
    },
  });
}

const createAlertPolicy = policyWriter({
  name: "jsm_create_alert_policy",
  title: "Create a site-wide alert policy",
  scope: "global",
  verb: "create",
  description: `Create a site-wide alert policy, rewriting alerts as they arrive.

Args:
  - policy_type: always 'alert' — global policies cannot be notification policies
  - name (string), enabled (boolean), message (string): required by this endpoint
  - filter (object): which alerts it applies to — OMITTING IT MATCHES EVERY ALERT
  - order, description, alias, tags, responders, actions, details, priority_value, update_priority, keep_original_*: optional

Returns: { "policy": { "id": string, ... } }

Synchronous.

THIS CHANGES ALERTS BEFORE ANYONE SEES THEM. A policy with no filter matches everything on the site, and one that sets update_priority with a low priority_value can take alerts out of the escalation path entirely.

\`filter\` has no published schema. Read an existing policy with jsm_get_policy and follow its shape rather than inventing one — a filter that does not parse the way you expect matches more than you intended, not less.

Set continue_processing deliberately: false stops every policy below this one from running.`,
});

const updateAlertPolicy = policyWriter({
  name: "jsm_update_alert_policy",
  title: "Update a site-wide alert policy",
  scope: "global",
  verb: "update",
  description: `Replace a site-wide alert policy.

Args:
  - policy_id (string): the policy to replace
  - policy_type: always 'alert'
  - name, enabled, message: required
  - filter and the rest: optional

Returns: { "policy": { "id": string, ... } }

IMPORTANT: this is a PUT and replaces the whole policy. Anything you do not send is cleared, including the filter — which turns a targeted policy into one that matches every alert on the site. Read the current policy with jsm_get_policy and send it back with your change.`,
});

const createTeamPolicy = policyWriter({
  name: "jsm_create_team_policy",
  title: "Create a team policy",
  scope: "team",
  verb: "create",
  description: `Create an alert or notification policy on a team.

Args:
  - team_id (string): the owning team
  - policy_type ('alert' | 'notification'): required — it decides which of the fields below apply
  - name (string), enabled (boolean): required
  - filter (object): which alerts it applies to — OMITTING IT MATCHES EVERY ALERT
  - alert policies also take: message, alias, tags, responders, actions, details, priority_value, update_priority, keep_original_*
  - notification policies also take: suppress, delay_action, deduplication_action, auto_close_action, auto_restart_action

Returns: { "policy": { "id": string, ... } }

Synchronous.

suppress=true on a notification policy means matching alerts page NOBODY while still appearing in the queue. It is the quietest thing you can configure here and the hardest to notice afterwards — only set it when the user has asked for exactly that.

\`filter\` and the action objects have no published schema. Read an existing policy with jsm_get_policy and follow its shape.`,
});

const updateTeamPolicy = policyWriter({
  name: "jsm_update_team_policy",
  title: "Update a team policy",
  scope: "team",
  verb: "update",
  description: `Replace a team's alert or notification policy.

Args:
  - team_id (string), policy_id (string): which policy
  - policy_type ('alert' | 'notification'), name, enabled: required
  - the rest: optional, per policy type

Returns: { "policy": { "id": string, ... } }

IMPORTANT: this is a PUT and replaces the whole policy. Anything you do not send is cleared — most consequentially the filter, whose absence makes the policy match every alert the team receives. Read the current policy with jsm_get_policy and send it back with your change.`,
});

export const policyTools: AnyToolDefinition[] = [
  listAlertPolicies,
  listTeamPolicies,
  ...sharedPolicyTools,
  createAlertPolicy,
  updateAlertPolicy,
  createTeamPolicy,
  updateTeamPolicy,
  enablePolicy,
  disablePolicy,
  changePolicyOrder,
];
