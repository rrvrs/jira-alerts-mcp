/**
 * jsm_list_schedules — schedule discovery.
 *
 * The first tool expressed through defineResourceFamily rather than by hand.
 * Its description, renderer and empty message are unchanged to the byte: the
 * factory owns path interpolation, the input shape, the executor call, the
 * pagination block and the annotation vector, and owns none of the prose.
 */

import { z } from "zod";

import { resolveTeams } from "../../services/directory.js";
import { renderSchedules } from "../../services/format.js";
import type { Schedule } from "../../types.js";
import { defineListOperation, type ResourceConfig } from "../family.js";

export const scheduleResource: ResourceConfig = {
  toolset: "oncall",
  path: "/v1/schedules",
  noun: "schedule",
  plural: "schedules",
  idParam: "schedule_id",
  idField: z
    .string()
    .min(1)
    .describe("Schedule id (a UUID), from jsm_list_schedules. Not the schedule's name."),
};

export const listSchedules = defineListOperation<
  Schedule,
  Awaited<ReturnType<typeof resolveTeams>>
>(scheduleResource, {
  name: "jsm_list_schedules",
  title: "List JSM on-call schedules",
  description: `List the on-call schedules configured in JSM Operations, with their ids, owning teams and timezones.

Start here when you need a schedule id for jsm_get_on_call or jsm_get_next_on_call, or when you want to know which rotations exist at all.

Args:
  - limit (number): 1-100, default 20
  - offset (number): records to skip, default 0
  - response_format ('markdown' | 'json'): default 'markdown'

Returns (json format):
  {
    "schedules": [
      { "id": string, "name": string, "description": string, "timezone": string, "enabled": boolean, "ownerTeam": { "id": string, "name": string } }
    ],
    "pagination": { "count": number, "offset": number, "has_more": boolean, "next_offset": number }
  }

Examples:
  - "What on-call rotations do we have?" -> no args
  - "Find the schedule id for the platform rotation" -> then match on name

Error handling:
  - HTTP 401 here while alert tools work means the token is missing read:ops-config:jira-service-management — schedules and on-call sit behind a different scope from alerts, so this is a scope gap, not a bad credential.`,
  item: { id: z.string(), name: z.string() },
  // One cached lookup for the whole page: the API returns a bare teamId, and
  // a schedule's owning team is most of what makes the list readable.
  prepare: resolveTeams,
  render: (items, teams) => ["# On-call schedules", "", renderSchedules(items, teams)].join("\n"),
  // An empty list here usually means missing team access, not an empty
  // site — say so, because the API returns no error to distinguish them.
  emptyMessage:
    "No on-call schedules found. Schedules live on a team's Operations page in JSM — if you expect some, confirm the credentials can see that team.",
  hint: "Increase 'offset' to see the rest.",
});
