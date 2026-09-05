/**
 * jsm_list_alert_attachments and jsm_get_alert_attachment.
 *
 * Reading attachments, not adding them. Uploading is a separate question: it
 * would be the only tool here that reads the local filesystem.
 */

import { z } from "zod";

import { handleApiError } from "../../services/client.js";
import { fail, renderAttachments, renderFormat } from "../../services/format.js";
import {
  alertIdField,
  limitField,
  responseFormatField,
  ResponseFormat,
} from "../../schemas/common.js";
import type { AlertAttachment } from "../../types.js";
import { defineTool } from "../define.js";
import { executeList } from "../list-executor.js";
import { paginationOutputShape } from "./shapes.js";

export const listAlertAttachments = defineTool({
  name: "jsm_list_alert_attachments",
  toolset: "alerts",
  endpoint: {
    method: "GET",
    path: "/v1/alerts/{alertId}/attachments",
    query: ["after", "size"],
  },
  title: "List files attached to a JSM alert",
  description: `List the files attached to a JSM alert — screenshots, logs, dashboards someone captured while working it.

Attachments carry evidence the alert's text does not: the graph that showed the spike, the stack trace, the config that was wrong. Check them before concluding an alert has no context.

Args:
  - alert_id (string): the full alert id (not the tinyId)
  - limit (number): 1-100, default 20
  - cursor (string, optional): the 'next_cursor' from a previous response
  - response_format ('markdown' | 'json'): default "markdown"

Returns (json format):
  {
    "attachments": [{ "id": string, "attachmentName": string, "insertedAt": string }],
    "pagination": { "count": number, "has_more": boolean, "next_cursor": string }
  }

This returns names and ids, not content. To read one, pass its id to jsm_get_alert_attachment, which returns a temporary download URL.

Note the id is a timestamp rendered as a string, so it is not meaningfully ordered against ids from other alerts.`,
  inputSchema: {
    alert_id: alertIdField,
    limit: limitField,
    cursor: z
      .string()
      .optional()
      .describe(
        "Cursor from a previous response's 'next_cursor'. This endpoint uses opaque cursors.",
      ),
    response_format: responseFormatField,
  },
  outputSchema: {
    attachments: z.array(z.object({}).passthrough()),
    pagination: paginationOutputShape,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (params, client) =>
    executeList<AlertAttachment>({
      client,
      path: `/v1/alerts/${encodeURIComponent(params.alert_id)}/attachments`,
      params: { after: params.cursor },
      paging: { kind: "cursor" },
      key: "attachments",
      context: "list alert attachments",
      limit: params.limit,
      format: params.response_format,
      render: (items) =>
        [`# Attachments on alert \`${params.alert_id}\``, "", renderAttachments(items)].join("\n"),
      emptyMessage: "No attachments on this alert.",
      hint: "Page with the 'cursor' argument to see the rest.",
    }),
});

export const getAlertAttachment = defineTool({
  name: "jsm_get_alert_attachment",
  toolset: "alerts",
  endpoint: { method: "GET", path: "/v1/alerts/{alertId}/attachments/{id}" },
  title: "Get a download URL for a JSM alert attachment",
  description: `Get a temporary download URL for one file attached to a JSM alert.

Args:
  - alert_id (string): the full alert id (not the tinyId)
  - attachment_id (string): from jsm_list_alert_attachments

Returns: { "alert_id": string, "attachment_id": string, "url": string }

**The URL expires**, and it is pre-authorised — anyone holding it can fetch the file without credentials for as long as it lasts. Hand it to the user to open; do not paste it anywhere it will be stored or shared, and fetch a fresh one rather than reusing an old one.

This server does not download the file. It returns the URL and stops there.

Constraints and errors:
  - HTTP 404 means the attachment id does not belong to that alert. Ids come from jsm_list_alert_attachments.`,
  inputSchema: {
    alert_id: alertIdField,
    attachment_id: z.string().min(1).describe("Attachment id from jsm_list_alert_attachments."),
  },
  outputSchema: {
    alert_id: z.string(),
    attachment_id: z.string(),
    url: z.string().optional(),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (params, client) => {
    try {
      const response = await client.getOne<{ url?: string }>(
        `/v1/alerts/${encodeURIComponent(params.alert_id)}/attachments/${encodeURIComponent(
          params.attachment_id,
        )}`,
      );

      const structured = {
        alert_id: params.alert_id,
        attachment_id: params.attachment_id,
        ...(response.url ? { url: response.url } : {}),
      };

      return renderFormat(
        ResponseFormat.MARKDOWN,
        response.url
          ? [
              `Download URL for attachment \`${params.attachment_id}\`:`,
              "",
              response.url,
              "",
              "This link is temporary and needs no credentials — give it to the user to open rather than storing or forwarding it.",
            ].join("\n")
          : `The API returned no download URL for attachment \`${params.attachment_id}\`.`,
        structured,
      );
    } catch (error) {
      return fail(handleApiError(error, "get alert attachment"));
    }
  },
});
