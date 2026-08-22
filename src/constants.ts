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
export const SERVER_VERSION = "1.0.5";
