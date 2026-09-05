/**
 * jsm_add_alert_extra_properties and jsm_remove_alert_extra_properties
 */

import { defineTool } from "../define.js";
import { alertAction } from "./alert-action.js";
import {
  addExtraPropertiesShape,
  asyncOutputSchema,
  removeExtraPropertiesShape,
} from "./shapes.js";

export const addAlertExtraProperties = defineTool({
  name: "jsm_add_alert_extra_properties",
  toolset: "alert-actions",
  endpoint: {
    method: "POST",
    path: "/v1/alerts/{id}/extra-properties",
    body: ["extraProperties"],
  },
  title: "Attach key/value properties to a JSM alert",
  description: `Attach arbitrary key/value context to a JSM alert, or overwrite properties already on it.

Extra properties are the structured half of an alert, next to the prose in its description: a runbook link, the region, the deploy that preceded it, a trace id. Unlike a note they can be read back programmatically by whatever picks the alert up next.

Args:
  - alert_id (string): the full alert id (not the tinyId)
  - extra_properties (object): key/value pairs; values may be strings, numbers or booleans

Returns: { "requestId": string, "result": string, "alert_id": string }

IMPORTANT: this action is asynchronous. Verify with jsm_get_request_status using the returned requestId.

This merges by key: keys not mentioned are left alone, and a key that already exists is **overwritten without warning**. Read the alert first with jsm_get_alert if you need to know what a key currently holds.

Examples:
  - "Note the runbook on this alert" -> extra_properties={"runbook": "https://wiki/runbooks/db-failover"}`,
  inputSchema: addExtraPropertiesShape,
  outputSchema: asyncOutputSchema,
  annotations: {
    readOnlyHint: false,
    // Merges by key, but silently replaces the value of a key that exists.
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (params, client) =>
    alertAction(client, "Add extra properties", params.alert_id, "extra-properties", {
      extraProperties: params.extra_properties,
    }),
});

export const removeAlertExtraProperties = defineTool({
  name: "jsm_remove_alert_extra_properties",
  toolset: "alert-actions",
  endpoint: {
    method: "DELETE",
    path: "/v1/alerts/{id}/extra-properties",
    body: ["keys"],
  },
  title: "Remove key/value properties from a JSM alert",
  description: `Remove properties from a JSM alert by key.

Args:
  - alert_id (string): the full alert id (not the tinyId)
  - keys (string[]): the property keys to remove — keys, not values

Returns: { "requestId": string, "result": string, "alert_id": string }

IMPORTANT: this action is asynchronous. Verify with jsm_get_request_status using the returned requestId.

A key that is not present is not an error, so a receipt here does not prove anything was removed. Read the alert back if that matters.

Constraints and errors:
  - Needs delete:ops-alert:jira-service-management, a separate grant from write:ops-alert.`,
  inputSchema: removeExtraPropertiesShape,
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
      "Remove extra properties",
      params.alert_id,
      "extra-properties",
      {
        keys: params.keys,
      },
      "DELETE",
    ),
});
