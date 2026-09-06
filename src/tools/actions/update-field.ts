/**
 * jsm_update_alert_field
 *
 * Three PATCH endpoints behind one tool. They qualify for collapsing because
 * they share an annotation vector and an input shape, differing only in which
 * value is being set — see CONTRIBUTING. Splitting them into three tools would
 * spend three slots to say the same thing three times.
 */

import { fail } from "../../services/format.js";
import { defineTool } from "../define.js";
import { alertAction } from "./alert-action.js";
import { asyncOutputSchema, updateFieldShape } from "./shapes.js";

const PRIORITIES = new Set(["P1", "P2", "P3", "P4", "P5"]);

export const updateAlertField = defineTool({
  name: "jsm_update_alert_field",
  toolset: "alert-actions",
  endpoint: [
    { method: "PATCH", path: "/v1/alerts/{id}/priority", body: ["priority"] },
    { method: "PATCH", path: "/v1/alerts/{id}/message", body: ["message"] },
    { method: "PATCH", path: "/v1/alerts/{id}/description", body: ["description"] },
  ],
  title: "Update a JSM alert's priority, message or description",
  description: `Overwrite one field on an existing JSM alert: its priority, its message, or its description.

This is how an alert gets corrected once triage knows more than the integration that raised it did — a P3 that turns out to be customer-facing, a message that says "check failed" when it should say which check, a description that should carry what has been tried.

Args:
  - alert_id (string): the full alert id (not the tinyId)
  - field ('priority' | 'message' | 'description'): which field to overwrite
  - value (string): the new value

There are no 'user' or 'source' arguments here, unlike the other write tools: these three endpoints take only the value.

Returns: { "requestId": string, "result": string, "alert_id": string }

IMPORTANT: this action is asynchronous. Verify with jsm_get_request_status using the returned requestId.

**This overwrites, it does not append.** Reading the current value first with jsm_get_alert is the difference between adding context to a description and destroying what someone else wrote in it. If you mean to add to the record without replacing anything, use jsm_add_alert_note instead — notes are additive and are what the activity timeline is for.

For field='priority', value must be exactly one of P1, P2, P3, P4, P5 — not "high", not "1", not "p1".

Examples:
  - "This is worse than we thought, make it a P1" -> field="priority", value="P1"
  - "Fix the alert title to name the failing endpoint" -> read it first, then field="message"

Constraints and errors:
  - Raising priority may change who is paged, since routing and escalation rules read it.`,
  inputSchema: updateFieldShape,
  outputSchema: asyncOutputSchema,
  annotations: {
    readOnlyHint: false,
    // Overwrites a field rather than adding to one, and the previous value is
    // not recoverable through this API.
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (params, client) => {
    if (params.field === "priority" && !PRIORITIES.has(params.value)) {
      // Caught here rather than in the schema because `value`'s type depends on
      // `field`, and rejecting it with the reason beats a 422 from the API.
      return fail(
        `Error (update alert priority): '${params.value}' is not a JSM priority. ` +
          "Use exactly one of P1, P2, P3, P4, P5 — P1 is highest.",
      );
    }

    // No user/source in the body. Unlike acknowledge and close — where the spec
    // declares no request body at all and the actor fields ride on Opsgenie
    // parity — these three endpoints enumerate exactly one property each, so
    // sending more would advertise an actor override they do not implement.
    return alertAction(
      client,
      `Update ${params.field}`,
      params.alert_id,
      params.field,
      { [params.field]: params.value },
      "PATCH",
    );
  },
});
