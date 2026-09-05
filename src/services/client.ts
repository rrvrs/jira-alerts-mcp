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
  async getCollection<T>(path: string, params?: Record<string, unknown>): Promise<Paged<T>> {
    const raw = await this.request<Record<string, unknown>>("GET", path, {
      params,
    });

    const items = (raw.data ?? raw.values ?? []) as T[];
    const paging = (raw.paging ?? raw.links) as Paged<T>["paging"] | undefined;
    // The alerts endpoint reports the grand total under `count`, not
    // `totalCount` — reading only the latter is why `pagination.total` was
    // never populated.
    const rawTotal = raw.totalCount ?? raw.count;
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
    const raw = await this.request<Record<string, unknown>>("GET", path, {
      params,
    });
    return (raw.data ?? raw.values ?? raw) as T;
  }
}

/**
 * Converts any thrown error into a message that tells the agent what to do
 * next, not just what went wrong.
 */
export function handleApiError(error: unknown, context: string): string {
  if (error instanceof JsmConfigError) {
    return `Configuration error: ${error.message}`;
  }

  if (axios.isAxiosError(error)) {
    const axiosError = error as AxiosError<{ message?: string; errors?: unknown }>;

    if (axiosError.response) {
      const { status, data } = axiosError.response;
      const detail = data?.message ? ` API said: ${data.message}` : "";

      switch (status) {
        case 400:
          return (
            `Error (${context}): the request was rejected as invalid.${detail} ` +
            `If you passed a search query, check the field names against the JSM alert search syntax ` +
            `(e.g. status:open, priority:P1, tag:"db"). Field names are case-sensitive.`
          );
        // A missing scope surfaces here as 401, not 403, so this message must not
        // send the reader off to rotate a credential that is working fine.
        case 401:
          return (
            `Error (${context}): authentication failed.${detail} ` +
            `Either the credentials are wrong or revoked — check JSM_EMAIL/JSM_API_TOKEN (or ` +
            `JSM_OAUTH_TOKEN) — or the token lacks the scope for this endpoint. Schedules and ` +
            `on-call need read:ops-config:jira-service-management, a separate grant from ` +
            `read:ops-alert:jira-service-management. To tell the two apart in one call: if ` +
            `jsm_list_alerts succeeds and only schedule or on-call calls fail, the credentials are ` +
            `fine and read:ops-config:jira-service-management is what is missing.`
          );
        case 403:
          return (
            `Error (${context}): permission denied.${detail} ` +
            `The account needs Jira Service Management Operations access on the relevant team, plus ` +
            `the scope for this endpoint: read:ops-alert:jira-service-management for alerts, ` +
            `read:ops-config:jira-service-management for schedules and on-call, and both ` +
            `read:ops-alert:jira-service-management and write:ops-alert:jira-service-management for ` +
            `write actions — Atlassian requires the read scope alongside the write one. ` +
            `Read-only Jira scopes are not sufficient.`
          );
        case 404:
          return (
            `Error (${context}): not found.${detail} ` +
            `Note that alert endpoints accept the full alert id (a UUID with a timestamp suffix), NOT the ` +
            `short tinyId. To look up by alias, use jsm_get_alert with identifier_type='alias'.`
          );
        case 422:
          return `Error (${context}): the request was well-formed but could not be processed.${detail}`;
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
