/**
 * jsm_assign_alert
 */

import { defineTool } from "../define.js";
import { alertAction } from "./alert-action.js";
import { asyncOutputSchema, assignShape } from "./shapes.js";

export const assignAlert = defineTool({
  name: "jsm_assign_alert",
  toolset: "alert-actions",
  endpoint: {
    method: "POST",
    path: "/v1/alerts/{id}/assign",
    body: ["accountId", "user", "source", "note"],
    // Only accountId is declared. Opsgenie parity for the actor fields — see
    // acknowledge.ts.
    allowUnknownBody: ["user", "source", "note"],
  },
  title: "Assign a JSM alert to a person",
  description: `Make one person the owner of a JSM alert, so it is clear who is working it.

Assigning names an owner; jsm_add_alert_responder adds people to notify without taking ownership away. Reach for this when triage has decided whose problem it is, and for that one alert rather than a class of them — routing rules, not assignment, are how a class of alerts finds its team.

Args:
  - alert_id (string): the full alert id (not the tinyId)
  - account_id (string): Atlassian account id of the assignee
  - note (string, optional): note recorded with the assignment
  - user (string, optional): actor name/email; defaults to the credential owner
  - source (string, optional): source label for the activity log

Returns: { "requestId": string, "result": string, "alert_id": string }

IMPORTANT: this action is asynchronous. Verify with jsm_get_request_status using the returned requestId.

**account_id is an Atlassian account id, not an email address and not a display name.** It looks like '712020:9ae5385e-6a4c-4f0e-9c02-6f8a1e21d7b1'. Both other forms are rejected. To find one: jsm_get_on_call and jsm_get_alert both return account ids for the people they name, so read the id from there rather than guessing from a name.

Examples:
  - "Assign this to whoever is on call for payments" -> jsm_get_on_call first, take the account id from the result, then assign

Constraints and errors:
  - HTTP 422 or a failed request status usually means the account id is wrong, or the account has no JSM Operations access on that team.`,
  inputSchema: assignShape,
  outputSchema: asyncOutputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (params, client) =>
    alertAction(client, "Assign", params.alert_id, "assign", {
      accountId: params.account_id,
      user: params.user,
      source: params.source,
      note: params.note,
    }),
});
