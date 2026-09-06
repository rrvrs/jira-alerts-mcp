/**
 * jsm_get_request_status — did that asynchronous write actually land?
 */

import { z } from "zod";

import { handleApiError } from "../../services/client.js";
import { fail, renderFormat } from "../../services/format.js";
import type { RequestStatus } from "../../types.js";
import { defineTool } from "../define.js";
import { requestStatusShape } from "./shapes.js";

export const getRequestStatus = defineTool({
  name: "jsm_get_request_status",
  toolset: "alerts",
  endpoint: { method: "GET", path: "/v1/alerts/requests/{id}" },
  title: "Check JSM async request status",
  description: `Check whether an asynchronous alert action actually succeeded.

Every JSM alert write (acknowledge, close, add note, assign, snooze) returns immediately with a requestId and does NOT apply the change synchronously. Pass that requestId here to confirm the action landed — this is the correct way to verify a write, rather than immediately re-reading the alert and finding it unchanged.

Args:
  - request_id (string): the requestId returned by a write tool
  - response_format ('markdown' | 'json'): default 'markdown'

Returns (json format):
  {
    "action": string,        // e.g. "Acknowledge"
    "isSuccess": boolean,
    "status": string,        // human-readable outcome, e.g. "Alert acknowledged"
    "processedAt": string,   // ISO 8601
    "alertId": string,
    "alias": string
  }

Examples:
  - After jsm_acknowledge_alert returns requestId "d383c6e9-..." -> request_id="d383c6e9-..."

Error handling:
  - HTTP 404 shortly after a write usually means the request is still queued; wait a second and retry.`,
  inputSchema: requestStatusShape,
  outputSchema: { request: z.object({}).passthrough() },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (params, client) => {
    try {
      const status = await client.getOne<RequestStatus>(
        `/v1/alerts/requests/${encodeURIComponent(params.request_id)}`,
      );

      const markdown = [
        `# Request \`${params.request_id}\``,
        "",
        `- **Action**: ${status.action ?? "unknown"}`,
        `- **Succeeded**: ${status.isSuccess === undefined ? "unknown" : status.isSuccess}`,
        `- **Status**: ${status.status ?? "no status returned"}`,
        `- **Processed at**: ${status.processedAt ?? "not yet processed"}`,
        ...(status.alertId ? [`- **Alert id**: \`${status.alertId}\``] : []),
      ].join("\n");

      return renderFormat(params.response_format, markdown, { request: status });
    } catch (error) {
      return fail(handleApiError(error, "get request status"));
    }
  },
});
