/**
 * jsm_list_alerts — search and list alerts.
 */

import { z } from "zod";

import { MAX_ALERT_WINDOW } from "../../constants.js";
import { fail, renderAlertLine } from "../../services/format.js";
import type { Alert } from "../../types.js";
import { defineTool } from "../define.js";
import { executeList } from "../list-executor.js";
import { paginationOutputShape } from "../../schemas/common.js";
import { alertOutputShape, listAlertsShape } from "./shapes.js";

export const listAlerts = defineTool({
  name: "jsm_list_alerts",
  toolset: "alerts",
  endpoint: {
    method: "GET",
    path: "/v1/alerts",
    query: ["query", "sort", "order", "offset", "size"],
  },
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
    pagination: paginationOutputShape,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (params, client) => {
    // Reject locally rather than spending a round trip on a guaranteed 400.
    if (params.offset + params.limit > MAX_ALERT_WINDOW) {
      return fail(
        `Error (list alerts): offset (${params.offset}) + limit (${params.limit}) exceeds the API's ${MAX_ALERT_WINDOW}-record window. ` +
          `Narrow the search with 'query' — for example add a createdAt bound — rather than paging deeper.`,
      );
    }

    return executeList<Alert>({
      client,
      path: "/v1/alerts",
      // No page size here: executeList sends it as `size`.
      params: {
        query: params.query,
        offset: params.offset,
        sort: params.sort,
        order: params.order,
      },
      key: "alerts",
      context: "list alerts",
      limit: params.limit,
      offset: params.offset,
      format: params.response_format,
      render: (items) =>
        [
          `# Alerts${params.query ? `: ${params.query}` : ""}`,
          "",
          `Showing ${items.length} alert(s), sorted by ${params.sort} ${params.order}.`,
          "",
          ...items.map(renderAlertLine),
        ].join("\n\n"),
      emptyMessage: params.query
        ? `No alerts matched '${params.query}'. Try relaxing the query — note that field names are case-sensitive and closed alerts are excluded only if you asked for status:open.`
        : "No alerts found on this site.",
      hint: "Increase 'offset' or narrow 'query' to see the rest.",
    });
  },
});
