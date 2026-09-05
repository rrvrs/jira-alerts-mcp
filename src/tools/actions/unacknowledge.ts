/**
 * jsm_unacknowledge_alert
 */

import { defineTool } from "../define.js";
import { alertAction } from "./alert-action.js";
import { asyncOutputSchema, unacknowledgeShape } from "./shapes.js";

export const unacknowledgeAlert = defineTool({
  name: "jsm_unacknowledge_alert",
  toolset: "alert-actions",
  endpoint: {
    method: "POST",
    path: "/v1/alerts/{id}/unacknowledge",
  },
  title: "Take back an acknowledgement on a JSM alert",
  description: `Return an acknowledged JSM alert to unacknowledged, so escalation notifications resume.

Use this when someone acked an alert they cannot actually work — picked it up by mistake, or got pulled onto something else — and it needs to go back into the escalation path so the next responder is paged. It does not close, snooze or reassign the alert.

Args:
  - alert_id (string): the full alert id (not the tinyId)

Returns: { "requestId": string, "result": string, "alert_id": string }

IMPORTANT: this action is asynchronous. Verify with jsm_get_request_status using the returned requestId.

This restarts paging. Say so before doing it on someone's behalf — the practical effect is that a phone rings.

Examples:
  - "I can't take this one after all, put it back" -> alert_id=<id>, note="Handing back, on another incident"

Constraints and errors:
  - Unacknowledging an alert that was never acknowledged is a no-op, not an error.`,
  inputSchema: unacknowledgeShape,
  outputSchema: asyncOutputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (params, client) =>
    alertAction(client, "Unacknowledge", params.alert_id, "unacknowledge"),
});
