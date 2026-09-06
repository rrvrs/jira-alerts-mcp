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

import { type JsmClient, handleApiError } from "../services/client.js";
import {
  buildPagination,
  emptyResult,
  extractLinkParam,
  fail,
  renderFormat,
  withCharacterLimit,
  type ToolResult,
} from "../services/format.js";
import type { ResponseFormat } from "../schemas/common.js";
import { DEFAULT_DIALECT, isUnpaged, pageSizeParams, type PagingDialect } from "./paging.js";

export interface ListToolOptions<T> {
  client: JsmClient;
  /** Path below the cloud-id root, e.g. "/v1/alerts". */
  path: string;
  /**
   * Query parameters *other than* the page size. Do not pass a page size here:
   * executeList sends it, under the name the API actually reads.
   */
  params?: Record<string, unknown>;
  /** Key the items sit under in structuredContent, e.g. "alerts". */
  key: string;
  /** Context for error messages, e.g. "list alerts". */
  context: string;
  /**
   * Page size requested. Sent under whatever name `paging` says the endpoint
   * reads — these tools spent a long time sending `limit` to endpoints that
   * read `size`, so the API quietly served its own default (20 for alerts, 25
   * for schedules) and callers asking for 100 records were told 20 was all of
   * them. `/v1/logs` is the one endpoint where `limit` is in fact correct,
   * which is why the name is per-endpoint rather than global.
   */
  limit: number;
  /** Numeric offset, for offset-paged endpoints. Omit for cursor-paged ones. */
  offset?: number;
  /**
   * How this endpoint pages. Defaults to `size` + `offset`, the common case.
   * State it for anything else — see ./paging.ts.
   */
  paging?: PagingDialect;
  render: (items: T[]) => string;
  /** Shown when the API returns nothing. Say what to try next, not just "none". */
  emptyMessage: string;
  /** Appended to a truncated response, telling the model how to get the rest. */
  hint: string;
  format: ResponseFormat;
  /**
   * Envelope key the items sit under, for the endpoints that use neither
   * `data` nor `values` — `GET /v1/teams` answers under `platformTeams`.
   */
  itemsKey?: string | undefined;
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
  paging = DEFAULT_DIALECT,
  itemsKey,
}: ListToolOptions<T>): Promise<ToolResult> {
  try {
    const page = await client.getCollection<T>(
      path,
      { ...params, ...pageSizeParams(paging, limit) },
      { itemsKey },
    );

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
        // Cursor-paged endpoints put the next cursor in the link's `after`
        // parameter; offset-paged ones have no cursor and correctly yield
        // undefined here, leaving next_offset to do the work.
        nextCursor: extractLinkParam(page.paging?.next, "after"),
        nextLink: page.paging?.next,
        unpaged: isUnpaged(paging),
      }),
    };

    return renderFormat(format, rendered.text, structured);
  } catch (error) {
    return fail(handleApiError(error, context, { method: "GET", path }));
  }
}
