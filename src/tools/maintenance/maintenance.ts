/**
 * Maintenance windows: periods in which named entities stop raising alerts.
 *
 * The API offers these twice — globally under /v1/maintenances and per team
 * under /v1/teams/{teamId}/maintenances — as the same six operations. They are
 * collapsed into six tools with an optional `team_id` that switches the path,
 * rather than twelve tools with near-identical descriptions for the model to
 * choose between. Both endpoints are declared in the manifest.
 */

import { z } from "zod";

import { renderMaintenance, renderMaintenances } from "../../services/render/maintenance.js";
import type { Maintenance } from "../../types.js";
import { defineTool } from "../define.js";
import { executeWrite } from "../execute-write.js";
import { defineResourceFamily, type ResourceConfig } from "../family.js";
import { teamIdField } from "../teams/shapes.js";

const maintenanceIdField = z
  .string()
  .min(1)
  .describe("Maintenance window id, from jsm_list_maintenances.");

const scopeField = teamIdField
  .optional()
  .describe(
    "Team whose maintenance windows to work with. Omit for site-wide windows — the two are " +
      "separate collections, so a window created without a team is not visible with one.",
  );

const maintenanceWriteShape = {
  description: z
    .string()
    .min(1)
    .describe(
      "What this maintenance is for. This is the only human-readable label a window carries, and " +
        "it is what someone reads when wondering why alerting is quiet.",
    ),
  start_date: z.string().describe("ISO 8601 instant the window opens."),
  end_date: z
    .string()
    .describe(
      "ISO 8601 instant the window closes. Alerting resumes then — there is no open-ended " +
        "maintenance, which is deliberate.",
    ),
  rules: z
    .array(
      z.object({
        entity_id: z.string().min(1).describe("Id of the integration, policy or sync to affect."),
        entity_type: z
          .enum(["sync", "integration", "policy"])
          .describe("What entity_id refers to."),
        state: z
          .enum(["enabled", "disabled"])
          .describe("'disabled' silences the entity for the window. This is the usual case."),
      }),
    )
    .min(1, "a maintenance window with no rules silences nothing")
    .describe(
      "What the window affects. A window with no rules is accepted by the API and silences " +
        "nothing, so at least one is required here.",
    ),
};

const toMaintenanceBody = (params: Record<string, unknown>) => ({
  description: params.description,
  startDate: params.start_date,
  endDate: params.end_date,
  rules: (params.rules as Array<Record<string, string>> | undefined)?.map((rule) => ({
    entity: { id: rule.entity_id, type: rule.entity_type },
    state: rule.state,
  })),
});

const maintenanceBodyFields = ["description", "startDate", "endDate", "rules"];

export const maintenanceResource: ResourceConfig = {
  toolset: "maintenance",
  path: "/v1/maintenances",
  noun: "maintenance",
  plural: "maintenances",
  idParam: "maintenance_id",
  idField: maintenanceIdField,
  scoped: {
    path: "/v1/teams/{teamId}/maintenances",
    parent: { param: "team_id", token: "teamId", field: scopeField },
  },
};

export const maintenanceTools = defineResourceFamily<Maintenance>(maintenanceResource, {
  list: {
    name: "jsm_list_maintenances",
    title: "List maintenance windows",
    description: `List maintenance windows — the periods in which named integrations, policies or syncs stop raising alerts.

Check this first when alerts have gone quiet unexpectedly: an open maintenance window is the most common reason a system that should be paging is not.

Args:
  - team_id (string, optional): a team's windows; omit for site-wide ones
  - type ('all' | 'non-expired' | 'past', optional): filter by state, default 'all'
  - limit (number): 1-100, default 20
  - offset (number): records to skip, default 0
  - response_format ('markdown' | 'json'): default 'markdown'

Returns (json format): { "maintenances": [ { "id": string, "status": string, "description": string, "startDate": string, "endDate": string, "rules": [...] } ], "pagination": {...} }

Team windows and site-wide windows are separate collections. Omitting team_id does not return both — check both if you are trying to explain silence.

Examples:
  - "Why is nothing alerting from the payments integration?" -> list with and without team_id and look for an active window naming it`,
    query: {
      // The spec's enum, verbatim. It was `z.string()` with 'active' given as
      // an example value the API does not accept — and since the filter was
      // being dropped before it reached the wire, nothing ever rejected it.
      type: z
        .enum(["all", "non-expired", "past"])
        .optional()
        .describe(
          "Filter by window state: 'non-expired' for windows that have not ended, 'past' for ones that have. Default 'all'.",
        ),
    },
    render: (items) => ["# Maintenance windows", "", renderMaintenances(items)].join("\n"),
    emptyMessage:
      "No maintenance windows found. Note that team and site-wide windows are separate collections — if you passed team_id, try again without it.",
  },
  get: {
    name: "jsm_get_maintenance",
    title: "Get one maintenance window",
    description: `Read one maintenance window: its period, its status, and exactly what it silences.

Args:
  - maintenance_id (string), team_id (string, optional)
  - response_format ('markdown' | 'json'): default 'markdown'

Returns: { "maintenance": { "id": string, "status": string, "startDate": string, "endDate": string, "rules": [...] } }

A window with no rules silences nothing, whatever its dates say. That is called out explicitly, because it is the state that makes someone believe alerting is paused when it is not.`,
    render: (item) => renderMaintenance(item),
  },
  create: {
    name: "jsm_create_maintenance",
    title: "Create a maintenance window",
    description: `Open a maintenance window, silencing named entities for a period.

Args:
  - description (string): required — what the maintenance is for
  - start_date (string), end_date (string): required — the ISO 8601 window
  - rules (array): required — [{ entity_id, entity_type: 'sync' | 'integration' | 'policy', state: 'disabled' }]
  - team_id (string, optional): create it on a team rather than site-wide

Returns: { "maintenance": { "id": string, ... } }

Synchronous.

THIS STOPS ALERTS REACHING PEOPLE. A window whose start date has already passed takes effect immediately. Confirm the entities and the window with the user before creating one — silencing the wrong integration looks identical to everything being fine.

Every window needs an end date; there is no open-ended maintenance.

Examples:
  - "Silence the payments integration while we deploy, 22:00 to 23:00" -> rules=[{entity_id: <integration id>, entity_type: "integration", state: "disabled"}]`,
    input: maintenanceWriteShape,
    toBody: toMaintenanceBody,
    bodyFields: maintenanceBodyFields,
    render: (item) => renderMaintenance(item),
  },
  update: {
    name: "jsm_update_maintenance",
    title: "Update a maintenance window",
    description: `Change a maintenance window's description, period or rules.

Args:
  - maintenance_id (string), team_id (string, optional)
  - description, start_date, end_date, rules

Returns: { "maintenance": { "id": string, ... } }

IMPORTANT: \`rules\` replaces the whole list. Extending a window's end date keeps alerting suppressed for longer — say so when reporting back, because it is the opposite of what "update" usually implies.

To end a window early, prefer jsm_cancel_maintenance over shortening it: cancelling is explicit and leaves a clearer record.`,
    input: maintenanceWriteShape,
    toBody: toMaintenanceBody,
    bodyFields: maintenanceBodyFields,
    render: (item) => renderMaintenance(item),
  },
  remove: {
    name: "jsm_delete_maintenance",
    title: "Delete a maintenance window",
    description: `Permanently delete a maintenance window.

Args:
  - maintenance_id (string), team_id (string, optional)

Returns: { "deleted": true, "maintenance_id": string }

Deleting an active window resumes alerting immediately for everything it silenced. If the goal is to end it early, jsm_cancel_maintenance does that and keeps the record of what was silenced and when.

Requires delete:ops-config:jira-service-management. That grant belongs to the individual token rather than to API-token auth — another token on the same account can hold it — so a 401 here means reissue JSM_API_TOKEN with the delete scopes included, or supply JSM_OAUTH_TOKEN, not that token auth cannot delete. See the README.`,
  },
});

export const cancelMaintenance = defineTool({
  name: "jsm_cancel_maintenance",
  toolset: "maintenance",
  endpoint: [
    { method: "POST", path: "/v1/maintenances/{id}/cancel" },
    { method: "POST", path: "/v1/teams/{teamId}/maintenances/{id}/cancel" },
  ],
  title: "Cancel a maintenance window",
  description: `End a maintenance window now, resuming alerting for everything it was silencing.

Args:
  - maintenance_id (string): the window to cancel
  - team_id (string, optional): for a team window rather than a site-wide one

Returns: { "maintenance": { "id": string, "status": string, ... } }

This is the right way to end maintenance early. Unlike jsm_delete_maintenance it keeps the record of what was silenced and for how long, which is what someone reviewing an incident will want.

Alerts suppressed *during* the window are not replayed — cancelling resumes future alerting, it does not recover what was missed.`,
  inputSchema: {
    maintenance_id: maintenanceIdField,
    team_id: scopeField,
  },
  outputSchema: { maintenance: z.object({}).passthrough() },
  annotations: {
    readOnlyHint: false,
    // Resuming alerting is the safe direction, but it is still a change to
    // live notification behaviour.
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (params, client) => {
    const base =
      params.team_id === undefined
        ? "/v1/maintenances"
        : `/v1/teams/${encodeURIComponent(params.team_id)}/maintenances`;
    return executeWrite<Maintenance>(client, {
      label: "Cancel maintenance",
      method: "POST",
      path: `${base}/${encodeURIComponent(params.maintenance_id)}/cancel`,
      mode: "sync",
      subject: { key: "maintenance_id", value: params.maintenance_id, noun: "maintenance" },
      render: (item) => renderMaintenance(item),
      structured: (item) => ({ maintenance: item as Record<string, unknown> }),
    });
  },
});
