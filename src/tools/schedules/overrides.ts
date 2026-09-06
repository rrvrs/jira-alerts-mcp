/**
 * Overrides: one-off cover for someone else's shift.
 *
 * Two things here are unlike every other resource in the API, and both are
 * spec facts rather than choices: an override is addressed by `alias` rather
 * than by `id`, and it is updated with PUT rather than PATCH.
 */

import { z } from "zod";

import { renderOverride, renderOverrides } from "../../services/render/schedules.js";
import type { ScheduleOverride } from "../../types.js";
import { defineResourceFamily, type ResourceConfig } from "../family.js";
import { endDateField, overrideAliasField, scheduleIdField, startDateField } from "./shapes.js";

const overrideWriteShape = {
  responder_id: z
    .string()
    .optional()
    .describe(
      "Atlassian account id of whoever is covering. Omit it only with responder_type='noone'.",
    ),
  responder_type: z
    .enum(["user", "noone"])
    .describe(
      "'user' for a normal cover. 'noone' is the opposite of a cover: it deliberately leaves " +
        "the shift unstaffed, so alerts in that window page nobody from this schedule.",
    ),
  start_date: startDateField,
  end_date: endDateField,
  rotation_ids: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Which rotations the override applies to. Omit to cover every rotation in the schedule.",
    ),
};

const toOverrideBody = (params: Record<string, unknown>) => ({
  responder: {
    type: params.responder_type,
    // The spec is explicit that id is null when the type is `noone`, and
    // sending an id alongside it would describe a cover that is not one.
    ...(params.responder_type === "noone" ? {} : { id: params.responder_id }),
  },
  startDate: params.start_date,
  endDate: params.end_date,
  rotationIds: params.rotation_ids,
});

const overrideBodyFields = ["responder", "startDate", "endDate", "rotationIds"];

export const overrideResource: ResourceConfig = {
  toolset: "schedules",
  path: "/v1/schedules/{scheduleId}/overrides",
  noun: "override",
  plural: "overrides",
  idParam: "override_alias",
  idField: overrideAliasField,
  itemToken: "alias",
  // The one PUT in this family. PATCH here is a 405, not a partial update.
  updateMethod: "PUT",
  parents: [{ param: "schedule_id", token: "scheduleId", field: scheduleIdField }],
};

export const overrideTools = defineResourceFamily<ScheduleOverride>(overrideResource, {
  list: {
    name: "jsm_list_overrides",
    title: "List overrides on a JSM schedule",
    description: `List the one-off overrides on an on-call schedule — who is covering for whom, and when.

Overrides are the reason the person the rotation names is not always the person actually on call. If jsm_get_on_call disagrees with what the rotation implies, an override is usually why.

Args:
  - schedule_id (string): the schedule
  - limit (number): 1-100, default 20
  - offset (number): records to skip, default 0
  - response_format ('markdown' | 'json'): default 'markdown'

Returns (json format): { "overrides": [ { "alias": string, "responder": { "id": string, "type": string }, "startDate": string, "endDate": string, "rotationIds": [string] } ], "pagination": {...} }

Note that overrides are keyed by \`alias\`, not by an id — that alias is what the other override tools take.`,
    render: (overrides) => renderOverrides(overrides),
    emptyMessage:
      "No overrides on this schedule, so the rotations decide who is on call without exception.",
  },
  get: {
    name: "jsm_get_override",
    title: "Get one schedule override",
    description: `Read one override: who is covering, over what window, and for which rotations.

Args:
  - schedule_id (string), override_alias (string): the alias from jsm_list_overrides, not an id
  - response_format ('markdown' | 'json'): default 'markdown'

Returns: { "override": { "alias": string, "responder": {...}, "startDate": string, "endDate": string } }`,
    render: (override) => renderOverride(override),
  },
  create: {
    name: "jsm_create_override",
    title: "Create a schedule override",
    description: `Override who is on call for a window — someone covering a colleague's shift.

Args:
  - schedule_id (string): the schedule to override
  - responder_type ('user' | 'noone'): required
  - responder_id (string): the account id covering; omit only for responder_type='noone'
  - start_date (string), end_date (string): required — the ISO 8601 window
  - rotation_ids (string[], optional): restrict to particular rotations; omit to cover all of them

Returns: { "override": { "alias": string, ... } }

Synchronous: the response is the created override, and the \`alias\` it returns is how you refer to it later.

responder_type='noone' does not mean "leave it as it was" — it deliberately leaves the window unstaffed, so alerts in it page nobody from this schedule. Only use it when the user has actually asked for that.

An override changes who gets paged right now if its window has already started. Say so when reporting back.

Examples:
  - "Cover Priya's shift tomorrow with me" -> responder_type="user", responder_id=<your id>, start_date/end_date = tomorrow's window`,
    input: overrideWriteShape,
    toBody: toOverrideBody,
    bodyFields: overrideBodyFields,
    render: (override) => renderOverride(override),
  },
  update: {
    name: "jsm_update_override",
    title: "Update a schedule override",
    description: `Change an existing override's responder, window or rotations.

Args:
  - schedule_id (string), override_alias (string): which override
  - responder_type, responder_id, start_date, end_date: required — see below
  - rotation_ids (string[], optional)

Returns: { "override": { "alias": string, ... } }

IMPORTANT: this is a PUT, not a partial update. The API replaces the whole override with what you send, and responder, start_date and end_date are all required — read the current values with jsm_get_override first unless you mean to set all of them.

Examples:
  - "Extend my cover by a day" -> read it, then re-send with the later end_date`,
    input: overrideWriteShape,
    toBody: toOverrideBody,
    bodyFields: overrideBodyFields,
    render: (override) => renderOverride(override),
  },
  remove: {
    name: "jsm_delete_override",
    title: "Delete a schedule override",
    description: `Delete an override, handing the shift back to whoever the rotation names.

Args:
  - schedule_id (string), override_alias (string)

Returns: { "deleted": true, "override_alias": string }

If the override's window is running right now, deleting it changes who is on call immediately — the rotation's own responder takes the shift back. Say so when reporting back.

Requires delete:ops-config:jira-service-management, which Atlassian account API tokens do not carry — see the README.`,
  },
});
