/**
 * jsm_update_alert_note and jsm_delete_alert_note
 *
 * The only two synchronous writes in the alert family. The note endpoints
 * answer with the note itself (200) and with nothing at all (204) rather than
 * with the async receipt every other alert write returns, so neither may point
 * at jsm_get_request_status — there is no request to look up.
 */

import { renderNote } from "../../services/format.js";
import type { AlertNote } from "../../types.js";
import { defineTool } from "../define.js";
import { executeWrite } from "../execute-write.js";
import {
  deleteNoteShape,
  deletedOutputSchema,
  noteOutputSchema,
  updateNoteShape,
} from "./shapes.js";

const notePath = (alertId: string, noteId: string) =>
  `/v1/alerts/${encodeURIComponent(alertId)}/notes/${encodeURIComponent(noteId)}`;

export const updateAlertNote = defineTool({
  name: "jsm_update_alert_note",
  toolset: "alert-actions",
  endpoint: { method: "PATCH", path: "/v1/alerts/{alertId}/notes/{id}", body: ["note"] },
  title: "Edit a note on a JSM alert",
  description: `Replace the text of an existing note on a JSM alert.

Use it to correct a note you just wrote — a wrong hostname, a stale conclusion. Prefer adding a new note with jsm_add_alert_note for anything that reads as a development rather than a correction: the timeline is the record of what responders knew and when, and editing history out of it costs more than an extra line.

Args:
  - alert_id (string): the full alert id (not the tinyId)
  - note_id (string): id of the note to edit, from jsm_list_alert_notes
  - note (string): the replacement text

Returns the updated note: { "alert_id", "note_id", "note", "owner", "createdAt", "updatedAt" }

Unlike every other alert write, this one is **synchronous**. It answers with the note itself, so there is no requestId and nothing to verify with jsm_get_request_status.

**This replaces the note's whole text.** There is no append. Read the note first if you mean to add to it.

Examples:
  - "Fix my last note, the host is db-3 not db-2" -> jsm_list_alert_notes, take the id, then update with the corrected text

Constraints and errors:
  - HTTP 404 means the note id does not belong to that alert. Note ids come from jsm_list_alert_notes, not from the note's text.`,
  inputSchema: updateNoteShape,
  outputSchema: noteOutputSchema,
  annotations: {
    readOnlyHint: false,
    // Overwrites text with no way back to the previous version.
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (params, client) =>
    executeWrite<AlertNote>(client, {
      label: "Update note",
      method: "PATCH",
      path: notePath(params.alert_id, params.note_id),
      body: { note: params.note },
      mode: "sync",
      subject: { key: "alert_id", value: params.alert_id, noun: "alert" },
      render: (note) => renderNote(note),
    }),
});

export const deleteAlertNote = defineTool({
  name: "jsm_delete_alert_note",
  toolset: "alert-actions",
  endpoint: { method: "DELETE", path: "/v1/alerts/{alertId}/notes/{id}" },
  title: "Delete a note from a JSM alert",
  description: `Permanently remove a note from a JSM alert's timeline.

Reach for this only for a note that should never have been written — a pasted credential, someone's personal information, a note on the wrong alert. Not for a note that turned out to be wrong: that is what jsm_update_alert_note is for, and being able to see what a responder believed at the time is most of what the timeline is worth.

Args:
  - alert_id (string): the full alert id (not the tinyId)
  - note_id (string): id of the note to delete, from jsm_list_alert_notes

Returns: { "deleted": true, "note_id": string }

**There is no undo, and no confirmation step at the API.** The note is gone the moment this returns. Confirm with the user before calling it, and quote the note's text back to them first so they are deleting the thing they think they are.

Unlike most alert writes this is synchronous: the API answers 204 with no body, so there is no requestId to verify.

Constraints and errors:
  - Needs delete:ops-alert:jira-service-management, which is a separate grant from write:ops-alert. A token that can edit notes may still get 403 here.`,
  inputSchema: deleteNoteShape,
  outputSchema: deletedOutputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (params, client) =>
    executeWrite(client, {
      label: "Delete note",
      method: "DELETE",
      path: notePath(params.alert_id, params.note_id),
      mode: "deleted",
      subject: { key: "note_id", value: params.note_id, noun: "note" },
    }),
});
