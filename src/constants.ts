/**
 * Shared constants for the JSM Operations (alerts) MCP server.
 */

/** Root of the JSM Ops REST API. The cloudId is appended at request time. */
export const API_ROOT = "https://api.atlassian.com/jsm/ops/api";

/** Maximum characters returned in a single tool response before truncation kicks in. */
export const CHARACTER_LIMIT = 25_000;

/** Default HTTP timeout in milliseconds. */
export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * The alerts search endpoint refuses to page beyond 20,000 records:
 * offset + limit must stay under this ceiling.
 */
export const MAX_ALERT_WINDOW = 20_000;

/** Default page size for list operations. */
export const DEFAULT_LIMIT = 20;

/** Hard cap on page size accepted by the alerts endpoints. */
export const MAX_LIMIT = 100;

/** Server identity reported over the MCP handshake. */
export const SERVER_NAME = "jira-alerts-mcp";
export const SERVER_VERSION = "1.1.0";

/**
 * Root of the Jira platform REST API, used only to turn account ids into
 * names. The cloudId is appended at request time, exactly as for API_ROOT.
 */
export const JIRA_API_ROOT = "https://api.atlassian.com/ex/jira";

/**
 * Account ids per /rest/api/3/user/bulk request. The endpoint's own
 * `maxResults` default is 10, so both the batch size and maxResults have to be
 * sent explicitly or a larger rotation silently loses names.
 */
export const USER_LOOKUP_BATCH = 50;

/** Upper bound on cached identity lookups, so a long session cannot grow without limit. */
export const IDENTITY_CACHE_MAX = 500;

/**
 * Timeline window, in weeks, and how far before the instant of interest it
 * starts. The API begins a range at the start of the `intervalUnit` containing
 * the date given, so asking for the current week alone would clip a shift that
 * began the night before and report a handover that never happened. Starting a
 * week earlier keeps the instant interior and the boundaries honest.
 */
export const TIMELINE_WEEKS = 3;
export const TIMELINE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
