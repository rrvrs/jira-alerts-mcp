/**
 * Input shapes and the shared output shape for the alert read tools.
 */

import { z } from "zod";

import {
  alertIdField,
  limitField,
  offsetField,
  responseFormatField,
} from "../../schemas/common.js";

/** Loose alert shape for outputSchema — passthrough so unexpected API fields never fail validation. */
export const alertOutputShape = z
  .object({
    id: z.string(),
    tinyId: z.string().optional(),
    message: z.string().optional(),
    status: z.string().optional(),
    acknowledged: z.boolean().optional(),
    priority: z.string().optional(),
    createdAt: z.string().optional(),
  })
  .passthrough();

/** Pagination block shared by every list tool's outputSchema. */
export const paginationOutputShape = z
  .object({
    count: z.number(),
    offset: z.number().optional(),
    has_more: z.boolean(),
    next_offset: z.number().optional(),
    next_cursor: z.string().optional(),
    truncated: z.boolean().optional(),
    total: z.number().optional(),
  })
  .passthrough();

export const listAlertsShape = {
  query: z
    .string()
    .max(1000)
    .optional()
    .describe(
      "JSM alert search query. Field:value syntax, combinable with AND/OR/NOT. " +
        'Examples: "status:open", "status:open AND priority:P1", "acknowledged:false AND createdAt > 1704067200000", ' +
        '"tag:database AND status:open", "teams:Payments". Omit to return the most recent alerts unfiltered.',
    ),
  limit: limitField,
  offset: offsetField,
  sort: z
    .enum([
      "createdAt",
      "updatedAt",
      "tinyId",
      "alias",
      "message",
      "status",
      "acknowledged",
      "isSeen",
      "snoozed",
      "count",
      "lastOccurredAt",
      "source",
      "owner",
      "integration.name",
      "integration.type",
    ])
    .default("createdAt")
    .describe("Field to sort by (default 'createdAt')."),
  order: z
    .enum(["asc", "desc"])
    .default("desc")
    .describe("Sort direction (default 'desc', i.e. newest first)."),
  response_format: responseFormatField,
};

export const getAlertShape = {
  identifier: z
    .string()
    .min(1)
    .describe(
      "The alert's full id, or its alias if identifier_type='alias'. The short tinyId from the UI is NOT accepted by the API — " +
        "search with jsm_list_alerts to resolve a tinyId to a full id.",
    ),
  identifier_type: z
    .enum(["id", "alias"])
    .default("id")
    .describe(
      "Which identifier was supplied. 'id' hits /v1/alerts/{id}; 'alias' hits the separate /v1/alerts/alias endpoint.",
    ),
  response_format: responseFormatField,
};

/** Shared by jsm_list_alert_notes and jsm_list_alert_logs — identical paging contract. */
export const alertTimelineShape = {
  alert_id: alertIdField,
  limit: limitField,
  order: z
    .enum(["asc", "desc"])
    .default("desc")
    .describe("Chronological order of returned entries (default 'desc', newest first)."),
  offset: z
    .string()
    .optional()
    .describe(
      "Cursor from a previous response's 'next_cursor'. These endpoints use opaque cursors, not numeric offsets.",
    ),
  response_format: responseFormatField,
};

export const requestStatusShape = {
  request_id: z
    .string()
    .min(1)
    .describe("The requestId returned by any alert write tool (acknowledge, close, note, assign, snooze)."),
  response_format: responseFormatField,
};
