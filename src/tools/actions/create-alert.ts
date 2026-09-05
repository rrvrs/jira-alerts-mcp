/**
 * jsm_create_alert
 *
 * This was documented as out of scope on the grounds that creation belongs to
 * the integration API with an integration key. It does not: POST /v1/alerts is
 * part of the same API as every other tool here, takes the same credentials,
 * and needs only the write scope the other write tools already require.
 */

import { defineTool } from "../define.js";
import { executeWrite } from "../execute-write.js";
import { createAlertShape, createOutputSchema } from "./shapes.js";

export const createAlert = defineTool({
  name: "jsm_create_alert",
  toolset: "alert-actions",
  title: "Create a JSM alert",
  description: `Create a new alert in Jira Service Management Operations.

This pages people. A created alert enters the team's routing and escalation rules exactly as one raised by a monitoring integration would, so someone's phone may ring. Create one when a human wants an incident tracked and escalated — not to leave a note, which is jsm_add_alert_note, and not to record something nobody needs to act on.

Args:
  - message (string): one-line summary. The ONLY required field.
  - alias (string, optional): de-duplication key — see below
  - description (string, optional): longer detail, impact, what to try
  - priority ('P1'..'P5', optional): P1 highest; omit to let routing rules decide
  - responders (array, optional): [{ id, type }] with type 'user' | 'team' | 'escalation' | 'schedule'
  - visible_to (array, optional): [{ id, type }] with type 'user' | 'team'; max 50
  - entity (string, optional): what the alert is about, e.g. 'payments-api'
  - tags (string[], optional)
  - actions (string[], optional): names of custom actions configured in your org
  - extra_properties (object, optional): arbitrary key/value context
  - note (string, optional): note recorded on the new alert's timeline
  - user (string, optional): actor name/email; defaults to the credential owner
  - source (string, optional): source label for the activity log

Returns: { "requestId": string, "result": string, "alias": string }

IMPORTANT: this is asynchronous, and it does not return the new alert's id. The response confirms the request was accepted, not that an alert exists. Unusually for this API the status code is 200 rather than 202, which does not make it synchronous. To get the id: call jsm_get_request_status with the returned requestId, or — if you set an alias — jsm_get_alert with identifier_type='alias'.

**Alias is the de-duplication key, and it is the difference between a safe retry and a silent no-op.** Creating with an alias that already has an OPEN alert does not create a second alert; it increments the existing one's count and leaves everything else alone. That makes a retried create safe. It also means reusing an alias from an earlier, still-open incident quietly does nothing visible — so make aliases specific to the occurrence, not to the check.

Examples:
  - "Raise a P1 for the payments API being down" -> message="Payments API returning 503", priority="P1", entity="payments-api"
  - Retryable create -> alias="payments-api-503-2026-09-05T11:00"

Constraints and errors:
  - Needs write:ops-alert:jira-service-management alongside the read scope. A token with only read scopes gets 403.
  - Responders bypass the team's routing rules. Omit them unless you specifically want to route around routing.
  - HTTP 422 usually means a responder id doesn't exist or its type is wrong.`,
  inputSchema: createAlertShape,
  outputSchema: createOutputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    // An alias makes the call idempotent; without one, each call raises another
    // alert. Declared false because that is the behaviour when the argument the
    // model most often omits is omitted.
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (params, client) =>
    executeWrite(client, {
      label: "Create alert",
      method: "POST",
      path: "/v1/alerts",
      mode: "async",
      subject: { key: "alias", value: params.alias, noun: "alert" },
      body: {
        message: params.message,
        alias: params.alias,
        description: params.description,
        priority: params.priority,
        responders: params.responders,
        visibleTo: params.visible_to,
        entity: params.entity,
        tags: params.tags,
        actions: params.actions,
        extraProperties: params.extra_properties,
        note: params.note,
        user: params.user,
        source: params.source,
      },
    }),
});
