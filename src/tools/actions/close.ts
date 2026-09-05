/**
 * jsm_close_alert
 */

import { defineTool } from "../define.js";
import { alertAction } from "./alert-action.js";
import { asyncOutputSchema, closeShape } from "./shapes.js";

export const closeAlert = defineTool({
  name: "jsm_close_alert",
  toolset: "alert-actions",
  endpoint: {
    method: "POST",
    path: "/v1/alerts/{id}/close",
    body: ["user", "source", "note"],
    // No body declared in the spec — same Opsgenie-parity reasoning as
    // acknowledge.ts, and the same thing to confirm on a tenant.
    allowUnknownBody: ["user", "source", "note"],
  },
  title: "Close a JSM alert",
  description: `Close a JSM alert, marking it resolved and ending all notifications for it.

Closing is how an alert leaves the open queue. Treat it as effectively one-way: a closed alert cannot be reopened through this API, and a recurring condition will create a fresh alert (or increment a deduplicated one) rather than reviving this record. Prefer jsm_acknowledge_alert while work is still in progress.

Args:
  - alert_id (string): the full alert id (not the tinyId)
  - note (string, optional): resolution note — strongly recommended
  - user (string, optional): actor name/email; defaults to the credential owner
  - source (string, optional): source label for the activity log

Returns: { "requestId": string, "result": string, "alert_id": string }

IMPORTANT: this action is asynchronous. Verify with jsm_get_request_status using the returned requestId.

Examples:
  - "Close it, the deploy fixed it" -> alert_id=<id>, note="Resolved by rollback of build 4412"

Don't use when: the alert is still being worked — acknowledge instead.`,
  inputSchema: closeShape,
  outputSchema: asyncOutputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (params, client) =>
    alertAction(client, "Close", params.alert_id, "close", {
      user: params.user,
      source: params.source,
      note: params.note,
    }),
});
