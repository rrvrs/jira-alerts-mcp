/**
 * jsm_add_alert_responder
 */

import { defineTool } from "../define.js";
import { alertAction } from "./alert-action.js";
import { asyncOutputSchema, addResponderShape } from "./shapes.js";

export const addAlertResponder = defineTool({
  name: "jsm_add_alert_responder",
  toolset: "alert-actions",
  endpoint: {
    method: "POST",
    path: "/v1/alerts/{id}/responders",
    body: ["id", "type", "user", "source", "note"],
    // The spec declares only id and type. Opsgenie parity for the rest.
    allowUnknownBody: ["user", "source", "note"],
  },
  title: "Add a responder to a JSM alert",
  description: `Add a responder (user, team, escalation or schedule) to an existing JSM alert so they are notified and become accountable for it.

Use this to pull in another team once triage shows the alert belongs elsewhere. Responders are additive — this does not remove the existing ones.

Args:
  - alert_id (string): the full alert id (not the tinyId)
  - responder_id (string): id of the user/team/escalation/schedule to add
  - responder_type ('user' | 'team' | 'escalation' | 'schedule'): what responder_id refers to
  - note (string, optional): note recorded with the change
  - user (string, optional): actor name/email; defaults to the credential owner
  - source (string, optional): source label for the activity log

Returns: { "requestId": string, "result": string, "alert_id": string }

IMPORTANT: this action is asynchronous. Verify with jsm_get_request_status using the returned requestId.

Examples:
  - "Page the database team on this" -> responder_id=<team id>, responder_type="team"

Error handling:
  - HTTP 422 or a failed request status usually means responder_id doesn't exist or its type is wrong. Team and schedule ids can be found with jsm_list_schedules or the JSM UI.`,
  inputSchema: addResponderShape,
  outputSchema: asyncOutputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (params, client) =>
    alertAction(client, "Add responder", params.alert_id, "responders", {
      id: params.responder_id,
      type: params.responder_type,
      user: params.user,
      source: params.source,
      note: params.note,
    }),
});
