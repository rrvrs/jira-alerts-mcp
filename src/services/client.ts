/**
 * Authenticated HTTP client for the JSM Operations REST API.
 *
 * Auth precedence:
 *   1. JSM_OAUTH_TOKEN  -> Authorization: Bearer <token>   (3LO / Forge app tokens)
 *   2. JSM_EMAIL + JSM_API_TOKEN -> HTTP Basic             (Atlassian account API token)
 *
 * Both are scoped by JSM_CLOUD_ID, which identifies the Atlassian site.
 */

import axios, { type AxiosError, type AxiosInstance } from "axios";
import { API_ROOT, JIRA_API_ROOT, REQUEST_TIMEOUT_MS } from "../constants.js";
import type { Paged } from "../types.js";

export interface JsmConfig {
  cloudId: string;
  // `| undefined` is deliberate under exactOptionalPropertyTypes: loadConfig
  // builds this from process.env and passes the key through even when unset,
  // so these are present-and-undefined rather than absent.
  email?: string | undefined;
  apiToken?: string | undefined;
  oauthToken?: string | undefined;
}

/** Thrown for auth/config problems detected before any network call. */
export class JsmConfigError extends Error {}

/**
 * Reads configuration from the environment and fails loudly if the server
 * cannot possibly authenticate. Called once at startup so misconfiguration
 * surfaces immediately rather than on the first tool call.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): JsmConfig {
  const cloudId = env.JSM_CLOUD_ID?.trim();
  if (!cloudId) {
    throw new JsmConfigError(
      "JSM_CLOUD_ID is required. Find it at https://<your-site>.atlassian.net/_edge/tenant_info " +
        "or via GET https://api.atlassian.com/oauth/token/accessible-resources.",
    );
  }

  const oauthToken = env.JSM_OAUTH_TOKEN?.trim();
  const email = env.JSM_EMAIL?.trim();
  const apiToken = env.JSM_API_TOKEN?.trim();

  if (!oauthToken && !(email && apiToken)) {
    throw new JsmConfigError(
      "No credentials found. Set either JSM_OAUTH_TOKEN, or both JSM_EMAIL and JSM_API_TOKEN " +
        "(create a token at https://id.atlassian.com/manage-profile/security/api-tokens).",
    );
  }

  return { cloudId, email, apiToken, oauthToken };
}

export class JsmClient {
  private readonly http: AxiosInstance;
  /**
   * Second instance for the Jira platform API, which lives behind a different
   * gateway path than JSM Operations but takes the same credentials and the
   * same cloudId. Used only to resolve account ids to display names.
   */
  private readonly jira: AxiosInstance;

  constructor(config: JsmConfig) {
    const common = {
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(config.oauthToken ? { Authorization: `Bearer ${config.oauthToken}` } : {}),
      },
      ...(config.oauthToken
        ? {}
        : { auth: { username: config.email!, password: config.apiToken! } }),
    };

    this.http = axios.create({ ...common, baseURL: `${API_ROOT}/${config.cloudId}` });
    this.jira = axios.create({ ...common, baseURL: `${JIRA_API_ROOT}/${config.cloudId}` });
  }

  /**
   * Issues a request and returns the raw response body.
   * Query params with `undefined` values are dropped by axios automatically.
   */
  async request<T>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    options: { params?: Record<string, unknown> | undefined; body?: unknown } = {},
  ): Promise<T> {
    const response = await this.http.request<T>({
      method,
      url: path,
      params: options.params,
      data: options.body,
    });
    return response.data;
  }

  /**
   * Issues a GET for a collection endpoint and normalises the envelope.
   *
   * The JSM Ops API returns collections under `data` on Opsgenie-derived
   * endpoints and under `values` on newer ones. Rather than guess per
   * endpoint, accept both and expose a single shape to the tools.
   */
  async getCollection<T>(
    path: string,
    params?: Record<string, unknown>,
    options: { itemsKey?: string | undefined } = {},
  ): Promise<Paged<T>> {
    const raw = await this.request<unknown>("GET", path, {
      params,
    });

    // Two envelopes escape the `data`/`values` convention entirely, and both
    // fail silently rather than loudly: GET /v1/teams returns
    // {platformTeams: [...]}, and GET /v1/teams/{teamId}/roles returns a bare
    // JSON array. Either would normalise to [] and be reported as "none found"
    // against a populated tenant — a wrong answer, not an error.
    if (Array.isArray(raw)) {
      return { items: raw as T[], paging: undefined, totalCount: undefined };
    }

    const envelope = (raw ?? {}) as Record<string, unknown>;
    const items = (
      options.itemsKey
        ? (envelope[options.itemsKey] ?? [])
        : (envelope.data ?? envelope.values ?? [])
    ) as T[];
    const paging = (envelope.paging ?? envelope.links) as Paged<T>["paging"] | undefined;
    // The alerts endpoint reports the grand total under `count`, not
    // `totalCount` — reading only the latter is why `pagination.total` was
    // never populated.
    const rawTotal = envelope.totalCount ?? envelope.count;
    const totalCount = typeof rawTotal === "number" ? rawTotal : undefined;

    return { items: Array.isArray(items) ? items : [], paging, totalCount };
  }

  /**
   * GET against the Jira platform API rather than JSM Operations.
   *
   * Deliberately does no envelope unwrapping: the Jira API has its own
   * conventions and callers here want the body as-is.
   */
  async jiraGet<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    const response = await this.jira.request<T>({ method: "GET", url: path, params });
    return response.data;
  }

  /** GET for endpoints returning a single object under `data`/`values`. */
  async getOne<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    const raw = await this.request<unknown>("GET", path, {
      params,
    });
    return unwrapEnvelope<T>(raw);
  }
}

/**
 * Strips the `data`/`values` envelope from a single-object response.
 *
 * Exported because reads are not the only callers: POST /v1/users/contacts and
 * the PATCH, activate and deactivate endpoints beside it answer
 * `{message, data}`, so a write that reported the body verbatim while its
 * sibling get unwrapped it handed the model the envelope where it expected the
 * contact — the id came back undefined and the object could not be read back.
 * A get and its sibling write disagreeing about the envelope is the bug; one
 * definition here is what keeps them from drifting apart again.
 */
export function unwrapEnvelope<T>(raw: unknown): T {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return raw as T;
  }
  const envelope = raw as Record<string, unknown>;
  return (envelope.data ?? envelope.values ?? envelope) as T;
}

/**
 * What was being called, so an auth failure can name the scope that endpoint
 * actually needs instead of reciting the same alert-shaped advice everywhere.
 */
export interface ErrorHints {
  method?: string | undefined;
  /** Path below the cloud-id root, e.g. "/v1/alerts/{id}/tags". */
  path?: string | undefined;
}

/** The scope family an ops path belongs to. */
function scopeFamily(path: string): "ops-alert" | "ops-config" | "stakeholder-comms" {
  // Order matters: /v1/alerts/policies is configuration, not an alert, and
  // sits under the alerts prefix.
  if (path.startsWith("/v1/alerts/policies")) return "ops-config";
  if (path.startsWith("/v1/alerts")) return "ops-alert";
  if (path.startsWith("/v1/status-pages") || path.startsWith("/v1/stakeholder")) {
    return "stakeholder-comms";
  }
  return "ops-config";
}

/**
 * Names the scope the called endpoint needs, and the caveats that are true of
 * it. Everything asserted here was checked against a live tenant on 2026-09-05
 * — see the notes in each branch.
 */
function scopeAdvice(hints: ErrorHints | undefined): string {
  if (!hints?.path) {
    return (
      "Alerts need read:ops-alert:jira-service-management; schedules, teams and other " +
      "configuration need read:ops-config:jira-service-management, which is a separate grant. " +
      "Write endpoints need the matching write: scope alongside the read one."
    );
  }

  const { path, method } = hints;

  // Attachments are the awkward case, and were misdiagnosed once already. A
  // token missing the delete scopes is refused at the gateway with a bare
  // "scope does not match", which reads like an auth dead end — and the
  // OpenAPI document declares no OAuth scope for these four endpoints, which
  // seemed to confirm it. A second token on the SAME account got through the
  // gateway and drew "Feature not available in your plan" instead, so the
  // wall is the site's plan, not the auth method. Both were checked against a
  // live tenant on 2026-09-05.
  if (path.includes("/attachments")) {
    return (
      "The alert attachment endpoints are gated twice over. The API's own OpenAPI document " +
      "declares no OAuth scope for them, and on a site whose plan excludes attachments they " +
      "answer 'Feature not available in your plan' even for a fully scoped token. Check the " +
      "site's plan before treating this as a credentials problem; a wider token will not open " +
      "a feature the plan does not include."
    );
  }

  const family = scopeFamily(path);
  const verb = method === "DELETE" ? "delete" : method && method !== "GET" ? "write" : "read";
  const needed =
    verb === "read"
      ? `read:${family}:jira-service-management`
      : `read:${family}:jira-service-management and ${verb}:${family}:jira-service-management`;

  if (verb === "delete") {
    // The delete scopes are granted per token, not per authentication method.
    // Two Atlassian account API tokens for the same account were checked
    // against a live tenant on 2026-09-05: the first was refused on every
    // DELETE with this exact "scope does not match", and the second carried
    // the delete scopes and completed the whole set. So "API tokens cannot
    // delete" is the wrong conclusion to draw from this error, and telling
    // the user to switch to OAuth sends them to rebuild an integration when
    // reissuing the token would have done.
    return (
      `This endpoint needs ${needed}, and the credentials in use do not carry the delete half. ` +
      "That grant is a property of the individual token rather than of API-token auth: another " +
      "token on the same account can hold it. Reissue JSM_API_TOKEN with the delete scopes " +
      "included, or supply a 3LO or Forge OAuth token via JSM_OAUTH_TOKEN. Retrying with these " +
      "same credentials will fail identically."
    );
  }

  return (
    `This endpoint needs ${needed}. ` +
    (family === "ops-config"
      ? "read:ops-config:jira-service-management is a separate grant from the alert scopes: if " +
        "jsm_list_alerts works and only this call fails, the credentials are fine and the config " +
        "scope is what is missing."
      : "Atlassian requires the read scope alongside the write one, not the write scope alone.")
  );
}

/**
 * Turns an error body into the one sentence worth showing the caller.
 *
 * Three envelopes are in use, and each of the last two was found by a request
 * that came back saying nothing useful:
 *
 *   1. `{message}` on the Opsgenie-derived endpoints.
 *   2. `{errors: [{title, detail}]}` on the newer ones, usually with no
 *      `message` at all — GET /v1/roles answers this way, and reading only
 *      `message` threw away its whole explanation ("You're not authorized to
 *      do operations for Custom User Roles") and left a generic 403.
 *   3. `{message, errors: {field: reason}}` — a field-to-reason map, *next to*
 *      a message that is only "Request body is not processable. Please check
 *      the errors." Reading `message` first and stopping there is how POST
 *      /v1/notification-rules/{id}/steps reported a rejected field without
 *      ever naming the field or the reason. The map is the entire content of
 *      that answer, so it is appended rather than used as a fallback.
 *
 * Case 3 also has to be *detected*, not assumed: `errors.map` is a function on
 * an array and undefined on the map, so treating them alike throws inside the
 * error handler and replaces a 422 with a TypeError.
 */
function describeApiError(data: {
  message?: string;
  errors?: Array<{ title?: string; detail?: string }> | Record<string, string>;
}): string | undefined {
  const errors = data?.errors;

  if (Array.isArray(errors)) {
    const joined = errors
      .map((e) => e.detail ?? e.title)
      .filter(Boolean)
      .join("; ");
    return data?.message ?? (joined || undefined);
  }

  // The field map. Keys arrive with stray whitespace from the API itself —
  // one live response named the field "contact " — so they are trimmed.
  const fields =
    errors && typeof errors === "object"
      ? Object.entries(errors)
          .map(([field, reason]) => `${field.trim()}: ${reason}`)
          .join("; ")
      : "";

  if (data?.message && fields) return `${data.message} (${fields})`;
  return data?.message ?? (fields || undefined);
}

/**
 * Phrases the API uses when the site's plan, not the request, is the problem.
 * Matched against the response text because the status code does not settle
 * it: heartbeats answer 402, attachments answer 403, and both mean the same
 * thing to the caller.
 */
const PLAN_LIMIT = /not available in your plan|upgrade your (pricing )?plan/i;

function planLimitMessage(context: string, detail: string): string {
  return (
    `Error (${context}): this feature is not included in the site's JSM plan.${detail} ` +
    `This is a billing limit rather than a fault: the request was well-formed and the ` +
    `credentials are fine. Report it to the user — retrying, changing scopes or altering ` +
    `the request will not help.`
  );
}

/**
 * Converts any thrown error into a message that tells the agent what to do
 * next, not just what went wrong.
 *
 * `hints` carries the method and path so the scope advice can be specific.
 * Without it the advice stays generic rather than guessing — an earlier version
 * hardcoded alert-shaped advice into every 401, 403 and 404, which meant a
 * failing attachment read was answered with a lecture about on-call schedules
 * and an instruction to check working credentials.
 */
export function handleApiError(error: unknown, context: string, hints?: ErrorHints): string {
  if (error instanceof JsmConfigError) {
    return `Configuration error: ${error.message}`;
  }

  if (axios.isAxiosError(error)) {
    const axiosError = error as AxiosError<{
      message?: string;
      errors?: Array<{ title?: string; detail?: string }> | Record<string, string>;
    }>;

    if (axiosError.response) {
      const { status, data } = axiosError.response;
      const reported = describeApiError(data);
      const detail = reported ? ` API said: ${reported}` : "";

      switch (status) {
        case 400:
          return (
            `Error (${context}): the request was rejected as invalid.${detail} ` +
            `If you passed a search query, check the field names against the JSM alert search syntax ` +
            `(e.g. status:open, priority:P1, tag:"db"). Field names are case-sensitive.`
          );
        // A missing scope surfaces here as 401, not 403, so this message must not
        // send the reader off to rotate a credential that is working fine. The
        // API distinguishes the two itself: "scope does not match" is a scope
        // problem and the credentials are good.
        case 401: {
          const scopeProblem = /scope does not match/i.test(data?.message ?? "");
          if (scopeProblem) {
            return (
              `Error (${context}): the credentials are valid but are not granted what this ` +
              `endpoint requires.${detail} ${scopeAdvice(hints)}`
            );
          }
          return (
            `Error (${context}): authentication failed.${detail} ` +
            `Either the credentials are wrong or revoked — check JSM_EMAIL/JSM_API_TOKEN (or ` +
            `JSM_OAUTH_TOKEN) — or the token lacks the scope for this endpoint. ` +
            `${scopeAdvice(hints)}`
          );
        }
        case 403:
          // A plan limit can arrive as 403 rather than 402 — the attachment
          // endpoints answer "Feature not available in your plan" that way.
          // Falling through to the scope advice would send the caller off to
          // widen a token that is already sufficient.
          if (PLAN_LIMIT.test(reported ?? "")) return planLimitMessage(context, detail);
          return (
            `Error (${context}): permission denied.${detail} ` +
            `The account needs Jira Service Management Operations access on the relevant team, plus ` +
            `the scope for this endpoint. ${scopeAdvice(hints)} ` +
            `Read-only Jira scopes are not sufficient.`
          );
        case 404: {
          // The tinyId advice is true of alert endpoints and misleading
          // everywhere else, so it is now conditional on the path.
          const alertShaped = !hints?.path || scopeFamily(hints.path) === "ops-alert";
          return (
            `Error (${context}): not found.${detail} ` +
            (alertShaped
              ? `Note that alert endpoints accept the full alert id (a UUID with a timestamp ` +
                `suffix), NOT the short tinyId. To look up by alias, use jsm_get_alert with ` +
                `identifier_type='alias'.`
              : `Check the id against the corresponding list tool — ids are not interchangeable ` +
                `between resource types.`)
          );
        }
        case 422:
          return `Error (${context}): the request was well-formed but could not be processed.${detail}`;
        // 402 is a plan limit, not a fault. Without this it falls through to
        // the generic branch, which reads like something to debug or retry —
        // heartbeats answer 402 on every endpoint when the site's plan does not
        // include them.
        case 402:
          return planLimitMessage(context, detail);
        case 429:
          return (
            `Error (${context}): rate limited by Atlassian.${detail} ` +
            `Wait a few seconds and retry, and reduce 'limit' or the number of parallel calls.`
          );
        default:
          if (status >= 500) {
            return (
              `Error (${context}): JSM returned a server error (HTTP ${status}).${detail} ` +
              `This is usually transient — retry once before reporting it.`
            );
          }
          return `Error (${context}): request failed with HTTP ${status}.${detail}`;
      }
    }

    if (axiosError.code === "ECONNABORTED") {
      return (
        `Error (${context}): the request timed out after ${REQUEST_TIMEOUT_MS / 1000}s. ` +
        `Retry with a smaller 'limit', or narrow the query.`
      );
    }

    return (
      `Error (${context}): could not reach api.atlassian.com (${axiosError.code ?? "network error"}). ` +
      `Check network access and any proxy settings.`
    );
  }

  return `Error (${context}): ${error instanceof Error ? error.message : String(error)}`;
}
