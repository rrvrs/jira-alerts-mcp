/**
 * jsm_escalate_alert
 */

import { defineTool } from "../define.js";
import { alertAction } from "./alert-action.js";
import { asyncOutputSchema, escalateShape } from "./shapes.js";

export const escalateAlert = defineTool({
  name: "jsm_escalate_alert",
  toolset: "alert-actions",
  endpoint: {
    method: "POST",
    path: "/v1/alerts/{id}/escalate",
    body: ["escalationId", "user", "source", "note"],
    // Only escalationId is declared. Opsgenie parity for the actor fields —
    // see acknowledge.ts.
    allowUnknownBody: ["user", "source", "note"],
  },
  title: "Escalate a JSM alert through an escalation policy",
  description: `Push a JSM alert into an escalation policy immediately, rather than waiting for it to escalate on its own.

Use this when an alert is not getting picked up and waiting out the escalation timer is not acceptable. It pages the next people in that policy now.

Args:
  - alert_id (string): the full alert id (not the tinyId)
  - escalation_id (string): id of the escalation policy to run
  - note (string, optional): why it is being escalated
  - user (string, optional): actor name/email; defaults to the credential owner
  - source (string, optional): source label for the activity log

Returns: { "requestId": string, "result": string, "alert_id": string }

IMPORTANT: this action is asynchronous. Verify with jsm_get_request_status using the returned requestId.

This pages people out of band, ahead of the schedule they agreed to. Confirm with the user before escalating on their behalf.

**escalation_id is an escalation policy id** — not a team id and not a schedule id. The three are separate objects with separate ids, and passing the wrong one fails with 422 rather than escalating to something adjacent.

Examples:
  - "Nobody has picked this up, escalate it" -> get the escalation id for the team, then escalate

Constraints and errors:
  - HTTP 422 or a failed request status usually means escalation_id is not an escalation, or belongs to a different team than the alert.`,
  inputSchema: escalateShape,
  outputSchema: asyncOutputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (params, client) =>
    alertAction(client, "Escalate", params.alert_id, "escalate", {
      escalationId: params.escalation_id,
      user: params.user,
      source: params.source,
      note: params.note,
    }),
});
