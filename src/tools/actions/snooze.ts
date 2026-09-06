/**
 * jsm_snooze_alert
 */

import { defineTool } from "../define.js";
import { alertAction } from "./alert-action.js";
import { asyncOutputSchema, snoozeShape } from "./shapes.js";

export const snoozeAlert = defineTool({
  name: "jsm_snooze_alert",
  toolset: "alert-actions",
  endpoint: {
    method: "POST",
    path: "/v1/alerts/{id}/snooze",
    body: ["endTime"],
  },
  title: "Snooze a JSM alert until a given time",
  description: `Silence a JSM alert's notifications until a specific instant, after which it resumes as if untouched.

Snoozing is the right tool for "we know, and there is nothing to do until the maintenance window ends" — it stops the paging without pretending the alert is resolved. Closing it would remove it from the open queue and lose the fact that it is still an open problem.

Args:
  - alert_id (string): the full alert id (not the tinyId)
  - end_time (string): ISO 8601 instant with an offset, e.g. "2026-09-05T18:30:00Z"

Returns: { "requestId": string, "result": string, "alert_id": string }

IMPORTANT: this action is asynchronous. Verify with jsm_get_request_status using the returned requestId.

Time handling is the sharp edge here. end_time is an absolute instant, not a duration — "snooze for two hours" means computing the instant yourself from the current time. A past instant is accepted, and the alert un-snoozes immediately, which looks exactly like the call having failed. Send an explicit offset ('Z' or '+05:30') rather than a bare local time.

Examples:
  - "Snooze this until the deploy finishes at 6pm UTC" -> end_time="2026-09-05T18:00:00Z"
  - "Give it an hour" -> compute now + 1h as an ISO instant, then pass it

Constraints and errors:
  - Snoozing a closed alert has no useful effect; close is terminal for notification purposes.`,
  inputSchema: snoozeShape,
  outputSchema: asyncOutputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (params, client) =>
    alertAction(client, "Snooze", params.alert_id, "snooze", {
      endTime: params.end_time,
    }),
});
