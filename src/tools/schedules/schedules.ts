/**
 * Schedule configuration: read one, create, update, delete.
 *
 * jsm_list_schedules is not here — it belongs to the `oncall` toolset, because
 * discovering a schedule id is the first step of answering "who is on call?"
 * and that question should not require loading the configuration family.
 */

import { z } from "zod";

import { resolveTeams } from "../../services/directory.js";

import { renderSchedule } from "../../services/render/schedules.js";
import type { Schedule } from "../../types.js";
import { defineResourceFamily, type ResourceConfig } from "../family.js";
import { scheduleIdField } from "./shapes.js";

const scheduleWriteShape = {
  name: z.string().min(1).describe("Name of the schedule."),
  team_id: z
    .string()
    .optional()
    .describe(
      "Id of the owning team. A schedule with no team is visible to nobody's Operations page, " +
        "so pass one unless you are deliberately creating an orphan.",
    ),
  description: z.string().optional().describe("What this schedule is for."),
  timezone: z
    .string()
    .optional()
    .describe(
      "IANA time zone id, e.g. 'Europe/London' or 'Asia/Kolkata'. This is what shift boundaries " +
        "are computed in, so getting it wrong moves every handover.",
    ),
  enabled: z
    .boolean()
    .optional()
    .describe("A disabled schedule pages nobody but keeps its configuration."),
};

const toScheduleBody = (params: Record<string, unknown>) => ({
  name: params.name,
  teamId: params.team_id,
  description: params.description,
  timezone: params.timezone,
  enabled: params.enabled,
});

const scheduleBodyFields = ["name", "teamId", "description", "timezone", "enabled"];

export const scheduleResource: ResourceConfig = {
  toolset: "schedules",
  path: "/v1/schedules",
  noun: "schedule",
  plural: "schedules",
  idParam: "schedule_id",
  idField: scheduleIdField,
};

type Teams = Awaited<ReturnType<typeof resolveTeams>>;

export const scheduleTools = defineResourceFamily<Schedule, Teams>(scheduleResource, {
  get: {
    name: "jsm_get_schedule",
    title: "Get a JSM on-call schedule",
    description: `Read one on-call schedule in full: its team, timezone, and the rotations that make it up.

Use this when jsm_list_schedules has told you a schedule exists and you need to know how it actually pages people — the list gives you a name and an id, this gives you the rotations.

Args:
  - schedule_id (string): the schedule's id, not its name
  - response_format ('markdown' | 'json'): default 'markdown'

Returns (json format): { "schedule": { "id": string, "name": string, "timezone": string, "enabled": boolean, "rotations": [...] } }

A schedule with no rotations pages nobody, however many people are on the team. That is a real and easily-missed configuration state, so it is called out explicitly rather than rendered as an empty list.

Examples:
  - "How does the payments rotation work?" -> jsm_list_schedules first, then this with the id`,
    // Same one lookup jsm_list_schedules does, so the two agree on how a
    // schedule's owning team is shown.
    prepare: resolveTeams,
    render: (schedule, teams) => renderSchedule(schedule, teams),
  },
  create: {
    name: "jsm_create_schedule",
    title: "Create a JSM on-call schedule",
    description: `Create an on-call schedule.

A schedule created this way has no rotations, so it pages nobody until you add one with jsm_create_rotation. That is the expected two-step: create the schedule, then create the rotation inside it.

Args:
  - name (string): required
  - team_id (string, optional): the owning team; without one the schedule appears on no team's Operations page
  - description (string, optional)
  - timezone (string, optional): IANA id, e.g. 'Europe/London'
  - enabled (boolean, optional)

Returns: { "schedule": { "id": string, ... } }

Unlike the alert tools, this is synchronous — the response is the created schedule, not a receipt, and there is no request id to poll.

Timezone is worth getting right at creation: it is what every shift boundary is computed in, so changing it later moves every handover in every rotation.

Examples:
  - "Create a schedule for the payments team in London time" -> name="Payments", timezone="Europe/London", team_id=<id>`,
    input: scheduleWriteShape,
    toBody: toScheduleBody,
    bodyFields: scheduleBodyFields,
    render: (schedule) => renderSchedule(schedule),
  },
  update: {
    name: "jsm_update_schedule",
    title: "Update a JSM on-call schedule",
    description: `Change a schedule's name, team, description, timezone or enabled flag.

Args:
  - schedule_id (string): the schedule to change
  - name, team_id, description, timezone, enabled: the fields to set

Returns: { "schedule": { "id": string, ... } }

IMPORTANT: this replaces the fields you send. Changing \`timezone\` re-computes every shift boundary in every rotation on this schedule, which moves who is on call right now — confirm with the user before changing it on a live schedule.

Setting enabled=false is the reversible way to stop a schedule paging people. Deleting it is not reversible; prefer this.

Examples:
  - "Stop the legacy rotation paging people" -> schedule_id=<id>, enabled=false`,
    input: scheduleWriteShape,
    toBody: toScheduleBody,
    bodyFields: scheduleBodyFields,
    render: (schedule) => renderSchedule(schedule),
  },
  remove: {
    name: "jsm_delete_schedule",
    title: "Delete a JSM on-call schedule",
    description: `Permanently delete an on-call schedule and every rotation in it.

Args:
  - schedule_id (string): the schedule to delete

Returns: { "deleted": true, "schedule_id": string }

This is almost never the right tool. Setting enabled=false with jsm_update_schedule stops the schedule paging anyone and keeps the record of how the team was covered; deleting throws away the rotations, the overrides and the history for everyone, with no undo. Ask the user to confirm they mean delete rather than disable.

Requires delete:ops-config:jira-service-management. An Atlassian account API token does not carry delete scopes, so this returns 401 on token auth however valid the credentials are — see the README.`,
  },
});
