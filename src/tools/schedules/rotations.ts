/**
 * Rotations: the part of a schedule that actually decides who is on call.
 *
 * Nested under a schedule, so every tool here takes a schedule_id as well as
 * its own id — declared once as the family's `parents`.
 */

import { z } from "zod";

import { renderRotation, renderRotations } from "../../services/render/schedules.js";
import type { Rotation } from "../../types.js";
import { defineResourceFamily, type ResourceConfig } from "../family.js";
import {
  endDateField,
  participantField,
  rotationIdField,
  rotationTypeField,
  scheduleIdField,
  startDateField,
} from "./shapes.js";

const rotationWriteShape = {
  name: z.string().optional().describe("Name of the rotation, e.g. 'Primary' or 'Weekends'."),
  type: rotationTypeField,
  length: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "How many units of `type` one shift lasts. type='weekly' with length=2 is a fortnightly " +
        "handover. Defaults to 1.",
    ),
  start_date: startDateField,
  end_date: endDateField.optional(),
  participants: participantField.optional(),
};

const toRotationBody = (params: Record<string, unknown>) => ({
  name: params.name,
  type: params.type,
  length: params.length,
  startDate: params.start_date,
  endDate: params.end_date,
  participants: params.participants,
});

const rotationBodyFields = ["name", "type", "length", "startDate", "endDate", "participants"];

export const rotationResource: ResourceConfig = {
  toolset: "schedules",
  path: "/v1/schedules/{scheduleId}/rotations",
  noun: "rotation",
  plural: "rotations",
  idParam: "rotation_id",
  idField: rotationIdField,
  parents: [{ param: "schedule_id", token: "scheduleId", field: scheduleIdField }],
};

export const rotationTools = defineResourceFamily<Rotation>(rotationResource, {
  list: {
    name: "jsm_list_rotations",
    title: "List rotations in a JSM schedule",
    description: `List the rotations in an on-call schedule, with their shift lengths and participants.

A schedule is a container; its rotations are what page people. If jsm_get_on_call returns nobody for a schedule that clearly should have someone, this is where the answer usually is: no rotations, no participants in a rotation, or a rotation whose end date has passed.

Args:
  - schedule_id (string): the schedule to look inside
  - limit (number): 1-100, default 20
  - offset (number): records to skip, default 0
  - response_format ('markdown' | 'json'): default 'markdown'

Returns (json format): { "rotations": [ { "id": string, "name": string, "type": string, "length": number, "startDate": string, "endDate": string, "participants": [...] } ], "pagination": {...} }

Examples:
  - "Why is nobody on call for payments?" -> list the rotations and look for an empty participant list or a past end date`,
    render: (rotations) => renderRotations(rotations),
    emptyMessage:
      "This schedule has no rotations, which means it pages nobody — however many people are on the team. Add one with jsm_create_rotation.",
  },
  get: {
    name: "jsm_get_rotation",
    title: "Get one rotation",
    description: `Read one rotation in full: its type, shift length, date range and participants in order.

Args:
  - schedule_id (string): the schedule the rotation belongs to
  - rotation_id (string): the rotation
  - response_format ('markdown' | 'json'): default 'markdown'

Returns: { "rotation": { "id": string, "name": string, "type": string, "participants": [...] } }

Participant order is the rotation order, not a set — it is what decides who takes which shift.`,
    render: (rotation) => renderRotation(rotation),
  },
  create: {
    name: "jsm_create_rotation",
    title: "Create a rotation in a JSM schedule",
    description: `Add a rotation to an on-call schedule. This is what makes a schedule page someone.

Args:
  - schedule_id (string): the schedule to add to
  - type ('daily' | 'weekly' | 'hourly'): required — how often it hands over
  - start_date (string): required — ISO 8601 instant the rotation starts
  - name (string, optional)
  - length (number, optional): units of \`type\` per shift; 1 by default, so type='weekly' with length=2 is fortnightly
  - end_date (string, optional): leave it off for a rotation that runs indefinitely
  - participants (array, optional): [{ id, type }] in rotation order

Returns: { "rotation": { "id": string, ... } }

Synchronous: the response is the created rotation, not an async receipt.

Two things that quietly produce a rotation that pages nobody: omitting \`participants\`, and setting an \`end_date\` in the past. Both are accepted.

Participant order matters — it is the order shifts are handed out in, so it is not a set you can reorder freely.

Examples:
  - "Set up a weekly primary rotation for these three people" -> type="weekly", start_date=<iso>, participants=[{id, type:"user"}, ...]`,
    input: rotationWriteShape,
    toBody: toRotationBody,
    bodyFields: rotationBodyFields,
    render: (rotation) => renderRotation(rotation),
  },
  update: {
    name: "jsm_update_rotation",
    title: "Update a rotation",
    description: `Change a rotation's name, type, shift length, date range or participants.

Args:
  - schedule_id (string), rotation_id (string): which rotation
  - name, type, length, start_date, end_date, participants: the fields to set

Returns: { "rotation": { "id": string, ... } }

IMPORTANT: \`participants\` replaces the whole list rather than adding to it. To add one person you must send everyone, in order — read the rotation first with jsm_get_rotation and send the existing list plus the new member, or you will silently remove everyone you left out.

Changing type, length or start_date re-computes the shift boundaries, which can change who is on call right now. Confirm with the user before doing it to a live rotation.`,
    input: rotationWriteShape,
    toBody: toRotationBody,
    bodyFields: rotationBodyFields,
    render: (rotation) => renderRotation(rotation),
  },
  remove: {
    name: "jsm_delete_rotation",
    title: "Delete a rotation",
    description: `Permanently delete a rotation from a schedule.

Args:
  - schedule_id (string), rotation_id (string)

Returns: { "deleted": true, "rotation_id": string }

Deleting the last rotation on a schedule leaves it paging nobody while still looking configured — which is the failure mode nobody notices until an alert goes unanswered. Check with jsm_list_rotations first, and prefer emptying the participants or setting an end date if you only want it to stop.

Requires delete:ops-config:jira-service-management. That grant belongs to the individual token rather than to API-token auth — another token on the same account can hold it — so a 401 here means reissue JSM_API_TOKEN with the delete scopes included, or supply JSM_OAUTH_TOKEN, not that token auth cannot delete. See the README.`,
  },
});
