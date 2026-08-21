/**
 * jsm_list_alert_notes — human comments on an alert's timeline.
 */

import { z } from "zod";

import { renderNotes } from "../../services/format.js";
import type { AlertNote } from "../../types.js";
import { defineTool } from "../define.js";
import { executeList } from "../list-executor.js";
import { alertTimelineShape, paginationOutputShape } from "./shapes.js";

export const listAlertNotes = defineTool({
  name: "jsm_list_alert_notes",
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
    pagination: paginationOutputShape,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (params, client) =>
    executeList<AlertNote>({
      client,
      path: `/v1/alerts/${encodeURIComponent(params.alert_id)}/notes`,
      params: { limit: params.limit, order: params.order, offset: params.offset },
      key: "notes",
      context: "list alert notes",
      limit: params.limit,
      // Cursor-paged, so no numeric offset — the cursor comes back via paging.next.
      format: params.response_format,
      render: (items) =>
        [`# Notes on alert \`${params.alert_id}\``, "", renderNotes(items)].join("\n"),
      emptyMessage: "No notes on this alert.",
      hint: "Page with the 'offset' cursor to see the rest.",
    }),
});
