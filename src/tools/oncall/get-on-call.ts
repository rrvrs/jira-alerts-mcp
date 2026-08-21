/**
 * jsm_get_on_call
 */

import { z } from "zod";

import { handleApiError } from "../../services/client.js";
import { fail, renderFormat, renderOnCall } from "../../services/format.js";
import type { OnCallData } from "../../types.js";
import { defineTool } from "../define.js";
import { currentOnCallShape } from "./shapes.js";

export const getOnCall = defineTool({
  name: "jsm_get_on_call",
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
    "on_call": {
      "_parent": { "id": string, "name": string, "enabled": boolean },
      "onCallRecipients": string[],        // when flat=true
      "onCallParticipants": [ ... ]        // when flat=false
    }
  }

Examples:
  - "Who's on-call for platform right now?" -> schedule_id="platform", schedule_identifier_type="name"
  - "Who was on-call at 03:14 UTC yesterday?" -> date="2026-08-20T03:14:00Z"

Error handling:
  - An empty result means nobody is rostered at that moment — a real and important answer, not a failure.
  - HTTP 404 means the schedule id/name is wrong; list them with jsm_list_schedules.`,
  inputSchema: currentOnCallShape,
  outputSchema: { on_call: z.object({}).passthrough() },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (params, client) => {
    try {
      const data = await client.getOne<OnCallData>(
        `/v1/schedules/${encodeURIComponent(params.schedule_id)}/on-calls`,
        {
          scheduleIdentifierType: params.schedule_identifier_type,
          flat: params.flat,
          date: params.date,
        },
      );

      return renderFormat(params.response_format, renderOnCall(data, false), {
        on_call: data,
      });
    } catch (error) {
      return fail(handleApiError(error, "get on-call"));
    }
  },
});
