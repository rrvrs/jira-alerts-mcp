/**
 * jsm_add_alert_tags and jsm_remove_alert_tags
 *
 * Two tools rather than one with an `add`/`remove` switch: they differ in
 * annotation vector — removal is destructive and needs a different scope — and
 * annotations are per-tool, so collapsing them would make one of the two lie.
 */

import { defineTool } from "../define.js";
import { alertAction } from "./alert-action.js";
import { addTagsShape, asyncOutputSchema, removeTagsShape } from "./shapes.js";

export const addAlertTags = defineTool({
  name: "jsm_add_alert_tags",
  toolset: "alert-actions",
  endpoint: {
    method: "POST",
    path: "/v1/alerts/{id}/tags",
    body: ["tags", "user", "source", "note"],
    // Only `tags` is declared; Opsgenie parity for the actor fields, as in
    // acknowledge.ts.
    allowUnknownBody: ["user", "source", "note"],
  },
  title: "Add tags to a JSM alert",
  description: `Add one or more tags to a JSM alert. Tags are additive — existing ones stay.

Tags are how alerts get grouped and found later: jsm_list_alerts can filter on them (tag:"db"), and they are what turns a scattering of individual alerts into "the seventeen from last night's storage incident".

Args:
  - alert_id (string): the full alert id (not the tinyId)
  - tags (string[]): one or more tag names
  - note (string, optional): note recorded with the change
  - user (string, optional): actor name/email; defaults to the credential owner
  - source (string, optional): source label for the activity log

Returns: { "requestId": string, "result": string, "alert_id": string }

IMPORTANT: this action is asynchronous. Verify with jsm_get_request_status using the returned requestId.

Tags are case-sensitive. 'DB' and 'db' are two tags, and searches will not find one by the other — so match whatever the team already uses rather than inventing a casing.

Examples:
  - "Tag this as part of the storage incident" -> tags=["incident-2026-09-05", "storage"]`,
  inputSchema: addTagsShape,
  outputSchema: asyncOutputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (params, client) =>
    alertAction(client, "Add tags", params.alert_id, "tags", {
      tags: params.tags,
      user: params.user,
      source: params.source,
      note: params.note,
    }),
});

export const removeAlertTags = defineTool({
  name: "jsm_remove_alert_tags",
  toolset: "alert-actions",
  endpoint: {
    method: "DELETE",
    path: "/v1/alerts/{id}/tags",
    body: ["tags", "user", "source", "note"],
    // Only `tags` is declared; Opsgenie parity for the actor fields.
    allowUnknownBody: ["user", "source", "note"],
  },
  title: "Remove tags from a JSM alert",
  description: `Remove one or more tags from a JSM alert.

Args:
  - alert_id (string): the full alert id (not the tinyId)
  - tags (string[]): the tag names to remove
  - note (string, optional): note recorded with the change
  - user (string, optional): actor name/email; defaults to the credential owner
  - source (string, optional): source label for the activity log

Returns: { "requestId": string, "result": string, "alert_id": string }

IMPORTANT: this action is asynchronous. Verify with jsm_get_request_status using the returned requestId.

Removal matches exactly and is case-sensitive, so removing 'DB' leaves 'db' in place. Read the alert's current tags with jsm_get_alert first rather than guessing the casing — a removal that silently matches nothing still returns a successful receipt.

Constraints and errors:
  - Needs delete:ops-alert:jira-service-management, a separate grant from write:ops-alert. Adding tags can work where removing them returns 403.`,
  inputSchema: removeTagsShape,
  outputSchema: asyncOutputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (params, client) =>
    alertAction(
      client,
      "Remove tags",
      params.alert_id,
      "tags",
      {
        tags: params.tags,
        user: params.user,
        source: params.source,
        note: params.note,
      },
      "DELETE",
    ),
});
