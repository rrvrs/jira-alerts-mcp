/**
 * jsm_get_on_call
 */

import { z } from "zod";

import { handleApiError } from "../../services/client.js";
import { resolveIdentities } from "../../services/directory.js";
import { answerOnCall } from "./answer.js";
import { fail, identifyResponders, renderFormat, renderOnCall } from "../../services/format.js";
import { toShiftSummary } from "./shift-summary.js";
import { defineTool } from "../define.js";
import { ScheduleLookupError, resolveScheduleId } from "./resolve-schedule.js";
import { currentOnCallShape } from "./shapes.js";

export const getOnCall = defineTool({
  name: "jsm_get_on_call",
  toolset: "oncall",
  endpoint: {
    method: "GET",
    path: "/v1/schedules/{scheduleId}/on-calls",
    query: ["flat", "date"],
  },
  title: "Get who is on-call now",
  description: `Return the responders currently on-call for a JSM schedule, optionally evaluated at a past or future timestamp.

This is the tool for "who do I wake up?" and, with the 'date' argument, for "who was on-call when this incident started?" — which is often the more useful question during a post-incident review.

Args:
  - schedule_id (string): schedule id, or name if schedule_identifier_type='name'
  - schedule_identifier_type ('id' | 'name'): default 'id'
  - date (string, optional): ISO 8601 timestamp to evaluate at; defaults to now
  - flat (boolean): default true — flat list of user identifiers; false shows rotation/escalation nesting
  - response_format ('markdown' | 'json'): default 'markdown'

Returns (json format):
  {
    "on_call": { ... },                    // the API response, unmodified
    "participants": [                      // resolved, and the field to read
      { "id": string, "type": string, "displayName": string, "emailAddress": string }
    ]
  }

Responders are Atlassian account ids; this tool resolves them to names for you, so there is no need to look an id up elsewhere. If the credentials lack the Jira user scope the ids are still returned, with a note saying so.

Examples:
  - "Who's on-call for platform right now?" -> schedule_id="platform", schedule_identifier_type="name"
  - "Who was on-call at 03:14 UTC yesterday?" -> date="2026-08-20T03:14:00Z"

Error handling:
  - An empty result means nobody is rostered at that moment — a real and important answer, not a failure.
  - HTTP 404 means the schedule id/name is wrong; list them with jsm_list_schedules.
  - HTTP 401 here while alert tools work means the token is missing read:ops-config:jira-service-management — schedules and on-call sit behind a different scope from alerts, so this is a scope gap, not a bad credential.`,
  inputSchema: currentOnCallShape,
  outputSchema: {
    on_call: z.object({}).passthrough(),
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
  /**
   * The raw answer, for the code API.
   *
   * `fetch` rather than `plan` because this is not one request: it resolves the
   * schedule, asks /on-calls and the timeline in parallel, and batches an
   * identity lookup. A script could issue those itself, and would get the
   * TIMELINE_LOOKBACK_MS correction wrong — the API starts a range at the
   * beginning of the interval containing the date given, so asking for the
   * current week alone clips a shift that began the night before and reports a
   * handover that never happened. Exposing the composite is the point: code
   * execution is for the composition nobody anticipated, not a reason to make
   * everyone re-derive the ones already got right.
   *
   * The client handed in here is already budgeted, so each of these calls is
   * charged, deadline-bound and queued without this function doing anything.
   */
  fetch: async (params, client) => {
    const schedule = await resolveScheduleId(
      client,
      params.schedule_id,
      params.schedule_identifier_type,
    );
    const answer = await answerOnCall(client, {
      scheduleId: schedule.id,
      instant: params.date ? new Date(params.date) : new Date(),
      next: false,
      flat: params.flat,
      date: params.date,
    });
    const directory = await resolveIdentities(client, answer.responders);

    return {
      schedule: { id: schedule.id, name: schedule.name ?? null },
      on_call: answer.raw,
      participants: identifyResponders(answer.responders, directory),
      shift: answer.shift ?? null,
      // Carried, not dropped: these say what could not be determined, and a
      // script reporting "nobody is on call" without them would be guessing.
      notes: answer.notes,
    };
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
        next: false,
        flat: params.flat,
        date: params.date,
      });

      const directory = await resolveIdentities(client, answer.responders);

      const markdown = renderOnCall(answer.responders, false, {
        scheduleLabel: schedule.name ?? params.schedule_id,
        directory,
        ...(answer.shift ? { shift: toShiftSummary(answer.shift) } : {}),
        notes: answer.notes,
        legacyShiftStart: answer.raw.exactNextOnCallTime,
      });

      return renderFormat(params.response_format, markdown, {
        on_call: answer.raw,
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
        return fail(`Error (get on-call): ${error.message}`);
      return fail(handleApiError(error, "get on-call", { method: "GET", path: "/v1/schedules" }));
    }
  },
});
