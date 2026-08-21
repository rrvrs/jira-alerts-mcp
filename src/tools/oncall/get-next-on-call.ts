/**
 * jsm_get_next_on_call
 */

import { z } from "zod";

import { handleApiError } from "../../services/client.js";
import { fail, renderFormat, renderOnCall } from "../../services/format.js";
import type { OnCallData } from "../../types.js";
import { defineTool } from "../define.js";
import { onCallShape } from "./shapes.js";

export const getNextOnCall = defineTool({
  name: "jsm_get_next_on_call",
  title: "Get who is on-call next",
  description: `Return the responders who take over the next shift on a JSM schedule, and when that shift begins.

Use this for handover messages and for deciding whether an alert can wait for the next rotation.

Args:
  - schedule_id (string): schedule id, or name if schedule_identifier_type='name'
  - schedule_identifier_type ('id' | 'name'): default 'id'
  - flat (boolean): default true — flat list of user identifiers; false shows rotation/escalation nesting
  - response_format ('markdown' | 'json'): default 'markdown'

Returns (json format):
  {
    "next_on_call": {
      "_parent": { "id": string, "name": string },
      "nextOnCallRecipients": string[],    // when flat=true
      "nextOnCallParticipants": [ ... ],   // when flat=false
      "exactNextOnCallTime": string        // ISO 8601 shift start
    }
  }

Examples:
  - "Who picks up after this shift?" -> schedule_id=<id>
  - "Draft a handover note" -> combine with jsm_list_alerts query="status:open"`,
  inputSchema: onCallShape,
  outputSchema: { next_on_call: z.object({}).passthrough() },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (params, client) => {
    try {
      const data = await client.getOne<OnCallData>(
        `/v1/schedules/${encodeURIComponent(params.schedule_id)}/next-on-calls`,
        {
          scheduleIdentifierType: params.schedule_identifier_type,
          flat: params.flat,
        },
      );

      return renderFormat(params.response_format, renderOnCall(data, true), {
        next_on_call: data,
      });
    } catch (error) {
      return fail(handleApiError(error, "get next on-call"));
    }
  },
});
