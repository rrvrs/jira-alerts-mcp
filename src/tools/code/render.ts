/**
 * How a dispatched result is handed to the model.
 *
 * A dispatched read returns rows untruncated — that is the point of the data
 * layer. But until a sandbox exists, the reader of those rows IS the model, so
 * something has to keep a 5,000-row sweep from becoming 5 MB of context. This
 * file is that something, and it is deliberately the only place in code mode
 * that truncates.
 *
 * The distinction worth keeping clear: list-executor truncates because its
 * output is markdown for a model. This truncates for the same reason. The
 * dispatcher does not, because its caller may be a script that wants all of
 * them. When jsm_run arrives, it will use the dispatcher directly and none of
 * this will apply to it.
 */

import { CHARACTER_LIMIT } from "../../constants.js";

export interface RenderedResult {
  /** JSON text for the model to read. */
  text: string;
  /**
   * The same value the text shows, after trimming.
   *
   * This is what goes in structuredContent — NOT the untrimmed result. Many
   * clients hand structuredContent to the model, so trimming the text and
   * shipping the full payload beside it trims nothing: a sweep returned 13,600
   * characters of text and 3.2 MB of structured content. list-executor slices
   * its structured payload to what survived for exactly this reason.
   */
  value: unknown;
  /** True when rows were dropped to fit. */
  truncated: boolean;
  /** Rows returned by the API, before anything was dropped. */
  fetched?: number;
  /** Rows the text actually contains. */
  shown?: number;
}

const INDENT = 2;

/** Rows that fit the budget, found by halving. Mirrors withCharacterLimit's approach. */
function fitRows(rows: unknown[], envelope: (kept: unknown[]) => unknown): RenderedResult {
  let kept = rows.length;
  let value = envelope(rows);
  let text = JSON.stringify(value, null, INDENT);

  while (text.length > CHARACTER_LIMIT && kept > 0) {
    kept = Math.floor(kept / 2);
    value = envelope(rows.slice(0, kept));
    text = JSON.stringify(value, null, INDENT);
  }

  return {
    text,
    value,
    truncated: kept < rows.length,
    fetched: rows.length,
    shown: kept,
  };
}

/**
 * Renders whatever the dispatcher returned.
 *
 * Collections are trimmed row-wise so the result stays valid JSON a model can
 * parse — cutting the string at a byte offset would hand it a truncated object
 * and an invented parse error. A non-collection is reported whole or not at
 * all: there is no honest way to halve one object, and the shapes this API
 * returns for a single record are small.
 */
export function renderResult(result: unknown): RenderedResult {
  if (result && typeof result === "object" && "items" in result && Array.isArray(result.items)) {
    const { items, ...rest } = result as { items: unknown[] } & Record<string, unknown>;
    return fitRows(items, (kept) => ({ ...rest, items: kept }));
  }

  const text = JSON.stringify(result ?? null, null, INDENT);
  if (text.length <= CHARACTER_LIMIT) return { text, value: result ?? null, truncated: false };

  const refusal = {
    error: `This operation returned ${text.length} characters, past the ${CHARACTER_LIMIT}-character response limit, and a single record cannot be trimmed without corrupting it. Narrow the request.`,
  };
  return { text: JSON.stringify(refusal, null, INDENT), value: refusal, truncated: true };
}
