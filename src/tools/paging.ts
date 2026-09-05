/**
 * How a JSM Operations endpoint wants to be paged.
 *
 * There is no single answer, which is the whole reason this file exists. Across
 * the API: 19 endpoints take `size` + `offset`, three take `size` + an opaque
 * `after` cursor, `/v1/logs` takes `limit` + `pageToken` and does not know what
 * `size` means, `/v1/jec/channels` takes `size` with no position parameter, and
 * three endpoints — including `GET /v1/teams` — accept no paging parameters at
 * all.
 *
 * executeList used to send `size` unconditionally, which is right for 23 of
 * those and wrong for the rest: `/v1/logs` would silently serve its own default
 * page size, and an unpaged endpoint would be sent a parameter it ignores while
 * being reported as having a next page forever.
 */

/** The paging contract of one endpoint. */
export type PagingDialect =
  /** `size` + numeric `offset`. The common case. */
  | { kind: "offset" }
  /** `size` + an opaque cursor the caller passes through `params`. */
  | { kind: "cursor" }
  /** `limit` + `pageToken`. Only `/v1/logs`. */
  | { kind: "token" }
  /** `size`, with no way to ask for a later page. */
  | { kind: "sizeOnly" }
  /** No paging parameters at all. */
  | { kind: "none" };

export const DEFAULT_DIALECT: PagingDialect = { kind: "offset" };

/**
 * The page-size parameter for a dialect, under the name that endpoint reads.
 *
 * Returns nothing for an unpaged endpoint: sending a parameter it does not
 * declare is harmless today but records a false belief about the endpoint in
 * the one place a reader would check.
 */
export function pageSizeParams(dialect: PagingDialect, limit: number): Record<string, number> {
  switch (dialect.kind) {
    case "token":
      return { limit };
    case "none":
      return {};
    default:
      return { size: limit };
  }
}

/**
 * Whether the endpoint can serve a later page at all.
 *
 * Drives `has_more`. Without this, the "a full page probably means more"
 * heuristic reports has_more forever on an endpoint that returns its entire
 * collection in one response and happens to hold exactly `limit` records — and
 * a caller that trusts it pages the same records until it gives up.
 */
export function isUnpaged(dialect: PagingDialect): boolean {
  return dialect.kind === "none";
}
