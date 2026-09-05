/**
 * jsm_list_alert_logs — system activity log for an alert.
 */

import { z } from "zod";

import { renderLogs } from "../../services/format.js";
import type { AlertLog } from "../../types.js";
import { defineTool } from "../define.js";
import { executeList } from "../list-executor.js";
import { alertTimelineShape, paginationOutputShape } from "./shapes.js";

export const listAlertLogs = defineTool({
  name: "jsm_list_alert_logs",
  toolset: "alerts",
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
    pagination: paginationOutputShape,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (params, client) =>
    executeList<AlertLog>({
      client,
      path: `/v1/alerts/${encodeURIComponent(params.alert_id)}/logs`,
      // `after` is the cursor parameter these endpoints read; `offset` is not
      // one of their parameters at all, so paging used to re-serve page one.
      params: { order: params.order, after: params.offset },
      key: "logs",
      context: "list alert logs",
      limit: params.limit,
      format: params.response_format,
      render: (items) =>
        [`# Activity log for alert \`${params.alert_id}\``, "", renderLogs(items)].join("\n"),
      emptyMessage: "No activity logs on this alert.",
      hint: "Page with the 'offset' cursor to see the rest.",
    }),
});
