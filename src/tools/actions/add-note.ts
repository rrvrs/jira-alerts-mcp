/**
 * jsm_add_alert_note
 */

import { defineTool } from "../define.js";
import { alertAction } from "./alert-action.js";
import { asyncOutputSchema, addNoteShape } from "./shapes.js";

export const addAlertNote = defineTool({
  name: "jsm_add_alert_note",
  toolset: "alert-actions",
  endpoint: {
    method: "POST",
    path: "/v1/alerts/{id}/notes",
    body: ["note", "user", "source"],
    // The spec declares only `note`. Opsgenie parity for the other two.
    allowUnknownBody: ["user", "source"],
  },
  title: "Add a note to a JSM alert",
  description: `Append a note to a JSM alert's activity timeline without changing its state.

Use this to record triage findings, link a runbook or dashboard, or leave context for the next responder. It does not acknowledge, close, or reassign the alert.

Args:
  - alert_id (string): the full alert id (not the tinyId)
  - note (string): the note text
  - user (string, optional): actor name/email; defaults to the credential owner
  - source (string, optional): source label for the activity log

Returns: { "requestId": string, "result": string, "alert_id": string }

IMPORTANT: this action is asynchronous. Verify with jsm_get_request_status using the returned requestId.

Examples:
  - "Note that this correlates with the 14:02 deploy" -> alert_id=<id>, note="Correlates with deploy 4412 at 14:02 UTC"`,
  inputSchema: addNoteShape,
  outputSchema: asyncOutputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (params, client) =>
    alertAction(client, "Add note", params.alert_id, "notes", {
      note: params.note,
      user: params.user,
      source: params.source,
    }),
});
