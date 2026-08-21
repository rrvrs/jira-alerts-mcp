/**
 * Alert write tools: acknowledge, close, add note, add responder.
 *
 * Every endpoint here is asynchronous — JSM returns a requestId immediately and
 * applies the change out of band. The shared executor below encodes that
 * contract once so each tool renders the same receipt and points the agent at
 * jsm_get_request_status.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { JsmClient, handleApiError } from "../services/client.js";
import { fail, ok, renderAsyncReceipt } from "../services/format.js";
import { alertIdField, noteField, sourceField, userField } from "../schemas/common.js";
import type { AsyncActionResponse } from "../types.js";

/** Fields shared by every alert action. */
const actionBaseShape = {
  alert_id: alertIdField,
  user: userField,
  source: sourceField,
};

const asyncOutputSchema = {
  requestId: z.string().optional(),
  result: z.string().optional(),
  alert_id: z.string(),
};

/**
 * Posts an alert action and renders the async receipt. Centralised so the
 * "this is asynchronous, verify with the requestId" contract is stated
 * identically everywhere and cannot drift between tools.
 */
async function executeAction(
  client: JsmClient,
  label: string,
  alertId: string,
  path: string,
  body: Record<string, unknown>,
) {
  try {
    const response = await client.request<AsyncActionResponse>(
      "POST",
      `/v1/alerts/${encodeURIComponent(alertId)}/${path}`,
      { body },
    );

    return ok(renderAsyncReceipt(label, alertId, response), {
      requestId: response.requestId,
      result: response.result,
      alert_id: alertId,
    });
  } catch (error) {
    return fail(handleApiError(error, label.toLowerCase()));
  }
}

const acknowledgeShape = {
  ...actionBaseShape,
  note: z
    .string()
    .max(25_000)
    .optional()
    .describe("Optional note recorded alongside the acknowledgement."),
};

const closeShape = {
  ...actionBaseShape,
  note: z
    .string()
    .max(25_000)
    .optional()
    .describe("Optional note explaining the resolution. Strongly recommended — it's the record future responders will read."),
};

const addNoteShape = {
  ...actionBaseShape,
  note: noteField,
};

const addResponderShape = {
  ...actionBaseShape,
  responder_id: z
    .string()
    .min(1)
    .describe("Id of the user, team, escalation or schedule to add as a responder."),
  responder_type: z
    .enum(["user", "team", "escalation", "schedule"])
    .describe("What kind of entity responder_id refers to."),
  note: z.string().max(25_000).optional().describe("Optional note recorded with the change."),
};

type AcknowledgeInput = z.infer<z.ZodObject<typeof acknowledgeShape>>;
type CloseInput = z.infer<z.ZodObject<typeof closeShape>>;
type AddNoteInput = z.infer<z.ZodObject<typeof addNoteShape>>;
type AddResponderInput = z.infer<z.ZodObject<typeof addResponderShape>>;

export function registerAlertActionTools(server: McpServer, client: JsmClient): void {
  server.registerTool(
    "jsm_acknowledge_alert",
    {
      title: "Acknowledge a JSM alert",
      description: `Acknowledge an open JSM alert, stopping further escalation notifications for it.

Acknowledging signals that a human has picked the alert up. It does not resolve the alert — use jsm_close_alert for that. Acknowledging an already-acknowledged alert is a no-op.

Args:
  - alert_id (string): the full alert id (not the tinyId)
  - note (string, optional): note recorded with the acknowledgement
  - user (string, optional): actor name/email; defaults to the credential owner
  - source (string, optional): source label for the activity log

Returns: { "requestId": string, "result": string, "alert_id": string }

IMPORTANT: this action is asynchronous. The response confirms the request was accepted, not that the alert changed. Verify with jsm_get_request_status using the returned requestId.

Examples:
  - "Ack the Redis latency alert, I'm on it" -> alert_id=<id>, note="Investigating, RVS"`,
      inputSchema: acknowledgeShape,
      outputSchema: asyncOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: AcknowledgeInput) =>
      executeAction(client, "Acknowledge", params.alert_id, "acknowledge", {
        user: params.user,
        source: params.source,
        note: params.note,
      }),
  );

  server.registerTool(
    "jsm_close_alert",
    {
      title: "Close a JSM alert",
      description: `Close a JSM alert, marking it resolved and ending all notifications for it.

Closing is how an alert leaves the open queue. Treat it as effectively one-way: a closed alert cannot be reopened through this API, and a recurring condition will create a fresh alert (or increment a deduplicated one) rather than reviving this record. Prefer jsm_acknowledge_alert while work is still in progress.

Args:
  - alert_id (string): the full alert id (not the tinyId)
  - note (string, optional): resolution note — strongly recommended
  - user (string, optional): actor name/email; defaults to the credential owner
  - source (string, optional): source label for the activity log

Returns: { "requestId": string, "result": string, "alert_id": string }

IMPORTANT: this action is asynchronous. Verify with jsm_get_request_status using the returned requestId.

Examples:
  - "Close it, the deploy fixed it" -> alert_id=<id>, note="Resolved by rollback of build 4412"

Don't use when: the alert is still being worked — acknowledge instead.`,
      inputSchema: closeShape,
      outputSchema: asyncOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: CloseInput) =>
      executeAction(client, "Close", params.alert_id, "close", {
        user: params.user,
        source: params.source,
        note: params.note,
      }),
  );

  server.registerTool(
    "jsm_add_alert_note",
    {
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
    },
    async (params: AddNoteInput) =>
      executeAction(client, "Add note", params.alert_id, "notes", {
        note: params.note,
        user: params.user,
        source: params.source,
      }),
  );

  server.registerTool(
    "jsm_add_alert_responder",
    {
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
    },
    async (params: AddResponderInput) =>
      executeAction(client, "Add responder", params.alert_id, "responders", {
        id: params.responder_id,
        type: params.responder_type,
        user: params.user,
        source: params.source,
        note: params.note,
      }),
  );
}
