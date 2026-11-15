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
 *
 * It is split in three because code mode needs the first part without the rest:
 *
 *   fetchList              issue the GET, normalise the envelope. Nothing else.
 *   executeListFromPlan    + empty-check, truncate, paginate, render.
 *   executeList            + build the page-size parameter from the dialect.
 *
 * The split is the whole reason a code-API read is not just a handler call.
 * `executeListFromPlan` truncates to CHARACTER_LIMIT and then slices the
 * structured payload to whatever survived, because its reader is a model with a
 * context window. A script's reader is a `for` loop, and handing it 20 of 2,000
 * alerts because 2,000 would not render as markdown would defeat the point of
 * filtering in code. So code mode stops at `fetchList`.
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
import type { Paged } from "../types.js";
import type { RequestPlan } from "./define.js";
import { DEFAULT_DIALECT, isUnpaged, pageSizeParams, type PagingDialect } from "./paging.js";

/**
 * Issues the GET a collection plan describes and normalises the envelope.
 *
 * The one place a collection read reaches the network, so the `data`/`values`/
 * bare-array/`platformTeams` handling in getCollection has exactly one caller
 * in this file and code mode cannot grow a second interpretation of an envelope.
 */
export async function fetchList<T>(
  plan: RequestPlan,
  client: JsmClient,
  signal?: AbortSignal | undefined,
): Promise<Paged<T>> {
  return client.getCollection<T>(plan.path, plan.params, {
    itemsKey: plan.itemsKey,
    ...(signal ? { signal } : {}),
  });
}

/** The render half: everything a model-facing list result needs beyond the fetch. */
export interface ListRenderOptions<T> {
  client: JsmClient;
  /** Key the items sit under in structuredContent, e.g. "alerts". */
  key: string;
  /** Context for error messages, e.g. "list alerts". */
  context: string;
  /** Page size the caller asked for, reported in the pagination block. */
  limit: number;
  /** Numeric offset, for offset-paged endpoints. Omit for cursor-paged ones. */
  offset?: number | undefined;
  render: (items: T[]) => string;
  /** Shown when the API returns nothing. Say what to try next, not just "none". */
  emptyMessage: string;
  /** Appended to a truncated response, telling the model how to get the rest. */
  hint: string;
  format: ResponseFormat;
}

export interface ListToolOptions<T> extends ListRenderOptions<T> {
  /** Path below the cloud-id root, e.g. "/v1/alerts". */
  path: string;
  /**
   * Query parameters *other than* the page size. Do not pass a page size here:
   * executeList sends it, under the name the API actually reads.
   */
  params?: Record<string, unknown> | undefined;
  /**
   * How this endpoint pages. Defaults to `size` + `offset`, the common case.
   * State it for anything else — see ./paging.ts.
   */
  paging?: PagingDialect | undefined;
  /**
   * Envelope key the items sit under, for the endpoints that use neither
   * `data` nor `values` — `GET /v1/teams` answers under `platformTeams`.
   */
  itemsKey?: string | undefined;
}

/**
 * Runs a collection plan and renders it for a model.
 *
 * `plan.params` is sent verbatim, page size included: a plan is the whole
 * request. Re-deriving the page size here would mean two places decide it, and
 * the bug that cost this repo months — every list sending `limit` to endpoints
 * that read `size`, so callers asking for 100 records were told 20 was all of
 * them — was exactly one place deciding it wrongly.
 */
export async function executeListFromPlan<T>(
  plan: RequestPlan,
  options: ListRenderOptions<T>,
): Promise<ToolResult> {
  const { client, key, context, limit, offset, render, emptyMessage, hint, format } = options;
  const paging = plan.paging ?? DEFAULT_DIALECT;

  try {
    const page = await fetchList<T>(plan, client);

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
    return fail(handleApiError(error, context, { method: "GET", path: plan.path }));
  }
}

/**
 * The long-standing entry point: takes query parameters without the page size
 * and builds it from the dialect.
 *
 * Kept so the twenty-odd hand-written call sites did not all have to change
 * shape in the same commit that introduced plans. New code paths should build a
 * `RequestPlan` and call `executeListFromPlan`, which is what the family
 * factory does.
 */
export async function executeList<T>(options: ListToolOptions<T>): Promise<ToolResult> {
  const paging = options.paging ?? DEFAULT_DIALECT;
  const plan: RequestPlan = {
    method: "GET",
    path: options.path,
    params: { ...options.params, ...pageSizeParams(paging, options.limit) },
    shape: "collection",
    itemsKey: options.itemsKey,
    paging,
  };

  return executeListFromPlan<T>(plan, {
    client: options.client,
    key: options.key,
    context: options.context,
    limit: options.limit,
    offset: options.offset,
    render: options.render,
    emptyMessage: options.emptyMessage,
    hint: options.hint,
    format: options.format,
  });
}
