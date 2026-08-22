/**
 * Zod fragments shared across tools.
 *
 * NOTE ON SHAPE vs OBJECT: the MCP TypeScript SDK's `registerTool` expects
 * `inputSchema` to be a *raw shape* (a plain object whose values are Zod
 * types), not a `z.object(...)`. The SDK wraps it for you. So tools below
 * compose plain objects and derive their input types with
 * `z.infer<z.ZodObject<typeof shape>>`.
 */

import { z } from "zod";
import { DEFAULT_LIMIT, MAX_LIMIT } from "../constants.js";

export enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

export const responseFormatField = z
  .nativeEnum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe(
    "Output format. 'markdown' is compact and human-readable (default); 'json' returns every field for programmatic use.",
  );

export const limitField = z
  .number()
  .int()
  .min(1)
  .max(MAX_LIMIT)
  .default(DEFAULT_LIMIT)
  .describe(`Maximum number of records to return (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`);

export const offsetField = z
  .number()
  .int()
  .min(0)
  .default(0)
  .describe(
    "Number of records to skip, for paging. Use the 'next_offset' from a previous response.",
  );

/**
 * Alert identifier. The JSM Ops API is strict here: /v1/alerts/{id} accepts
 * ONLY the full alert id. Aliases go through a separate endpoint and tinyIds
 * are not accepted at all, so tools that take an id say so explicitly.
 */
export const alertIdField = z
  .string()
  .min(1, "alert_id must not be empty")
  .describe(
    "Full alert id, e.g. '9b251e07-73c9-4907-9996-8cb53a6a20d0-1704440650350'. " +
      "This is NOT the short tinyId shown in the JSM UI — get the full id from jsm_list_alerts first.",
  );

export const noteField = z
  .string()
  .min(1, "note must not be empty")
  .max(25_000)
  .describe("Note text to record on the alert's activity timeline.");

export const userField = z
  .string()
  .optional()
  .describe(
    "Display name or email recorded as the actor for this action. Defaults to the owner of the API credentials.",
  );

export const sourceField = z
  .string()
  .optional()
  .describe("Free-text source label shown in the alert activity log, e.g. 'claude-mcp'.");
