/**
 * jsm_get_next_on_call
 */

import { z } from "zod";

import { handleApiError } from "../../services/client.js";
import { resolveIdentities } from "../../services/directory.js";
import { answerOnCall } from "./answer.js";
import { fail, identifyResponders, renderFormat, renderOnCall } from "../../services/format.js";
import { toShiftSummary } from "./shift-summary.js";
import { defineTool } from "../define.js";
import { ScheduleLookupError, resolveScheduleId } from "./resolve-schedule.js";
import { nextOnCallShape } from "./shapes.js";

export const getNextOnCall = defineTool({
  name: "jsm_get_next_on_call",
  toolset: "oncall",
  endpoint: {
    method: "GET",
    path: "/v1/schedules/{scheduleId}/next-on-calls",
    query: ["flat", "date"],
  },
  title: "Get who is on-call next",
  description: `Return the responders who take over the next shift on a JSM schedule, and when that shift begins.

Use this for handover messages and for deciding whether an alert can wait for the next rotation.

Args:
  - schedule_id (string): schedule id, or name if schedule_identifier_type='name'
  - schedule_identifier_type ('id' | 'name'): default 'id'
  - date (string, optional): ISO 8601 reference point; "next" is computed relative to it. Defaults to now
  - flat (boolean): default true — flat list of user identifiers; false shows rotation/escalation nesting
  - response_format ('markdown' | 'json'): default 'markdown'

Returns (json format):
  {
    "next_on_call": { ... },               // the API response, unmodified
    "participants": [                      // resolved, and the field to read
      { "id": string, "type": string, "displayName": string, "emailAddress": string }
    ]
  }

Responders are Atlassian account ids; this tool resolves them to names for you. If the credentials lack the Jira user scope the ids are still returned, with a note saying so.

Examples:
  - "Who picks up after this shift?" -> schedule_id=<id>
  - "Who is on after the shift that covers Thursday?" -> date="2026-08-27T12:00:00Z"
  - "Draft a handover note" -> combine with jsm_list_alerts query="status:open"

Error handling:
  - HTTP 401 here while alert tools work means the token is missing read:ops-config:jira-service-management — schedules and on-call sit behind a different scope from alerts, so this is a scope gap, not a bad credential.`,
  inputSchema: nextOnCallShape,
  outputSchema: {
    next_on_call: z.object({}).passthrough(),
    participants: z.array(z.object({ id: z.string() }).passthrough()),
    shift: z
      .object({
        start: z.string().optional(),
        end: z.string().optional(),
        rotation_id: z.string().optional(),
        rotation_name: z.string().optional(),
        type: z.string().optional(),
      })
      .optional(),
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

      const answer = await answerOnCall(client, {
        scheduleId: schedule.id,
        instant: params.date ? new Date(params.date) : new Date(),
        next: true,
        flat: params.flat,
        date: params.date,
      });

      const directory = await resolveIdentities(client, answer.responders);

      const markdown = renderOnCall(answer.responders, true, {
        scheduleLabel: schedule.name ?? params.schedule_id,
        directory,
        ...(answer.shift ? { shift: toShiftSummary(answer.shift) } : {}),
        notes: answer.notes,
        legacyShiftStart: answer.raw.exactNextOnCallTime,
      });

      return renderFormat(params.response_format, markdown, {
        next_on_call: answer.raw,
        participants: identifyResponders(answer.responders, directory),
        ...(answer.shift
          ? {
              shift: {
                start: answer.shift.start,
                end: answer.shift.end,
                rotation_id: answer.shift.rotationId,
                rotation_name: answer.shift.rotationName,
                type: answer.shift.type,
              },
            }
          : {}),
      });
    } catch (error) {
      if (error instanceof ScheduleLookupError)
        return fail(`Error (get next on-call): ${error.message}`);
      return fail(handleApiError(error, "get next on-call"));
    }
  },
});
