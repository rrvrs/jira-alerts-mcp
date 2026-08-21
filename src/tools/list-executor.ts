/**
 * The shared pipeline behind every list tool.
 *
 * This exists because the four list handlers used to each carry their own copy
 * of: fetch, empty-check, truncate, build pagination, pick a format. Two bugs
 * lived in those copies — an empty page returned `ok(text)` with no structured
 * payload, which the SDK rejects when an outputSchema is declared, and the
 * pagination block was computed from the untruncated page, so `next_offset`
 * skipped every record truncation had dropped. Both were fixed in every copy.
 * There is now one copy.
 */

import { JsmClient, handleApiError } from "../services/client.js";
import {
  buildPagination,
  emptyResult,
  fail,
  renderFormat,
  withCharacterLimit,
  type ToolResult,
} from "../services/format.js";
import type { ResponseFormat } from "../schemas/common.js";

export interface ListToolOptions<T> {
  client: JsmClient;
  /** Path below the cloud-id root, e.g. "/v1/alerts". */
  path: string;
  /** Query parameters. `undefined` values are dropped by axios. */
  params?: Record<string, unknown>;
  /** Key the items sit under in structuredContent, e.g. "alerts". */
  key: string;
  /** Context for error messages, e.g. "list alerts". */
  context: string;
  /** Page size requested, used to decide whether more records exist. */
  limit: number;
  /** Numeric offset, for offset-paged endpoints. Omit for cursor-paged ones. */
  offset?: number;
  render: (items: T[]) => string;
  /** Shown when the API returns nothing. Say what to try next, not just "none". */
  emptyMessage: string;
  /** Appended to a truncated response, telling the model how to get the rest. */
  hint: string;
  format: ResponseFormat;
}

export async function executeList<T>({
  client,
  path,
  params,
  key,
  context,
  limit,
  offset,
  render,
  emptyMessage,
  hint,
  format,
}: ListToolOptions<T>): Promise<ToolResult> {
  try {
    const page = await client.getCollection<T>(path, params);

    // An empty page is an ordinary answer, not an error — but it still has to
    // ship a structured payload or the SDK rejects the whole result.
    if (!page.items.length) {
      return emptyResult(emptyMessage, key, limit, offset);
    }

    const rendered = withCharacterLimit(page.items, render, hint);

    const structured = {
      [key]: page.items.slice(0, rendered.kept),
      pagination: buildPagination({
        returned: rendered.kept,
        fetched: page.items.length,
        limit,
        offset,
        totalCount: page.totalCount,
        nextCursor: page.paging?.next,
      }),
    };

    return renderFormat(format, rendered.text, structured);
  } catch (error) {
    return fail(handleApiError(error, context));
  }
}
