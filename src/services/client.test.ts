/**
 * Tests for configuration loading, envelope normalisation and error mapping.
 *
 * All offline: `loadConfig` already accepts an injected env, and
 * `getCollection` is exercised through a subclass that overrides the public
 * `request` method, so no HTTP and no live tenant are involved.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AxiosError, AxiosHeaders } from "axios";

import { REQUEST_TIMEOUT_MS } from "../constants.js";
import { JsmClient, JsmConfigError, handleApiError, loadConfig } from "./client.js";

/** assert.throws does not hand back the error, so capture it ourselves. */
function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail("expected the call to throw");
}

const validEnv = {
  JSM_CLOUD_ID: "cloud-id",
  JSM_EMAIL: "you@example.com",
  JSM_API_TOKEN: "token",
} as NodeJS.ProcessEnv;

describe("loadConfig", () => {
  it("accepts an email + API token pair", () => {
    const config = loadConfig(validEnv);
    assert.equal(config.cloudId, "cloud-id");
    assert.equal(config.email, "you@example.com");
    assert.equal(config.apiToken, "token");
  });

  it("accepts an OAuth token on its own", () => {
    const config = loadConfig({
      JSM_CLOUD_ID: "cloud-id",
      JSM_OAUTH_TOKEN: "bearer",
    } as NodeJS.ProcessEnv);
    assert.equal(config.oauthToken, "bearer");
    assert.equal(config.email, undefined);
  });

  it("refuses to start without a cloud id, and says where to find one", () => {
    const error = captureError(() =>
      loadConfig({ JSM_EMAIL: "a@b.c", JSM_API_TOKEN: "t" } as NodeJS.ProcessEnv),
    );
    assert.ok(error instanceof JsmConfigError);
    assert.match(error.message, /JSM_CLOUD_ID is required/);
    assert.match(error.message, /_edge\/tenant_info/);
  });

  it("refuses to start with no credentials at all", () => {
    const error = captureError(() => loadConfig({ JSM_CLOUD_ID: "cloud-id" } as NodeJS.ProcessEnv));
    assert.ok(error instanceof JsmConfigError);
    assert.match(error.message, /No credentials found/);
    assert.match(error.message, /api-tokens/);
  });

  it("refuses a half-configured basic auth pair", () => {
    assert.throws(
      () => loadConfig({ JSM_CLOUD_ID: "c", JSM_EMAIL: "a@b.c" } as NodeJS.ProcessEnv),
      JsmConfigError,
    );
    assert.throws(
      () => loadConfig({ JSM_CLOUD_ID: "c", JSM_API_TOKEN: "t" } as NodeJS.ProcessEnv),
      JsmConfigError,
    );
  });

  it("trims surrounding whitespace, which shell exports pick up easily", () => {
    const config = loadConfig({
      JSM_CLOUD_ID: "  cloud-id  ",
      JSM_OAUTH_TOKEN: "\tbearer\n",
    } as NodeJS.ProcessEnv);
    assert.equal(config.cloudId, "cloud-id");
    assert.equal(config.oauthToken, "bearer");
  });

  it("treats a whitespace-only value as absent rather than as a credential", () => {
    assert.throws(() => loadConfig({ JSM_CLOUD_ID: "   " } as NodeJS.ProcessEnv), JsmConfigError);
    assert.throws(
      () => loadConfig({ JSM_CLOUD_ID: "c", JSM_OAUTH_TOKEN: "   " } as NodeJS.ProcessEnv),
      JsmConfigError,
    );
  });
});

/**
 * Returns a client whose `request` yields the given raw body, so envelope
 * normalisation can be tested without a network round trip.
 */
function clientReturning(raw: unknown): JsmClient {
  return new (class extends JsmClient {
    override async request<T>(): Promise<T> {
      return raw as T;
    }
  })(loadConfig(validEnv));
}

describe("JsmClient.getCollection", () => {
  it("reads items from the Opsgenie-style `data` key", async () => {
    const page = await clientReturning({ data: [{ id: "a" }, { id: "b" }] }).getCollection("/x");
    assert.equal(page.items.length, 2);
  });

  it("reads items from the newer `values` key", async () => {
    const page = await clientReturning({ values: [{ id: "a" }] }).getCollection("/x");
    assert.equal(page.items.length, 1);
  });

  it("prefers `data` when an endpoint returns both", async () => {
    const page = await clientReturning({
      data: [{ id: "from-data" }],
      values: [{ id: "from-values" }],
    }).getCollection<{ id: string }>("/x");
    assert.equal(page.items[0]?.id, "from-data");
  });

  it("reads a named key for envelopes that use neither", async () => {
    // GET /v1/teams answers under `platformTeams`. Without this it normalises
    // to [] and a populated tenant is reported as having no teams — a wrong
    // answer rather than an error, which is the failure mode worth testing.
    const page = await clientReturning({ platformTeams: [{ id: "t" }] }).getCollection(
      "/v1/teams",
      undefined,
      {
        itemsKey: "platformTeams",
      },
    );
    assert.equal(page.items.length, 1);
  });

  it("accepts a bare array, which GET /v1/teams/{id}/roles returns", async () => {
    const page = await clientReturning([{ id: "r1" }, { id: "r2" }]).getCollection("/x");
    assert.equal(page.items.length, 2);
  });

  it("returns an empty list when neither key is present", async () => {
    const page = await clientReturning({ something: "else" }).getCollection("/x");
    assert.deepEqual(page.items, []);
  });

  it("returns an empty list rather than a non-array, so callers can always map", async () => {
    // Guards the README's advice that this normaliser is the first thing to
    // inspect when a list tool returns nothing against data you know exists.
    const page = await clientReturning({ data: { id: "not-an-array" } }).getCollection("/x");
    assert.deepEqual(page.items, []);
  });

  it("accepts paging under either `paging` or `links`", async () => {
    const paged = await clientReturning({ data: [], paging: { next: "n1" } }).getCollection("/x");
    assert.equal(paged.paging?.next, "n1");

    const linked = await clientReturning({ data: [], links: { next: "n2" } }).getCollection("/x");
    assert.equal(linked.paging?.next, "n2");
  });

  it("passes totalCount through only when it is numeric", async () => {
    const numeric = await clientReturning({ data: [], totalCount: 42 }).getCollection("/x");
    assert.equal(numeric.totalCount, 42);

    const stringy = await clientReturning({ data: [], totalCount: "42" }).getCollection("/x");
    assert.equal(stringy.totalCount, undefined);
  });
});

describe("JsmClient.getOne", () => {
  it("unwraps a `data` envelope", async () => {
    const one = await clientReturning({ data: { id: "a" } }).getOne<{ id: string }>("/x");
    assert.equal(one.id, "a");
  });

  it("falls back to the raw body when there is no envelope", async () => {
    const one = await clientReturning({ id: "a" }).getOne<{ id: string }>("/x");
    assert.equal(one.id, "a");
  });
});

/** Builds an AxiosError carrying an HTTP response, as axios would on a 4xx/5xx. */
function httpError(status: number, message?: string): AxiosError {
  const config = { headers: new AxiosHeaders() };
  return new AxiosError(
    "Request failed",
    "ERR_BAD_REQUEST",
    config,
    {},
    {
      status,
      statusText: "",
      headers: {},
      config,
      data: message ? { message } : {},
    },
  );
}

/** The newer endpoints answer with `errors: [{title, detail}]` and no message. */
function httpErrorWithErrors(status: number, errors: Array<{ title?: string; detail?: string }>) {
  const config = { headers: new AxiosHeaders() };
  return new AxiosError(
    "Request failed",
    "ERR_BAD_REQUEST",
    config,
    {},
    {
      status,
      statusText: "",
      headers: {},
      config,
      data: { errors },
    },
  );
}

describe("handleApiError", () => {
  it("names the context in every message", () => {
    assert.match(handleApiError(httpError(400), "list alerts"), /list alerts/);
  });

  it("quotes what the API said when it said anything", () => {
    assert.match(handleApiError(httpError(400, "bad field"), "ctx"), /API said: bad field/);
  });

  it("points a 400 at the search syntax, the usual cause", () => {
    const message = handleApiError(httpError(400), "ctx");
    assert.match(message, /case-sensitive/);
    assert.match(message, /status:open/);
  });

  it("offers both causes on a 401 when it has no endpoint to go on", () => {
    // A missing ops-config scope arrives as 401. Blaming the credentials alone
    // sends the reader to rotate a token that was working — the exact
    // misdiagnosis this message exists to prevent.
    const message = handleApiError(httpError(401), "ctx");
    assert.match(message, /JSM_EMAIL\/JSM_API_TOKEN/);
    assert.match(message, /read:ops-config:jira-service-management/);
    assert.match(message, /read:ops-alert:jira-service-management/);
  });

  it("says the credentials are fine when the API says the scope is not", () => {
    // JSM answers a missing scope with 401 "scope does not match". Telling the
    // reader to check their credentials there is a wrong answer: they are
    // valid. Verified against a live tenant — a working API token gets exactly
    // this on every delete endpoint.
    const message = handleApiError(httpError(401, "Unauthorized; scope does not match"), "ctx", {
      method: "DELETE",
      path: "/v1/alerts/{id}/tags",
    });
    assert.match(message, /credentials are valid/);
    assert.doesNotMatch(message, /wrong or revoked/);
  });

  it("names the delete scope, and that API tokens do not carry it", () => {
    // The finding this branch exists for: an Atlassian account API token has
    // the read and write ops scopes but never the delete ones, so every
    // DELETE-based tool fails until the user switches to OAuth. Without this
    // the model retries the same call.
    const message = handleApiError(httpError(401, "Unauthorized; scope does not match"), "ctx", {
      method: "DELETE",
      path: "/v1/alerts/{id}",
    });
    assert.match(message, /delete:ops-alert:jira-service-management/);
    assert.match(message, /JSM_OAUTH_TOKEN/);
    assert.match(message, /Do not retry with the same credentials/);
  });

  it("says attachments are a dead end rather than naming a scope to request", () => {
    const message = handleApiError(httpError(401, "Unauthorized; scope does not match"), "ctx", {
      method: "GET",
      path: "/v1/alerts/{id}/attachments",
    });
    assert.match(message, /no OAuth scope for them/);
    assert.match(message, /unavailable/);
  });

  it("treats alert policies as configuration, not as alerts", () => {
    // /v1/alerts/policies sits under the alerts prefix but is ops-config.
    const message = handleApiError(httpError(403), "ctx", {
      method: "GET",
      path: "/v1/alerts/policies",
    });
    assert.match(message, /read:ops-config:jira-service-management/);
    assert.doesNotMatch(message, /read:ops-alert:jira-service-management/);
  });

  it("names the scope for each endpoint group on a 403", () => {
    const message = handleApiError(httpError(403), "ctx");
    assert.match(message, /read:ops-alert:jira-service-management/);
    assert.match(message, /read:ops-config:jira-service-management/);
    // Writes need the read scope alongside the write one; saying only "write"
    // is what let a write-scope-only token look sufficient.
    assert.match(message, /matching write: scope alongside the read one/);
    assert.match(message, /Read-only Jira scopes are not sufficient/);
  });

  it("explains on a 404 that tinyId is not an id", () => {
    // Without this the model retries the same tinyId and 404s again.
    const message = handleApiError(httpError(404), "ctx");
    assert.match(message, /NOT the\s+short tinyId/);
    assert.match(message, /identifier_type='alias'/);
  });

  it("does not lecture about tinyId when the call was not alert-shaped", () => {
    const message = handleApiError(httpError(404), "ctx", {
      method: "GET",
      path: "/v1/schedules/{id}",
    });
    assert.doesNotMatch(message, /tinyId/);
    assert.match(message, /ids are not interchangeable/);
  });

  it("reads the errors[] envelope, not just message", () => {
    // Two envelopes are in use. GET /v1/roles answers with errors[].title and
    // no message at all, so reading only `message` threw away the single most
    // useful sentence in the response and left a generic 403.
    const message = handleApiError(
      httpErrorWithErrors(403, [
        { title: "You're not authorized to do operations for Custom User Roles." },
      ]),
      "list user roles",
    );
    assert.match(message, /not authorized to do operations for Custom User Roles/);
  });

  it("prefers detail over title, and joins several errors", () => {
    const message = handleApiError(
      httpErrorWithErrors(400, [
        { title: "Bad", detail: "field x is required" },
        { title: "Also" },
      ]),
      "ctx",
    );
    assert.match(message, /field x is required; Also/);
  });

  it("reports a 402 as a plan limit, not something to retry", () => {
    // Heartbeats answer 402 on every endpoint when the plan excludes them.
    // Falling through to the generic branch made that read like a fault.
    const message = handleApiError(
      httpError(402, "Please upgrade your pricing plan for Heartbeat Monitoring."),
      "list heartbeats",
    );
    assert.match(message, /not included in the site's JSM plan/);
    assert.match(message, /upgrade your pricing plan/);
    assert.match(message, /retrying, changing scopes or altering the request will not help/);
  });

  it("tells the caller to back off on a 429", () => {
    assert.match(handleApiError(httpError(429), "ctx"), /Wait a few seconds and retry/);
  });

  it("marks 5xx as probably transient", () => {
    assert.match(handleApiError(httpError(503), "ctx"), /usually transient/);
    assert.match(handleApiError(httpError(500), "ctx"), /HTTP 500/);
  });

  it("still reports an unmapped status usefully", () => {
    assert.match(handleApiError(httpError(418), "ctx"), /HTTP 418/);
  });

  it("reports the timeout in seconds so the number is actionable", () => {
    const timeout = new AxiosError("timeout", "ECONNABORTED");
    const message = handleApiError(timeout, "ctx");
    assert.match(message, new RegExp(`timed out after ${REQUEST_TIMEOUT_MS / 1000}s`));
    assert.match(message, /smaller 'limit'/);
  });

  it("suggests proxy settings when the host is unreachable", () => {
    const network = new AxiosError("getaddrinfo ENOTFOUND", "ENOTFOUND");
    const message = handleApiError(network, "ctx");
    assert.match(message, /could not reach api\.atlassian\.com/);
    assert.match(message, /proxy settings/);
  });

  it("passes a config error through unchanged", () => {
    const message = handleApiError(new JsmConfigError("cloud id missing"), "ctx");
    assert.match(message, /Configuration error: cloud id missing/);
  });

  it("does not crash on a non-Error throw", () => {
    assert.match(handleApiError("just a string", "ctx"), /Error \(ctx\): just a string/);
  });
});
