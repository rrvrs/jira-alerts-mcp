/**
 * Read-only alert tools: search, detail, notes, activity logs, request status.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MAX_ALERT_WINDOW } from "../constants.js";
import { JsmClient, handleApiError } from "../services/client.js";
import {
  buildPagination,
  emptyResult,
  fail,
  renderAlertDetail,
  renderAlertLine,
  renderFormat,
  renderLogs,
  renderNotes,
  withCharacterLimit,
} from "../services/format.js";
import {
  alertIdField,
  limitField,
  offsetField,
  responseFormatField,
} from "../schemas/common.js";
import type { Alert, AlertLog, AlertNote, RequestStatus } from "../types.js";

/** Loose alert shape for outputSchema — every field optional so unexpected API fields never fail validation. */
const alertOutputShape = z
  .object({
    id: z.string(),
    tinyId: z.string().optional(),
    message: z.string().optional(),
    status: z.string().optional(),
    acknowledged: z.boolean().optional(),
    priority: z.string().optional(),
    createdAt: z.string().optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// jsm_list_alerts
// ---------------------------------------------------------------------------

const listAlertsShape = {
  query: z
    .string()
    .max(1000)
    .optional()
    .describe(
      "JSM alert search query. Field:value syntax, combinable with AND/OR/NOT. " +
        'Examples: "status:open", "status:open AND priority:P1", "acknowledged:false AND createdAt > 1704067200000", ' +
        '"tag:database AND status:open", "teams:Payments". Omit to return the most recent alerts unfiltered.',
    ),
  limit: limitField,
  offset: offsetField,
  sort: z
    .enum([
      "createdAt",
      "updatedAt",
      "tinyId",
      "alias",
      "message",
      "status",
      "acknowledged",
      "isSeen",
      "snoozed",
      "count",
      "lastOccurredAt",
      "source",
      "owner",
      "integration.name",
      "integration.type",
    ])
    .default("createdAt")
    .describe("Field to sort by (default 'createdAt')."),
  order: z
    .enum(["asc", "desc"])
    .default("desc")
    .describe("Sort direction (default 'desc', i.e. newest first)."),
  response_format: responseFormatField,
};

type ListAlertsInput = z.infer<z.ZodObject<typeof listAlertsShape>>;

// ---------------------------------------------------------------------------
// jsm_get_alert
// ---------------------------------------------------------------------------

const getAlertShape = {
  identifier: z
    .string()
    .min(1)
    .describe(
      "The alert's full id, or its alias if identifier_type='alias'. The short tinyId from the UI is NOT accepted by the API — " +
        "search with jsm_list_alerts to resolve a tinyId to a full id.",
    ),
  identifier_type: z
    .enum(["id", "alias"])
    .default("id")
    .describe(
      "Which identifier was supplied. 'id' hits /v1/alerts/{id}; 'alias' hits the separate /v1/alerts/alias endpoint.",
    ),
  response_format: responseFormatField,
};

type GetAlertInput = z.infer<z.ZodObject<typeof getAlertShape>>;

// ---------------------------------------------------------------------------
// jsm_list_alert_notes / jsm_list_alert_logs
// ---------------------------------------------------------------------------

const alertTimelineShape = {
  alert_id: alertIdField,
  limit: limitField,
  order: z
    .enum(["asc", "desc"])
    .default("desc")
    .describe("Chronological order of returned entries (default 'desc', newest first)."),
  offset: z
    .string()
    .optional()
    .describe(
      "Cursor from a previous response's 'next_cursor'. These endpoints use opaque cursors, not numeric offsets.",
    ),
  response_format: responseFormatField,
};

type AlertTimelineInput = z.infer<z.ZodObject<typeof alertTimelineShape>>;

// ---------------------------------------------------------------------------
// jsm_get_request_status
// ---------------------------------------------------------------------------

const requestStatusShape = {
  request_id: z
    .string()
    .min(1)
    .describe("The requestId returned by any alert write tool (acknowledge, close, note, assign, snooze)."),
  response_format: responseFormatField,
};

type RequestStatusInput = z.infer<z.ZodObject<typeof requestStatusShape>>;

export function registerAlertReadTools(server: McpServer, client: JsmClient): void {
  server.registerTool(
    "jsm_list_alerts",
    {
      title: "Search JSM alerts",
      description: `Search and list alerts in Jira Service Management Operations.

This is the entry point for almost every alert workflow: use it to find open or unacknowledged alerts, filter by priority/team/tag, and to resolve a short tinyId (as shown in the JSM UI) into the full alert id that every other alert tool requires. It reads only — it never creates or modifies alerts.

Args:
  - query (string, optional): field:value search, e.g. "status:open AND priority:P1"
  - limit (number): 1-100, default 20
  - offset (number): records to skip, default 0
  - sort (string): field to sort by, default "createdAt"
  - order ('asc' | 'desc'): default "desc"
  - response_format ('markdown' | 'json'): default "markdown"

Returns (json format):
  {
    "alerts": [
      {
        "id": string,            // full alert id — pass this to other tools
        "tinyId": string,        // short id shown in the JSM UI
        "message": string,
        "status": "open" | "closed",
        "acknowledged": boolean,
        "priority": "P1".."P5",
        "count": number,         // dedupe count
        "tags": string[],
        "owner": string,
        "createdAt": string,     // ISO 8601
        "lastOccurredAt": string
      }
    ],
    "pagination": { "count": number, "offset": number, "has_more": boolean, "next_offset": number }
  }

Examples:
  - "What's on fire right now?" -> query="status:open AND acknowledged:false", sort="createdAt"
  - "Show P1s from the Payments team" -> query="priority:P1 AND teams:Payments"
  - "Find the alert about Redis latency" -> query="message:*Redis*"

Constraints and errors:
  - offset + limit must stay below ${MAX_ALERT_WINDOW}; the API refuses to page deeper.
  - A malformed query returns HTTP 400 — field names are case-sensitive.`,
      inputSchema: listAlertsShape,
      outputSchema: {
        alerts: z.array(alertOutputShape),
        pagination: z
          .object({
            count: z.number(),
            offset: z.number().optional(),
            has_more: z.boolean(),
            next_offset: z.number().optional(),
            total: z.number().optional(),
          })
          .passthrough(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: ListAlertsInput) => {
      if (params.offset + params.limit > MAX_ALERT_WINDOW) {
        return fail(
          `Error (list alerts): offset (${params.offset}) + limit (${params.limit}) exceeds the API's ${MAX_ALERT_WINDOW}-record window. ` +
            `Narrow the search with 'query' — for example add a createdAt bound — rather than paging deeper.`,
        );
      }

      try {
        const page = await client.getCollection<Alert>("/v1/alerts", {
          query: params.query,
          limit: params.limit,
          offset: params.offset,
          sort: params.sort,
          order: params.order,
        });

        if (!page.items.length) {
          return emptyResult(
            params.query
              ? `No alerts matched '${params.query}'. Try relaxing the query — note that field names are case-sensitive and closed alerts are excluded only if you asked for status:open.`
              : "No alerts found on this site.",
            "alerts",
            params.limit,
            params.offset,
          );
        }

        const rendered = withCharacterLimit(
          page.items,
          (items) =>
            [
              `# Alerts${params.query ? `: ${params.query}` : ""}`,
              "",
              `Showing ${items.length} alert(s), sorted by ${params.sort} ${params.order}.`,
              "",
              ...items.map(renderAlertLine),
            ].join("\n\n"),
          "Increase 'offset' or narrow 'query' to see the rest.",
        );

        const structured = {
          alerts: page.items.slice(0, rendered.kept),
          pagination: buildPagination({
            returned: rendered.kept,
            fetched: page.items.length,
            limit: params.limit,
            offset: params.offset,
            totalCount: page.totalCount,
          }),
        };

        return renderFormat(params.response_format, rendered.text, structured);
      } catch (error) {
        return fail(handleApiError(error, "list alerts"));
      }
    },
  );

  server.registerTool(
    "jsm_get_alert",
    {
      title: "Get JSM alert details",
      description: `Retrieve the full detail of a single JSM alert, including its description, custom details/extraProperties, responders, tags and dedupe count.

Use this after jsm_list_alerts when you need the payload an integration attached to the alert (host, service, metric values, runbook links) — the list endpoint returns a thinner record without the description or details map.

Args:
  - identifier (string): the full alert id, or an alias when identifier_type='alias'
  - identifier_type ('id' | 'alias'): default 'id'
  - response_format ('markdown' | 'json'): default 'markdown'

Returns (json format): a single alert object with id, tinyId, message, description, status, acknowledged, snoozed, priority, source, owner, tags, responders, details (custom key/value map), extraProperties, count, createdAt, updatedAt, lastOccurredAt, and a report block with acknowledgedBy/closedBy.

Examples:
  - "What does alert #4821 actually say?" -> resolve the id via jsm_list_alerts, then call with identifier=<full id>
  - "Look up the alert our pipeline created with alias 'redis-latency-prod'" -> identifier="redis-latency-prod", identifier_type="alias"

Error handling:
  - HTTP 404 usually means a tinyId was passed instead of the full id. Resolve it with jsm_list_alerts first.
  - Aliases only resolve against OPEN alerts; a closed alert must be fetched by id.`,
      inputSchema: getAlertShape,
      outputSchema: { alert: alertOutputShape },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: GetAlertInput) => {
      try {
        const alert =
          params.identifier_type === "alias"
            ? await client.getOne<Alert>("/v1/alerts/alias", { alias: params.identifier })
            : await client.getOne<Alert>(`/v1/alerts/${encodeURIComponent(params.identifier)}`);

        if (!alert?.id) {
          return fail(
            `Error (get alert): no alert found for ${params.identifier_type} '${params.identifier}'. ` +
              `If you used a tinyId, resolve it to a full id with jsm_list_alerts first.`,
          );
        }

        return renderFormat(params.response_format, renderAlertDetail(alert), { alert });
      } catch (error) {
        return fail(handleApiError(error, "get alert"));
      }
    },
  );

  server.registerTool(
    "jsm_list_alert_notes",
    {
      title: "List JSM alert notes",
      description: `List the notes (human comments) recorded on a JSM alert's activity timeline, newest first by default.

Notes are where responders write triage context, and where integrations append re-fire and resolution updates for a deduplicated alert. Read them before acting on an alert so you don't repeat work someone already did.

Args:
  - alert_id (string): the full alert id (not the tinyId)
  - limit (number): 1-100, default 20
  - order ('asc' | 'desc'): default 'desc'
  - offset (string, optional): opaque cursor from a previous response's next_cursor
  - response_format ('markdown' | 'json'): default 'markdown'

Returns (json format):
  {
    "notes": [{ "note": string, "owner": string, "createdAt": string, "offset": string }],
    "pagination": { "count": number, "has_more": boolean, "next_cursor": string }
  }

Examples:
  - "Has anyone looked at this alert yet?" -> alert_id=<id>, limit=10
  - "Read the full triage history oldest first" -> order="asc", limit=100

Note: these endpoints page with opaque cursors, not numeric offsets — pass next_cursor back as 'offset'.`,
      inputSchema: alertTimelineShape,
      outputSchema: {
        notes: z.array(z.object({ note: z.string() }).passthrough()),
        pagination: z.object({ count: z.number(), has_more: z.boolean() }).passthrough(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: AlertTimelineInput) => {
      try {
        const page = await client.getCollection<AlertNote>(
          `/v1/alerts/${encodeURIComponent(params.alert_id)}/notes`,
          { limit: params.limit, order: params.order, offset: params.offset },
        );

        const rendered = withCharacterLimit(
          page.items,
          (items) => [`# Notes on alert \`${params.alert_id}\``, "", renderNotes(items)].join("\n"),
          "Page with the 'offset' cursor to see the rest.",
        );

        const structured = {
          notes: page.items.slice(0, rendered.kept),
          pagination: buildPagination({
            returned: rendered.kept,
            fetched: page.items.length,
            limit: params.limit,
            totalCount: page.totalCount,
            nextCursor: page.paging?.next,
          }),
        };

        return renderFormat(params.response_format, rendered.text, structured);
      } catch (error) {
        return fail(handleApiError(error, "list alert notes"));
      }
    },
  );

  server.registerTool(
    "jsm_list_alert_logs",
    {
      title: "List JSM alert activity logs",
      description: `List the system activity log for a JSM alert — every state transition, notification, escalation and automated action, newest first by default.

Use this to answer "why did nobody get paged?" or "when was this escalated and to whom?". Logs are system-generated; human comments live in jsm_list_alert_notes instead.

Args:
  - alert_id (string): the full alert id (not the tinyId)
  - limit (number): 1-100, default 20
  - order ('asc' | 'desc'): default 'desc'
  - offset (string, optional): opaque cursor from a previous response's next_cursor
  - response_format ('markdown' | 'json'): default 'markdown'

Returns (json format):
  {
    "logs": [{ "log": string, "owner": string, "createdAt": string, "type": string, "offset": string }],
    "pagination": { "count": number, "has_more": boolean, "next_cursor": string }
  }

Examples:
  - "Trace the escalation path for this alert" -> alert_id=<id>, order="asc", limit=100
  - "Who acked this and when?" -> alert_id=<id>, limit=20`,
      inputSchema: alertTimelineShape,
      outputSchema: {
        logs: z.array(z.object({ log: z.string() }).passthrough()),
        pagination: z.object({ count: z.number(), has_more: z.boolean() }).passthrough(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: AlertTimelineInput) => {
      try {
        const page = await client.getCollection<AlertLog>(
          `/v1/alerts/${encodeURIComponent(params.alert_id)}/logs`,
          { limit: params.limit, order: params.order, offset: params.offset },
        );

        const rendered = withCharacterLimit(
          page.items,
          (items) => [`# Activity log for alert \`${params.alert_id}\``, "", renderLogs(items)].join("\n"),
          "Page with the 'offset' cursor to see the rest.",
        );

        const structured = {
          logs: page.items.slice(0, rendered.kept),
          pagination: buildPagination({
            returned: rendered.kept,
            fetched: page.items.length,
            limit: params.limit,
            totalCount: page.totalCount,
            nextCursor: page.paging?.next,
          }),
        };

        return renderFormat(params.response_format, rendered.text, structured);
      } catch (error) {
        return fail(handleApiError(error, "list alert logs"));
      }
    },
  );

  server.registerTool(
    "jsm_get_request_status",
    {
      title: "Check JSM async request status",
      description: `Check whether an asynchronous alert action actually succeeded.

Every JSM alert write (acknowledge, close, add note, assign, snooze) returns immediately with a requestId and does NOT apply the change synchronously. Pass that requestId here to confirm the action landed — this is the correct way to verify a write, rather than immediately re-reading the alert and finding it unchanged.

Args:
  - request_id (string): the requestId returned by a write tool
  - response_format ('markdown' | 'json'): default 'markdown'

Returns (json format):
  {
    "action": string,        // e.g. "Acknowledge"
    "isSuccess": boolean,
    "status": string,        // human-readable outcome, e.g. "Alert acknowledged"
    "processedAt": string,   // ISO 8601
    "alertId": string,
    "alias": string
  }

Examples:
  - After jsm_acknowledge_alert returns requestId "d383c6e9-..." -> request_id="d383c6e9-..."

Error handling:
  - HTTP 404 shortly after a write usually means the request is still queued; wait a second and retry.`,
      inputSchema: requestStatusShape,
      outputSchema: { request: z.object({}).passthrough() },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: RequestStatusInput) => {
      try {
        const status = await client.getOne<RequestStatus>(
          `/v1/alerts/requests/${encodeURIComponent(params.request_id)}`,
        );

        const markdown = [
          `# Request \`${params.request_id}\``,
          "",
          `- **Action**: ${status.action ?? "unknown"}`,
          `- **Succeeded**: ${status.isSuccess === undefined ? "unknown" : status.isSuccess}`,
          `- **Status**: ${status.status ?? "no status returned"}`,
          `- **Processed at**: ${status.processedAt ?? "not yet processed"}`,
          ...(status.alertId ? [`- **Alert id**: \`${status.alertId}\``] : []),
        ].join("\n");

        return renderFormat(params.response_format, markdown, { request: status });
      } catch (error) {
        return fail(handleApiError(error, "get request status"));
      }
    },
  );
}
