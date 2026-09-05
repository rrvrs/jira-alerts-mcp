/**
 * jsm_acknowledge_alert
 */

import { defineTool } from "../define.js";
import { executeAction } from "./execute-action.js";
import { asyncOutputSchema, acknowledgeShape } from "./shapes.js";

export const acknowledgeAlert = defineTool({
  name: "jsm_acknowledge_alert",
  toolset: "alert-actions",
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
    executeAction(client, "Acknowledge", params.alert_id, "acknowledge", {
      user: params.user,
      source: params.source,
      note: params.note,
    }),
});
