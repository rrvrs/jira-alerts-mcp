/**
 * On-call tools: schedule discovery, who is on-call now, who is on-call next.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { JsmClient, handleApiError } from "../services/client.js";
import {
  buildPagination,
  fail,
  ok,
  renderFormat,
  renderOnCall,
  renderSchedules,
  withCharacterLimit,
} from "../services/format.js";
import {
  ResponseFormat,
  limitField,
  offsetField,
  responseFormatField,
} from "../schemas/common.js";
import type { OnCallData, Schedule } from "../types.js";

const listSchedulesShape = {
  limit: limitField,
  offset: offsetField,
  response_format: responseFormatField,
};

const onCallShape = {
  schedule_id: z
    .string()
    .min(1)
    .describe("Schedule id, or the schedule name when schedule_identifier_type='name'."),
  schedule_identifier_type: z
    .enum(["id", "name"])
    .default("id")
    .describe("Whether schedule_id holds an id or a schedule name."),
  flat: z
    .boolean()
    .default(true)
    .describe(
      "true (default) returns a flat list of on-call user identifiers. false returns the nested structure showing which rotation or escalation each person came from.",
    ),
  response_format: responseFormatField,
};

const currentOnCallShape = {
  ...onCallShape,
  date: z
    .string()
    .optional()
    .describe(
      "ISO 8601 timestamp to evaluate the rotation at, e.g. '2026-08-21T18:30:00Z'. Defaults to now. Use this to answer 'who was on-call when this fired?'",
    ),
};

type ListSchedulesInput = z.infer<z.ZodObject<typeof listSchedulesShape>>;
type CurrentOnCallInput = z.infer<z.ZodObject<typeof currentOnCallShape>>;
type NextOnCallInput = z.infer<z.ZodObject<typeof onCallShape>>;

export function registerOnCallTools(server: McpServer, client: JsmClient): void {
  server.registerTool(
    "jsm_list_schedules",
    {
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
  - "Find the schedule id for the platform rotation" -> then match on name`,
      inputSchema: listSchedulesShape,
      outputSchema: {
        schedules: z.array(z.object({ id: z.string(), name: z.string() }).passthrough()),
        pagination: z.object({ count: z.number(), has_more: z.boolean() }).passthrough(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: ListSchedulesInput) => {
      try {
        const page = await client.getCollection<Schedule>("/v1/schedules", {
          limit: params.limit,
          offset: params.offset,
        });

        if (!page.items.length) {
          return ok(
            "No on-call schedules found. Schedules live on a team's Operations page in JSM — if you expect some, confirm the credentials can see that team.",
          );
        }

        const rendered = withCharacterLimit(
          page.items,
          (items) => ["# On-call schedules", "", renderSchedules(items)].join("\n"),
          "Increase 'offset' to see the rest.",
        );

        const structured = {
          schedules: page.items.slice(0, rendered.kept),
          pagination: buildPagination(
            page.items.length,
            params.limit,
            params.offset,
            page.totalCount,
          ),
        };

        return params.response_format === ResponseFormat.JSON
          ? renderFormat(ResponseFormat.JSON, rendered.text, structured)
          : ok(rendered.text, structured);
      } catch (error) {
        return fail(handleApiError(error, "list schedules"));
      }
    },
  );

  server.registerTool(
    "jsm_get_on_call",
    {
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
    },
    async (params: CurrentOnCallInput) => {
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
  );

  server.registerTool(
    "jsm_get_next_on_call",
    {
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
    },
    async (params: NextOnCallInput) => {
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
  );
}
