/**
 * jsm_get_alert — full detail for a single alert, by id or alias.
 */

import { type JsmClient, handleApiError } from "../../services/client.js";
import { resolveIdentities } from "../../services/directory.js";
import { fail, renderAlertDetail, renderFormat } from "../../services/format.js";
import type { Alert } from "../../types.js";
import { defineTool } from "../define.js";
import { alertOutputShape, getAlertShape } from "./shapes.js";

export const getAlert = defineTool({
  name: "jsm_get_alert",
  toolset: "alerts",
  title: "Get JSM alert details",
  description: `Retrieve the full detail of a single JSM alert, including its description, custom details/extraProperties, responders, tags and dedupe count.

Use this after jsm_list_alerts when you need the payload an integration attached to the alert (host, service, metric values, runbook links) — the list endpoint returns a thinner record without the description or details map.

Args:
  - identifier (string): the full alert id, or an alias when identifier_type='alias'
  - identifier_type ('id' | 'alias'): default 'id'
  - response_format ('markdown' | 'json'): default 'markdown'

Returns (json format): a single alert object with id, tinyId, message, description, status, acknowledged, snoozed, priority, source, owner, tags, responders, details (custom key/value map), extraProperties, count, createdAt, updatedAt, lastOccurredAt, and a report block with acknowledgedBy/closedBy. Responder ids are resolved to names where the credentials allow it.

Examples:
  - "What does alert #4821 actually say?" -> resolve the id via jsm_list_alerts, then call with identifier=<full id>
  - "Look up the alert our pipeline created with alias 'redis-latency-prod'" -> identifier="redis-latency-prod", identifier_type="alias"

Error handling:
  - HTTP 404 usually means a tinyId was passed instead of the full id. Resolve it with jsm_list_alerts first.
  - Aliases only resolve against OPEN alerts; a closed alert must be fetched by id.`,
  inputSchema: getAlertShape,
  outputSchema: { alert: alertOutputShape },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (params, client: JsmClient) => {
    try {
      // Aliases are a different endpoint entirely, not a different id format.
      const alert =
        params.identifier_type === "alias"
          ? await client.getOne<Alert>("/v1/alerts/alias", { alias: params.identifier })
          : await client.getOne<Alert>(`/v1/alerts/${encodeURIComponent(params.identifier)}`);

      if (!alert?.id) {
        return fail(
          `Error (get alert): no alert found for ${params.identifier_type} '${params.identifier}'. ` +
            `If you used a tinyId, resolve it to a full id with jsm_list_alerts first.`,
        );
      }

      // Responders come back as bare {id, type}. Resolving them here is what
      // keeps "who is on this alert?" answerable without a second lookup.
      const responders = [...(alert.responders ?? []), ...(alert.teams ?? [])]
        .filter((responder) => responder.id)
        .map((responder) => ({
          id: responder.id!,
          ...(responder.type ? { type: responder.type } : {}),
        }));

      const directory = responders.length ? await resolveIdentities(client, responders) : undefined;

      return renderFormat(params.response_format, renderAlertDetail(alert, directory), { alert });
    } catch (error) {
      return fail(handleApiError(error, "get alert"));
    }
  },
});
