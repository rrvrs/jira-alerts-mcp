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
export const SERVER_VERSION = "2.2.0";

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

/**
 * Budgets for code mode, where one tool call can issue many requests.
 *
 * A classic tool call is one request, so the client is the rate limiter and
 * nothing here was needed. A dispatched call can auto-page, and a script can
 * fan out, so the ceiling has to live in this process — and it has to be a
 * ceiling the model cannot raise, because the model is what writes the call.
 *
 * Each pair is a default an operator may lower or raise by environment, and a
 * hard limit that environment cannot exceed. The hard limits are what keep a
 * misconfiguration from becoming a way to hammer Atlassian with someone's
 * credential; see tools/code/limits.ts for the clamping.
 */

/** Wall clock for one dispatched call or script, in milliseconds. */
export const CODE_TIMEOUT_MS = 10_000;
export const CODE_TIMEOUT_MS_MAX = 60_000;

/** HTTP requests per invocation, shared across every operation it calls. */
export const CODE_MAX_REQUESTS = 60;
export const CODE_MAX_REQUESTS_MAX = 200;

/** Records materialised per invocation, across every collection it reads. */
export const CODE_MAX_RECORDS = 5_000;
export const CODE_MAX_RECORDS_MAX = 20_000;

/** Pages one auto-paged read may fetch. */
export const CODE_MAX_PAGES = 50;
export const CODE_MAX_PAGES_MAX = 200;

/**
 * Concurrent outbound requests per invocation.
 *
 * The reason this exists rather than letting a script's Promise.all run free:
 * handleApiError has a 429 branch, which is evidence the API throttles. Code
 * mode's first visible effect on a busy site should not be rate-limit errors
 * that classic mode never produced.
 */
export const CODE_MAX_INFLIGHT = 4;
export const CODE_MAX_INFLIGHT_MAX = 8;

/**
 * Sandbox limits for jsm_run, which executes model-written JavaScript.
 *
 * The script runs in a child `node --permission` process with an empty
 * environment: no filesystem, no network, no subprocesses, no workers, and no
 * credential to find. These bound what it can spend before it is killed.
 */

/** Heap for the sandbox child, in megabytes, via --max-old-space-size. */
export const CODE_MEMORY_MB = 64;
export const CODE_MEMORY_MB_MAX = 256;

/** Scripts longer than this are refused before a process is spawned. */
export const CODE_MAX_SCRIPT_CHARS = 65_536;

/**
 * Sandbox processes this server will run at once.
 *
 * The HTTP transport builds a fresh server per request, so without a
 * process-wide cap ten concurrent jsm_run calls would mean ten node processes
 * at 64 MB each. Over capacity the tool returns a retryable error, which a
 * model handles far better than a call that hangs until the client times out.
 */
export const CODE_MAX_CONCURRENT = 2;
export const CODE_MAX_CONCURRENT_MAX = 8;

/** Log lines one script may emit. Beyond this the script is told it was cut off. */
export const CODE_MAX_LOG_LINES = 1_000;
