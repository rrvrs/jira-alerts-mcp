/**
 * jsm_delete_alert_attachment
 */

import { z } from "zod";

import { alertIdField } from "../../schemas/common.js";
import { defineTool } from "../define.js";
import { executeWrite } from "../execute-write.js";

export const deleteAlertAttachment = defineTool({
  name: "jsm_delete_alert_attachment",
  toolset: "alert-actions",
  endpoint: { method: "DELETE", path: "/v1/alerts/{alertId}/attachments/{id}" },
  title: "Delete a file attached to a JSM alert",
  description: `Permanently remove one attachment from a JSM alert.

Reach for this when a file should never have been attached — a screenshot with credentials in it, a log containing customer data, a file on the wrong alert. Not for tidying: an attachment is evidence of what a responder was looking at, and the alert's history is worth more than the storage.

Args:
  - alert_id (string): the full alert id (not the tinyId)
  - attachment_id (string): from jsm_list_alert_attachments

Returns: { "deleted": true, "attachment_id": string }

**There is no undo.** The file is gone when this returns. Confirm with the user first, and name the file — jsm_list_alert_attachments gives you the filename for the id — so they are deleting what they think they are.

This is synchronous: the API answers 204 with no body, so there is no requestId to verify.

Constraints and errors:
  - Needs delete:ops-alert:jira-service-management, a separate grant from write:ops-alert.`,
  inputSchema: {
    alert_id: alertIdField,
    attachment_id: z.string().min(1).describe("Attachment id from jsm_list_alert_attachments."),
  },
  outputSchema: {
    deleted: z.boolean(),
    attachment_id: z.string().optional(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (params, client) =>
    executeWrite(client, {
      label: "Delete attachment",
      method: "DELETE",
      path: `/v1/alerts/${encodeURIComponent(params.alert_id)}/attachments/${encodeURIComponent(
        params.attachment_id,
      )}`,
      mode: "deleted",
      subject: { key: "attachment_id", value: params.attachment_id, noun: "attachment" },
    }),
});
