/**
 * Heartbeats: dead-man's switches. JSM raises an alert when an expected ping
 * stops arriving, which is how you find out a cron job died rather than
 * failed.
 *
 * Hand-written rather than generated, and the family the plan predicted would
 * need to be. Every operation lives on `/v1/teams/{teamId}/heartbeats` and is
 * identified by a `name` QUERY parameter — there is no item path at all, so
 * PATCH and DELETE go to the collection URL with `?name=`. None of that is one
 * of the five shapes the factory covers, and bending it to fit would have made
 * the factory worse for the eight families that do fit.
 */

import { z } from "zod";

import { renderHeartbeat, renderHeartbeats } from "../../services/render/maintenance.js";
import type { Heartbeat } from "../../types.js";
import { responseFormatField } from "../../schemas/common.js";
import { defineTool, type AnyToolDefinition } from "../define.js";
import { executeList } from "../list-executor.js";
import { executeWrite } from "../execute-write.js";
import { paginationOutputShape, limitField, offsetField } from "../../schemas/common.js";
import { teamIdField } from "../teams/shapes.js";

const COLLECTION = "/v1/teams/{teamId}/heartbeats";

const nameField = z
  .string()
  .min(1)
  .describe(
    "The heartbeat's name, which is its identifier here — these endpoints take a name in the " +
      "query string rather than an id in the path. Names come from jsm_list_heartbeats.",
  );

const path = (teamId: string) => `/v1/teams/${encodeURIComponent(teamId)}/heartbeats`;

const heartbeatOutput = { heartbeat: z.object({}).passthrough() };

const writeShape = {
  name: nameField,
  description: z.string().optional().describe("What this heartbeat is watching."),
  interval: z
    .number()
    .int()
    .min(1)
    .describe("How many intervalUnits may pass between pings before an alert is raised."),
  interval_unit: z
    .enum(["minutes", "hours", "days"])
    .describe("Unit for `interval`. Note the API returns these capitalised but accepts lowercase."),
  enabled: z
    .boolean()
    .optional()
    .describe("A disabled heartbeat never alerts, however long the silence."),
  alert_message: z
    .string()
    .optional()
    .describe("Message on the alert raised when a ping is missed. Say what stopped, and where."),
  alert_priority: z
    .enum(["P1", "P2", "P3", "P4", "P5"])
    .optional()
    .describe("Priority of the alert raised when the heartbeat expires."),
  alert_tags: z.array(z.string()).optional().describe("Tags for that alert."),
};

const toBody = (params: Record<string, unknown>) => ({
  name: params.name,
  description: params.description,
  interval: params.interval,
  intervalUnit: params.interval_unit,
  enabled: params.enabled,
  alertMessage: params.alert_message,
  alertPriority: params.alert_priority,
  alertTags: params.alert_tags,
});

const createBodyFields = [
  "name",
  "description",
  "interval",
  "intervalUnit",
  "enabled",
  "alertMessage",
  "alertPriority",
  "alertTags",
];

// UpdateHeartbeatRequest contradicts itself: it lists `name` in `required` and
// then does not define it as a property, while the query parameter `name` is
// separately required. Sending it in both places satisfies every reading of the
// spec and is what a client following it would do; the allowance below covers
// the half that is missing from `properties`.
//
// NOT confirmed against a tenant: heartbeats are a paid feature and the tenant
// used for verification answers 402 on every heartbeat endpoint. If you get
// access to one that has them, the check is to update a heartbeat and see
// whether the change lands — and if the body's `name` turns out to be rejected
// rather than ignored, drop it from here and from the allowance.
const updateBodyFields = createBodyFields;

const listHeartbeats = defineTool({
  name: "jsm_list_heartbeats",
  toolset: "heartbeats",
  endpoint: { method: "GET", path: COLLECTION, query: ["size", "offset", "name"] },
  title: "List heartbeats for a team",
  description: `List a team's heartbeats — the dead-man's switches that alert when an expected ping stops arriving.

A heartbeat is how you learn that a job died rather than failed: something pings JSM on a schedule, and JSM alerts when the ping does not come.

Args:
  - team_id (string): the owning team, from jsm_list_teams
  - name (string, optional): filter to one heartbeat by name
  - limit (number): 1-100, default 20
  - offset (number): records to skip, default 0
  - response_format ('markdown' | 'json'): default 'markdown'

Returns (json format): { "heartbeats": [ { "name": string, "status": "Responsive" | "Unresponsive" | "Off" | "Pending", "interval": number, "intervalUnit": string, "enabled": boolean } ], "pagination": {...} }

Two statuses mean very different things and both look like a field: 'Unresponsive' means the ping already stopped and an alert has fired; 'Off' means the switch is not armed at all, so a missed ping raises nothing. Both are called out explicitly.

Examples:
  - "Is the nightly backup heartbeat healthy?" -> team_id=<id>, then read its status`,
  inputSchema: {
    team_id: teamIdField,
    name: z.string().optional().describe("Filter to one heartbeat by name."),
    limit: limitField,
    offset: offsetField,
    response_format: responseFormatField,
  },
  outputSchema: {
    heartbeats: z.array(z.object({}).passthrough()),
    pagination: paginationOutputShape,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (params, client) =>
    executeList<Heartbeat>({
      client,
      path: path(params.team_id),
      params: { offset: params.offset, ...(params.name ? { name: params.name } : {}) },
      key: "heartbeats",
      context: "list heartbeats",
      limit: params.limit,
      offset: params.offset,
      format: params.response_format,
      render: (items) => ["# Heartbeats", "", renderHeartbeats(items)].join("\n"),
      emptyMessage:
        "This team has no heartbeats, so nothing here will notice a job that stops running. Create one with jsm_create_heartbeat.",
      hint: "Increase 'offset' to see the rest.",
    }),
});

const pingHeartbeat = defineTool({
  name: "jsm_ping_heartbeat",
  toolset: "heartbeats",
  endpoint: { method: "GET", path: `${COLLECTION}/ping`, query: ["name"] },
  title: "Send a heartbeat ping",
  description: `Send a ping, resetting a heartbeat's timer and clearing it if it had expired.

Args:
  - team_id (string): the owning team
  - name (string): the heartbeat to ping

Returns: { "pinged": true, "name": string, "message": string }

The response is only an acknowledgement — "PONG - Heartbeat received" — not the heartbeat's record. Nothing about the heartbeat's state comes back, so report that the ping was accepted rather than describing the heartbeat.

The API answers PONG whether or not a heartbeat by that name exists, and answers it on sites whose plan excludes heartbeat monitoring entirely (both checked against a live tenant on 2026-09-05). So a successful ping is NOT evidence that the heartbeat is real or that monitoring is active. Confirm with jsm_list_heartbeats before telling anyone a heartbeat is being kept alive.

This is what the monitored job itself is meant to call. Sending it by hand tells JSM the job is alive when it may not be — which silences a real alert. Only do it when the user has explicitly asked, and say plainly that the heartbeat has been reset rather than that the underlying job is healthy.`,
  inputSchema: { team_id: teamIdField, name: nameField },
  outputSchema: {
    pinged: z.boolean(),
    name: z.string(),
    message: z.string().optional(),
  },
  annotations: {
    readOnlyHint: false,
    // A ping asserts liveness on the job's behalf and clears a firing alert.
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (params, client) =>
    // The ping answers {message: "PONG - Heartbeat received"} and nothing
    // else. Rendering that through renderHeartbeat printed a heartbeat with
    // no name, no interval and no status — "**(unnamed)**" — which reads like
    // a heartbeat that exists and is broken. Verified against a live tenant.
    executeWrite<{ message?: string }>(client, {
      label: "Ping heartbeat",
      method: "GET",
      path: `${path(params.team_id)}/ping`,
      params: { name: params.name },
      mode: "sync",
      render: (pong) =>
        `Ping accepted for heartbeat \`${params.name}\`. The API answered: ${
          pong?.message ?? "(no message)"
        }\n\nThis acknowledges the ping only. It does not confirm the heartbeat exists, ` +
        `and it says nothing about the heartbeat's state — read it back with jsm_list_heartbeats ` +
        `before reporting that monitoring is active.`,
      structured: (pong) => ({
        pinged: true,
        name: params.name,
        ...(pong?.message ? { message: pong.message } : {}),
      }),
    }),
});

const createHeartbeat = defineTool({
  name: "jsm_create_heartbeat",
  toolset: "heartbeats",
  endpoint: { method: "POST", path: COLLECTION, body: createBodyFields },
  title: "Create a heartbeat",
  description: `Create a heartbeat: JSM raises an alert if no ping arrives within the interval.

Args:
  - team_id (string): the owning team
  - name (string): required — this is the heartbeat's identifier, and what the pinging job must send
  - interval (number), interval_unit ('minutes' | 'hours' | 'days'): required — how long silence may last
  - description, enabled, alert_message, alert_priority, alert_tags: optional

Returns: { "heartbeat": { "name": string, ... } }

Synchronous.

Set the interval longer than the job's own schedule, with room for a slow run — a heartbeat pinged hourly with a one-hour interval alerts on the first slightly-late run, and a flapping heartbeat gets muted by whoever it wakes.

The name is the identity: every other heartbeat tool takes it, and so does the pinging job.

Examples:
  - "Alert if the nightly backup stops running" -> name="nightly-backup", interval=26, interval_unit="hours"`,
  inputSchema: { team_id: teamIdField, ...writeShape },
  outputSchema: heartbeatOutput,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (params, client) =>
    executeWrite<Heartbeat>(client, {
      label: "Create heartbeat",
      method: "POST",
      path: path(params.team_id),
      body: toBody(params),
      mode: "sync",
      render: (beat) => renderHeartbeat(beat),
      structured: (beat) => ({ heartbeat: beat as Record<string, unknown> }),
    }),
});

const updateHeartbeat = defineTool({
  name: "jsm_update_heartbeat",
  toolset: "heartbeats",
  endpoint: {
    method: "PATCH",
    path: COLLECTION,
    query: ["name"],
    body: updateBodyFields,
    // See the note on updateBodyFields: the spec marks `name` required on this
    // body and omits it from the body's properties.
    allowUnknownBody: ["name"],
  },
  title: "Update a heartbeat",
  description: `Change a heartbeat's interval, alert settings or enabled flag.

Args:
  - team_id (string), name (string): which heartbeat — the name goes in the query string, not a path id
  - interval, interval_unit, description, enabled, alert_message, alert_priority, alert_tags

Returns: { "heartbeat": { "name": string, ... } }

Setting enabled=false is the reversible way to stop a heartbeat alerting — during a planned outage, say. While disabled it raises nothing however long the silence, which is easy to forget to undo.

Lengthening the interval widens the window in which a dead job goes unnoticed. Say so when reporting back.`,
  inputSchema: { team_id: teamIdField, ...writeShape },
  outputSchema: heartbeatOutput,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (params, client) =>
    executeWrite<Heartbeat>(client, {
      label: "Update heartbeat",
      method: "PATCH",
      path: path(params.team_id),
      params: { name: params.name },
      body: toBody(params),
      mode: "sync",
      render: (beat) => renderHeartbeat(beat),
      structured: (beat) => ({ heartbeat: beat as Record<string, unknown> }),
    }),
});

const deleteHeartbeat = defineTool({
  name: "jsm_delete_heartbeat",
  toolset: "heartbeats",
  endpoint: { method: "DELETE", path: COLLECTION, query: ["name"] },
  title: "Delete a heartbeat",
  description: `Permanently delete a heartbeat.

Args:
  - team_id (string), name (string)

Returns: { "deleted": true, "name": string }

Nothing then notices if the job it watched stops running, and no alert is raised to say the watch is gone. If the goal is to stop it alerting temporarily, jsm_update_heartbeat with enabled=false is reversible and leaves the configuration in place.

Requires delete:ops-config:jira-service-management, which Atlassian account API tokens do not carry — see the README.`,
  inputSchema: { team_id: teamIdField, name: nameField },
  outputSchema: { deleted: z.boolean(), name: z.string().optional() },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (params, client) =>
    executeWrite(client, {
      label: "Delete heartbeat",
      method: "DELETE",
      path: path(params.team_id),
      params: { name: params.name },
      mode: "deleted",
      subject: { key: "name", value: params.name, noun: "heartbeat" },
    }),
});

export const heartbeatTools: AnyToolDefinition[] = [
  listHeartbeats,
  pingHeartbeat,
  createHeartbeat,
  updateHeartbeat,
  deleteHeartbeat,
];
