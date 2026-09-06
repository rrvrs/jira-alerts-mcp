/**
 * jsm_get_schedule_timeline
 */

import { z } from "zod";

import { handleApiError } from "../../services/client.js";
import { resolveIdentities } from "../../services/directory.js";
import { fail, renderFormat, renderTimeline } from "../../services/format.js";
import { defineTool } from "../define.js";
import { ScheduleLookupError, resolveScheduleId } from "./resolve-schedule.js";
import { timelineShape } from "./shapes.js";
import { fetchTimeline, respondersOf, toShifts } from "./timeline.js";

export const getScheduleTimeline = defineTool({
  name: "jsm_get_schedule_timeline",
  toolset: "oncall",
  endpoint: {
    method: "GET",
    path: "/v1/schedules/{scheduleId}/timeline",
    query: ["interval", "intervalUnit", "date", "expand"],
  },
  title: "Get a schedule's shift boundaries",
  description: `Return the on-call rotation periods for a JSM schedule — who covers each shift, and exactly when each shift starts and ends.

This is the tool for any question about shift boundaries rather than a single moment: "when does the current shift end?", "when is the handover?", "who covers the weekend?", "show me next week's rota". Answering those by calling jsm_get_on_call at guessed timestamps takes many calls and still cannot find a boundary exactly; this takes one.

Responders are resolved to names, so periods come back with people rather than bare account ids.

Args:
  - schedule_id (string): schedule id, or name if schedule_identifier_type='name'
  - schedule_identifier_type ('id' | 'name'): default 'id'
  - date (string, optional): ISO 8601 instant the window should cover; defaults to now
  - response_format ('markdown' | 'json'): default 'markdown'

Returns (json format):
  {
    "shifts": [
      {
        "start": string,           // ISO 8601
        "end": string,             // ISO 8601
        "rotation_name": string,
        "type": "base" | "override" | "forwarding" | "historical",
        "responders": [ { "id": string, "displayName": string, "emailAddress": string } ]
      }
    ]
  }

The window spans roughly three weeks around the requested date, so both the shift in progress and the ones on either side of it are included.

Examples:
  - "When does the current on-call shift end?" -> schedule_id=<id>
  - "Who has the rota next week?" -> date=<a date next week>
  - "When did the handover happen on Tuesday?" -> date="2026-08-25T00:00:00Z"

Error handling:
  - Periods of type 'historical' are in the past; 'override' means someone swapped in.
  - HTTP 401 here while alert tools work means the token is missing read:ops-config:jira-service-management — the same scope the other on-call tools need.`,
  inputSchema: timelineShape,
  outputSchema: {
    shifts: z.array(
      z.object({ responders: z.array(z.object({ id: z.string() }).passthrough()) }).passthrough(),
    ),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (params, client) => {
    try {
      const schedule = await resolveScheduleId(
        client,
        params.schedule_id,
        params.schedule_identifier_type,
      );

      const instant = params.date ? new Date(params.date) : new Date();
      const timeline = await fetchTimeline(client, schedule.id, instant);
      const shifts = toShifts(timeline);

      // One batched lookup for every responder in the window, rather than one
      // per period — the same rotation repeats the same handful of people.
      const directory = await resolveIdentities(client, respondersOf(shifts));

      const markdown = renderTimeline(shifts, {
        scheduleLabel: schedule.name ?? params.schedule_id,
        directory,
      });

      return renderFormat(params.response_format, markdown, {
        shifts: shifts.map((shift) => ({
          start: shift.start,
          end: shift.end,
          rotation_id: shift.rotationId,
          rotation_name: shift.rotationName,
          type: shift.type,
          responders: shift.responders.map((responder) => ({
            id: responder.id ?? "",
            ...(responder.type ? { type: responder.type } : {}),
            ...directory.names.get(responder.id ?? ""),
          })),
        })),
      });
    } catch (error) {
      if (error instanceof ScheduleLookupError) {
        return fail(`Error (get schedule timeline): ${error.message}`);
      }
      return fail(
        handleApiError(error, "get schedule timeline", { method: "GET", path: "/v1/schedules" }),
      );
    }
  },
});
