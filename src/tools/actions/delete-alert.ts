/**
 * jsm_delete_alert
 *
 * Previously listed as out of scope, on the grounds that deleting an alert
 * destroys audit history with no undo. That is still true, and it is now stated
 * where the model reads it rather than enforced by the tool's absence — an
 * absent tool tells the user "this server cannot", which is a different and
 * less useful claim than "this is irreversible, are you sure".
 */

import { defineTool } from "../define.js";
import { executeWrite } from "../execute-write.js";
import { asyncOutputSchema, deleteAlertShape } from "./shapes.js";

export const deleteAlert = defineTool({
  name: "jsm_delete_alert",
  toolset: "alert-actions",
  endpoint: {
    method: "DELETE",
    path: "/v1/alerts/{id}",
  },
  title: "Permanently delete a JSM alert",
  description: `Permanently delete a JSM alert and everything recorded on it.

**This is almost never the right tool.** Closing an alert with jsm_close_alert takes it out of the open queue and keeps the record: who was paged, what they tried, when it resolved. Deleting throws that away, for everyone, with no undo — the notes, the activity log, the attachments and the timing all go with it. A closed alert costs nothing to keep.

The cases that justify it are narrow: an alert containing credentials or personal data that must not persist, or a flood of alerts from a misconfigured integration that never represented anything real.

Args:
  - alert_id (string): the full alert id (not the tinyId)

Returns: { "requestId": string, "result": string, "alert_id": string }

IMPORTANT: this action is asynchronous. Verify with jsm_get_request_status using the returned requestId.

Before calling this, read the alert back with jsm_get_alert and show the user what they are about to lose — its message, its state and how many notes it carries — and get an explicit yes. Never call it to tidy up, to clear a queue, or in a loop over search results.

Constraints and errors:
  - Needs delete:ops-alert:jira-service-management, a separate grant from write:ops-alert. A token that can close alerts usually cannot delete them, and that is a deliberate configuration rather than a problem to work around.`,
  inputSchema: deleteAlertShape,
  outputSchema: asyncOutputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  // Not through alertAction: that helper appends an action segment to the path,
  // and this endpoint is the alert itself.
  handler: async (params, client) =>
    executeWrite(client, {
      label: "Delete alert",
      method: "DELETE",
      path: `/v1/alerts/${encodeURIComponent(params.alert_id)}`,
      mode: "async",
      subject: { key: "alert_id", value: params.alert_id, noun: "alert" },
    }),
});
