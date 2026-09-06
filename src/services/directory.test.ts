/**
 * Tests for identity resolution.
 *
 * The load-bearing behaviour here is the failure path: this module exists to
 * make an on-call answer readable, and it must never be able to take that
 * answer away. Every failure case below asserts that ids still come back.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { JsmClient, loadConfig } from "./client.js";
import {
  clearDirectoryCache,
  renderIdentity,
  resolveIdentities,
  resolveUsers,
} from "./directory.js";

const config = loadConfig({
  JSM_CLOUD_ID: "cloud-id",
  JSM_OAUTH_TOKEN: "bearer",
} as NodeJS.ProcessEnv);

interface Recorded {
  path: string;
  params?: Record<string, unknown> | undefined;
}

function fakeClient(
  responses: { jira?: unknown; jiraError?: unknown; teams?: unknown; teamsError?: unknown } = {},
): { client: JsmClient; calls: Recorded[] } {
  const calls: Recorded[] = [];

  const client = new (class extends JsmClient {
    override async jiraGet<T>(path: string, params?: Record<string, unknown>): Promise<T> {
      calls.push({ path, params });
      if (responses.jiraError) throw responses.jiraError;
      return (responses.jira ?? {}) as T;
    }

    override async getOne<T>(path: string, params?: Record<string, unknown>): Promise<T> {
      calls.push({ path, params });
      if (responses.teamsError) throw responses.teamsError;
      return (responses.teams ?? {}) as T;
    }
  })(config);

  return { client, calls };
}

function forbidden(): Error {
  return Object.assign(new Error("HTTP 403"), {
    isAxiosError: true,
    response: { status: 403, data: {} },
  });
}

beforeEach(clearDirectoryCache);

describe("resolveUsers", () => {
  it("maps account ids to display names and emails", async () => {
    const { client } = fakeClient({
      jira: {
        values: [
          { accountId: "712020:abc", displayName: "Grace Hopper", emailAddress: "grace@x.com" },
        ],
      },
    });

    const directory = await resolveUsers(client, ["712020:abc"]);

    assert.equal(directory.names.get("712020:abc")?.displayName, "Grace Hopper");
    assert.equal(directory.names.get("712020:abc")?.emailAddress, "grace@x.com");
    assert.equal(directory.note, undefined);
  });

  // The endpoint defaults maxResults to 10. Sending a batch of more than ten
  // ids without setting it drops the rest with no error and no indication.
  it("sends maxResults explicitly so a batch cannot be silently truncated", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `id-${i}`);
    const { client, calls } = fakeClient({ jira: { values: [] } });

    await resolveUsers(client, ids);

    assert.equal(calls[0]?.params?.maxResults, 12);
    assert.deepEqual(calls[0]?.params?.accountId, ids);
  });

  it("chunks a lookup larger than one batch", async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `id-${i}`);
    const { client, calls } = fakeClient({ jira: { values: [] } });

    await resolveUsers(client, ids);

    assert.equal(calls.length, 3, "120 ids at 50 per request");
  });

  it("asks once for a repeated id", async () => {
    const { client, calls } = fakeClient({ jira: { values: [] } });

    await resolveUsers(client, ["dup", "dup", "dup"]);

    assert.deepEqual(calls[0]?.params?.accountId, ["dup"]);
  });

  it("serves a second lookup of the same id from cache", async () => {
    const { client, calls } = fakeClient({
      jira: { values: [{ accountId: "a", displayName: "Ada" }] },
    });

    await resolveUsers(client, ["a"]);
    const second = await resolveUsers(client, ["a"]);

    assert.equal(calls.length, 1, "should not have asked twice");
    assert.equal(second.names.get("a")?.displayName, "Ada");
  });

  // The whole point: a name is a nicety, the answer is not.
  it("returns a reason instead of throwing when the scope is missing", async () => {
    const { client } = fakeClient({ jiraError: forbidden() });

    const directory = await resolveUsers(client, ["712020:abc"]);

    assert.equal(directory.names.size, 0);
    // read:jira-user is the scope that actually works. Naming the granular
    // read:user:jira first sent people to add a scope that is Beta and, alone,
    // insufficient — a wrong answer in the one message whose entire job is to
    // tell someone what to change.
    assert.match(directory.note ?? "", /read:jira-user/);
    assert.match(directory.note ?? "", /separate grant/);
  });

  it("keeps the names it did resolve when a later batch fails", async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `id-${i}`);
    let call = 0;
    const client = new (class extends JsmClient {
      override async jiraGet<T>(): Promise<T> {
        call += 1;
        if (call > 1) throw forbidden();
        return { values: [{ accountId: "id-0", displayName: "Ada" }] } as T;
      }
    })(config);

    const directory = await resolveUsers(client, ids);

    assert.equal(directory.names.get("id-0")?.displayName, "Ada");
    assert.ok(directory.note, "should still explain why the rest are unresolved");
  });
});

describe("resolveIdentities", () => {
  it("resolves users and teams from their own endpoints", async () => {
    const { client } = fakeClient({
      jira: { values: [{ accountId: "u1", displayName: "Ada" }] },
      teams: { platformTeams: [{ teamId: "t1", teamName: "Payments" }] },
    });

    const directory = await resolveIdentities(client, [
      { id: "u1", type: "user" },
      { id: "t1", type: "team" },
    ]);

    assert.equal(directory.names.get("u1")?.displayName, "Ada");
    assert.equal(directory.names.get("t1")?.displayName, "Payments");
  });

  it("resolves team names when /v1/teams answers with a bare array", async () => {
    // The spec declares {platformTeams: [...]}; a live site answered with a
    // bare array. Reading only the documented key left every team on the
    // on-call output showing a raw uuid, and nothing failed.
    const { client } = fakeClient({
      jira: { values: [] },
      teams: [{ teamId: "t1", teamName: "Payments" }],
    });

    const directory = await resolveIdentities(client, [{ id: "t1", type: "team" }]);

    assert.equal(directory.names.get("t1")?.displayName, "Payments");
  });

  it("treats an untyped id as a user, which is what a flat on-call list holds", async () => {
    const { client, calls } = fakeClient({ jira: { values: [] } });

    await resolveIdentities(client, [{ id: "712020:abc" }]);

    assert.ok(calls.some((call) => call.path.includes("/user/bulk")));
  });

  it("does not call the team endpoint when no team is involved", async () => {
    const { client, calls } = fakeClient({ jira: { values: [] } });

    await resolveIdentities(client, [{ id: "u1", type: "user" }]);

    assert.equal(
      calls.some((call) => call.path === "/v1/teams"),
      false,
    );
  });

  it("survives a team lookup failure without losing the user names", async () => {
    const { client } = fakeClient({
      jira: { values: [{ accountId: "u1", displayName: "Ada" }] },
      teamsError: forbidden(),
    });

    const directory = await resolveIdentities(client, [
      { id: "u1", type: "user" },
      { id: "t1", type: "team" },
    ]);

    assert.equal(directory.names.get("u1")?.displayName, "Ada");
    assert.equal(directory.names.get("t1"), undefined);
  });
});

describe("renderIdentity", () => {
  it("keeps the id even when it has a name, because tools take ids", () => {
    const rendered = renderIdentity({
      id: "712020:abc",
      type: "user",
      displayName: "Grace Hopper",
      emailAddress: "grace@x.com",
    });

    assert.match(rendered, /Grace Hopper/);
    assert.match(rendered, /grace@x\.com/);
    assert.match(rendered, /712020:abc/);
  });

  it("renders a bare id plainly when nothing resolved it", () => {
    assert.equal(renderIdentity({ id: "712020:abc" }), "`712020:abc`");
  });

  it("labels a non-user responder with its type", () => {
    assert.match(renderIdentity({ id: "t1", type: "team", displayName: "Payments" }), /\(team\)/);
  });
});
