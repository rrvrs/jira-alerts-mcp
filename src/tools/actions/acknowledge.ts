/**
 * jsm_acknowledge_alert
 */

import { defineTool } from "../define.js";
import { alertAction } from "./alert-action.js";
import { asyncOutputSchema, acknowledgeShape } from "./shapes.js";

export const acknowledgeAlert = defineTool({
  name: "jsm_acknowledge_alert",
  toolset: "alert-actions",
  endpoint: {
    method: "POST",
    path: "/v1/alerts/{id}/acknowledge",
    body: ["user", "source", "note"],
    // The spec declares no request body for this endpoint at all — not an empty
    // one, none. Opsgenie accepted user/source/note here and JSM Operations is
    // a rehost, so these are sent on parity grounds. Worth confirming against a
    // tenant: if the activity log shows the note, the spec is thin; if it does
    // not, drop them from the shape rather than sending fields nothing reads.
    allowUnknownBody: ["user", "source", "note"],
  },
  title: "Acknowledge a JSM alert",
  description: `Acknowledge an open JSM alert, stopping further escalation notifications for it.

Acknowledging signals that a human has picked the alert up. It does not resolve the alert — use jsm_close_alert for that. Acknowledging an already-acknowledged alert is a no-op.

Args:
  - alert_id (string): the full alert id (not the tinyId)
  - note (string, optional): note recorded with the acknowledgement
  - user (string, optional): actor name/email; defaults to the credential owner
  - source (string, optional): source label for the activity log

Returns: { "requestId": string, "result": string, "alert_id": string }

IMPORTANT: this action is asynchronous. The response confirms the request was accepted, not that the alert changed. Verify with jsm_get_request_status using the returned requestId.

Examples:
  - "Ack the Redis latency alert, I'm on it" -> alert_id=<id>, note="Investigating, RVS"`,
  inputSchema: acknowledgeShape,
  outputSchema: asyncOutputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (params, client) =>
    alertAction(client, "Acknowledge", params.alert_id, "acknowledge", {
      user: params.user,
      source: params.source,
      note: params.note,
    }),
});
