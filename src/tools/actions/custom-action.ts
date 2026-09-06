/**
 * jsm_execute_alert_action
 */

import { defineTool } from "../define.js";
import { alertAction } from "./alert-action.js";
import { asyncOutputSchema, customActionShape } from "./shapes.js";

export const executeAlertAction = defineTool({
  name: "jsm_execute_alert_action",
  toolset: "alert-actions",
  endpoint: {
    method: "POST",
    path: "/v1/alerts/{id}/action",
    body: ["actionName"],
  },
  title: "Run a custom action on a JSM alert",
  description: `Run one of your organisation's own custom alert actions — the buttons a team wires up on an integration, like "Restart service" or "Roll back deploy".

What these do is entirely up to whoever configured them, and this server cannot see it. An action name is a request to run somebody's automation against production.

Args:
  - alert_id (string): the full alert id (not the tinyId)
  - action_name (string): the configured action's name, exactly as configured

Returns: { "requestId": string, "result": string, "alert_id": string }

IMPORTANT: this action is asynchronous. Verify with jsm_get_request_status using the returned requestId.

**Do not guess an action name.** There is no endpoint that lists them, so a plausible-sounding guess is exactly as likely to be a real destructive automation as it is to be nothing. An unrecognised name is accepted and silently does nothing, which means a successful receipt is not evidence that anything ran. Ask the user which action they mean, and confirm before running it.

Constraints and errors:
  - Names are configured per integration, so an action that exists for one alert's source may not exist for another's.`,
  inputSchema: customActionShape,
  outputSchema: asyncOutputSchema,
  annotations: {
    readOnlyHint: false,
    // What it does is defined outside this server and may be irreversible.
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (params, client) =>
    alertAction(client, `Run action '${params.action_name}'`, params.alert_id, "action", {
      actionName: params.action_name,
    }),
});
