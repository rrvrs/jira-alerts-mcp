/**
 * jsm_list_schedules — schedule discovery.
 */

import { z } from "zod";

import { renderSchedules } from "../../services/format.js";
import type { Schedule } from "../../types.js";
import { paginationOutputShape } from "../alerts/shapes.js";
import { defineTool } from "../define.js";
import { executeList } from "../list-executor.js";
import { listSchedulesShape } from "./shapes.js";

export const listSchedules = defineTool({
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
  inputSchema: listSchedulesShape,
  outputSchema: {
    schedules: z.array(z.object({ id: z.string(), name: z.string() }).passthrough()),
    pagination: paginationOutputShape,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (params, client) =>
    executeList<Schedule>({
      client,
      path: "/v1/schedules",
      params: { limit: params.limit, offset: params.offset },
      key: "schedules",
      context: "list schedules",
      limit: params.limit,
      offset: params.offset,
      format: params.response_format,
      render: (items) => ["# On-call schedules", "", renderSchedules(items)].join("\n"),
      // An empty list here usually means missing team access, not an empty
      // site — say so, because the API returns no error to distinguish them.
      emptyMessage:
        "No on-call schedules found. Schedules live on a team's Operations page in JSM — if you expect some, confirm the credentials can see that team.",
      hint: "Increase 'offset' to see the rest.",
    }),
});
