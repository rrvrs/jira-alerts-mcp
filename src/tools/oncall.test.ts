/**
 * Tests for the on-call tools, driven through a real McpServer.
 *
 * jsm_list_schedules gets the most attention here because it is the tool the
 * README and CONTRIBUTING both name as the first-run smoke test — and its
 * empty-list case is the one a misconfigured account actually hits.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { clearDirectoryCache } from "../services/directory.js";
import type { Schedule } from "../types.js";
import { onCallTools } from "./oncall/index.js";
import { clearScheduleCache } from "./oncall/resolve-schedule.js";
import { callTool, connectTools, httpError, stubClient, textOf } from "./test-support.js";

// Both resolvers cache for the life of the process, so one case's schedule or
// display name would otherwise answer the next one's lookup.
beforeEach(() => {
  clearScheduleCache();
  clearDirectoryCache();
});

const schedule = (index: number, padding = ""): Schedule => ({
  id: `sched-${index}`,
  name: `Rotation ${index}${padding}`,
  timezone: "Etc/UTC",
});

describe("jsm_list_schedules", () => {
  // Regression: this returned `-32602 Output validation error` instead of the
  // message below, because the empty branch shipped no structuredContent while
  // the tool declares an outputSchema. It broke the documented smoke test for
  // exactly the users it was written to help.
  it("explains team visibility instead of failing when no schedules are visible", async () => {
    const { client } = stubClient({ items: [] });
    const mcp = await connectTools(onCallTools, client);
    const result = await callTool(mcp, "jsm_list_schedules", {});

    assert.notEqual(result.isError, true);
    assert.doesNotMatch(textOf(result), /Output validation error/);
    assert.match(textOf(result), /confirm the credentials can see that team/);
    assert.deepEqual(result.structuredContent?.schedules, []);
  });

  it("lists schedules and reports honest pagination", async () => {
    const { client, calls } = stubClient({ items: [schedule(1), schedule(2)] });
    const mcp = await connectTools(onCallTools, client);
    const result = await callTool(mcp, "jsm_list_schedules", { limit: 20 });

    // The team lookup runs first, so find the schedules call rather than
    // assuming it is the only one.
    assert.ok(calls.some((call) => call.path === "/v1/schedules"));
    assert.match(textOf(result), /Rotation 1/);

    const pagination = result.structuredContent?.pagination as Record<string, unknown>;
    assert.equal(pagination.count, 2);
    assert.equal(pagination.has_more, false);
  });

  // The API returns a bare teamId; without resolution the owning team — most of
  // what makes the list useful — never appeared at all.
  it("names the owning team rather than printing its id", async () => {
    const { client } = stubClient(
      { items: [{ id: "s1", name: "Primary", teamId: "t1" }] },
      {
        routes: [
          { match: "/v1/teams", one: { platformTeams: [{ teamId: "t1", teamName: "Payments" }] } },
        ],
      },
    );
    const mcp = await connectTools(onCallTools, client);
    const result = await callTool(mcp, "jsm_list_schedules", {});

    assert.match(textOf(result), /team: Payments/);
  });

  it("does not skip schedules that truncation withheld", async () => {
    const items = Array.from({ length: 100 }, (_, i) => schedule(i, ` ${"x".repeat(400)}`));
    const { client } = stubClient({ items });
    const mcp = await connectTools(onCallTools, client);
    const result = await callTool(mcp, "jsm_list_schedules", { limit: 100, offset: 0 });

    const schedules = result.structuredContent?.schedules as unknown[];
    const pagination = result.structuredContent?.pagination as Record<string, unknown>;

    assert.ok(schedules.length < 100, "fixture should have been truncated");
    assert.equal(pagination.count, schedules.length);
    assert.equal(pagination.next_offset, schedules.length);
    assert.equal(pagination.truncated, true);
  });
});

describe("jsm_get_on_call", () => {
  it("passes the date through and asks for the page size the API reads", async () => {
    const { client, calls } = stubClient({ items: [{ onCallUsers: ["712020:abc"] }] });
    const mcp = await connectTools(onCallTools, client);

    await callTool(mcp, "jsm_get_on_call", {
      schedule_id: "sched-1",
      date: "2026-08-20T03:14:00Z",
    });

    assert.equal(calls[0]?.path, "/v1/schedules/sched-1/on-calls");
    assert.equal(calls[0]?.params?.date, "2026-08-20T03:14:00Z");
    assert.equal(calls[0]?.params?.flat, true);
  });

  // scheduleIdentifierType is not a parameter of any schedule endpoint, so a
  // name used to go out as a path segment and come back 404.
  it("resolves a schedule name to an id before asking who is on-call", async () => {
    const { client, calls } = stubClient(
      { items: [] },
      {
        routes: [
          // Ordered deliberately: the on-call path contains "/v1/schedules" too.
          { match: "on-calls", one: { onCallUsers: ["712020:abc"] } },
          { match: "/v1/schedules", page: { items: [{ id: "sched-9", name: "Platform" }] } },
        ],
      },
    );
    const mcp = await connectTools(onCallTools, client);

    const result = await callTool(mcp, "jsm_get_on_call", {
      schedule_id: "Platform",
      schedule_identifier_type: "name",
    });

    assert.equal(calls[0]?.path, "/v1/schedules");
    assert.equal(calls[0]?.params?.query, "Platform");
    assert.equal(calls[1]?.path, "/v1/schedules/sched-9/on-calls");
    // The parameter that never existed must not be sent any more.
    for (const call of calls) {
      assert.equal(call.params?.scheduleIdentifierType, undefined);
    }
    assert.match(textOf(result), /# Currently on-call for Platform/);
  });

  it("asks for an id rather than guessing when a name is ambiguous", async () => {
    const { client } = stubClient(
      { items: [] },
      {
        routes: [
          {
            match: "/v1/schedules",
            page: {
              items: [
                { id: "s1", name: "Platform EU" },
                { id: "s2", name: "Platform US" },
              ],
            },
          },
        ],
      },
    );
    const mcp = await connectTools(onCallTools, client);

    const result = await callTool(mcp, "jsm_get_on_call", {
      schedule_id: "Platform*",
      schedule_identifier_type: "name",
    });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /More than one schedule matches/);
    assert.match(textOf(result), /s1/);
    assert.match(textOf(result), /s2/);
  });

  it("points at jsm_list_schedules when a name matches nothing", async () => {
    const { client } = stubClient({ items: [] });
    const mcp = await connectTools(onCallTools, client);

    const result = await callTool(mcp, "jsm_get_on_call", {
      schedule_id: "Ghost",
      schedule_identifier_type: "name",
    });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /No schedule is named 'Ghost'/);
    assert.match(textOf(result), /jsm_list_schedules/);
  });

  it("treats nobody being rostered as an answer, not an error", async () => {
    const { client } = stubClient({ items: [{ onCallUsers: [] }] });
    const mcp = await connectTools(onCallTools, client);
    const result = await callTool(mcp, "jsm_get_on_call", { schedule_id: "s1" });

    assert.notEqual(result.isError, true);
    assert.match(textOf(result), /Nobody is on-call/);
  });

  // The regression the whole change exists for: flat=true answers under
  // onCallUsers, and the markdown path used to report nobody was on-call.
  it("names the on-call responder in the default markdown format", async () => {
    const { client } = stubClient(
      { items: [] },
      {
        routes: [{ match: "on-calls", one: { onCallUsers: ["712020:9ae5385e-1234"] } }],
        jira: {
          values: [
            {
              accountId: "712020:9ae5385e-1234",
              displayName: "Grace Hopper",
              emailAddress: "grace@example.com",
            },
          ],
        },
      },
    );
    const mcp = await connectTools(onCallTools, client);
    const result = await callTool(mcp, "jsm_get_on_call", { schedule_id: "s1" });

    assert.doesNotMatch(textOf(result), /Nobody is on-call/);
    assert.match(textOf(result), /Grace Hopper/);
    assert.match(textOf(result), /712020:9ae5385e-1234/);
  });

  it("resolves account ids to names without a second tool call", async () => {
    const { client, calls } = stubClient(
      { items: [] },
      {
        routes: [{ match: "on-calls", one: { onCallUsers: ["712020:abc"] } }],
        jira: {
          values: [{ accountId: "712020:abc", displayName: "Ada", emailAddress: "ada@x.com" }],
        },
      },
    );
    const mcp = await connectTools(onCallTools, client);
    const result = await callTool(mcp, "jsm_get_on_call", { schedule_id: "s1" });

    const lookup = calls.find((call) => call.path.includes("/user/bulk"));
    assert.ok(lookup, "should have resolved the id through the Jira user API");
    // maxResults defaults to 10 on that endpoint, so it has to be explicit.
    assert.equal(lookup?.params?.maxResults, 1);

    const participants = result.structuredContent?.participants as Array<Record<string, unknown>>;
    assert.equal(participants[0]?.displayName, "Ada");
    assert.equal(participants[0]?.id, "712020:abc");
  });

  // flat=false returns a participant tree of {id, type} with no names at all,
  // including teams, which resolve from a different endpoint than users do.
  it("names both the users and the teams in an unflattened participant tree", async () => {
    const { client } = stubClient(
      { items: [] },
      {
        routes: [
          {
            match: "on-calls",
            one: {
              onCallParticipants: [
                { id: "t1", type: "team" },
                { id: "712020:abc", type: "user" },
              ],
            },
          },
          { match: "/v1/teams", one: { platformTeams: [{ teamId: "t1", teamName: "Payments" }] } },
        ],
        jira: { values: [{ accountId: "712020:abc", displayName: "Ada" }] },
      },
    );
    const mcp = await connectTools(onCallTools, client);
    const result = await callTool(mcp, "jsm_get_on_call", { schedule_id: "s1", flat: false });

    assert.match(textOf(result), /Payments/);
    assert.match(textOf(result), /Ada/);
  });

  // A missing scope must cost the reader a name, never the answer.
  it("still answers when the identity lookup is refused", async () => {
    const { client } = stubClient(
      { items: [] },
      {
        routes: [{ match: "on-calls", one: { onCallUsers: ["712020:abc"] } }],
        jiraError: httpError(403),
      },
    );
    const mcp = await connectTools(onCallTools, client);
    const result = await callTool(mcp, "jsm_get_on_call", { schedule_id: "s1" });

    assert.notEqual(result.isError, true);
    assert.match(textOf(result), /712020:abc/);
    assert.match(textOf(result), /read:user:jira/);
  });
});

describe("jsm_get_next_on_call", () => {
  it("hits the next-on-calls endpoint and names the next responder", async () => {
    const { client, calls } = stubClient({
      items: [{ nextOnCallUsers: ["grace@example.com"] }],
    });
    const mcp = await connectTools(onCallTools, client);
    const result = await callTool(mcp, "jsm_get_next_on_call", { schedule_id: "s1" });

    assert.equal(calls[0]?.path, "/v1/schedules/s1/next-on-calls");
    assert.match(textOf(result), /grace@example\.com/);
    assert.doesNotMatch(textOf(result), /Nobody is on-call/);
  });

  // Without this, "who is on after Saket?" degrades to walking jsm_get_on_call
  // forward a day at a time.
  it("computes 'next' relative to a supplied reference date", async () => {
    const { client, calls } = stubClient({ items: [{ nextOnCallUsers: ["a"] }] });
    const mcp = await connectTools(onCallTools, client);

    await callTool(mcp, "jsm_get_next_on_call", {
      schedule_id: "s1",
      date: "2026-08-27T12:00:00Z",
    });

    assert.equal(calls[0]?.params?.date, "2026-08-27T12:00:00Z");
  });

  it("reports a legacy shift-start time when the tenant sends one", async () => {
    const { client } = stubClient({
      items: [
        {
          nextOnCallRecipients: ["grace@example.com"],
          exactNextOnCallTime: "2026-07-08T09:00:00.000Z",
        },
      ],
    });
    const mcp = await connectTools(onCallTools, client);
    const result = await callTool(mcp, "jsm_get_next_on_call", { schedule_id: "s1" });

    assert.match(textOf(result), /Shift starts: 2026-07-08 09:00:00Z/);
  });
});

/** A timeline with a shift in progress and the next one queued behind it. */
const timelineFixture = {
  finalTimeline: {
    rotations: [
      {
        id: "rot-1",
        name: "Primary Rotation",
        periods: [
          {
            startDate: "2026-08-22T09:00:00Z",
            endDate: "2026-08-23T09:00:00Z",
            type: "base",
            responder: { id: "user-saket", type: "user" },
          },
          {
            startDate: "2026-08-23T09:00:00Z",
            endDate: "2026-08-24T09:00:00Z",
            type: "base",
            responder: { id: "user-ada", type: "user" },
          },
        ],
      },
    ],
  },
};

describe("shift boundaries in the on-call answers", () => {
  // The question that used to take a hand-run binary search over timestamps.
  it("reports when the current shift ends, not just who is on it", async () => {
    const { client } = stubClient(
      { items: [] },
      {
        routes: [
          { match: "timeline", one: timelineFixture },
          { match: "on-calls", one: { onCallUsers: ["user-saket"] } },
        ],
      },
    );
    const mcp = await connectTools(onCallTools, client);

    const result = await callTool(mcp, "jsm_get_on_call", {
      schedule_id: "s1",
      date: "2026-08-22T18:00:00Z",
    });

    assert.match(textOf(result), /2026-08-23 09:00:00Z/);
    assert.match(textOf(result), /Primary Rotation/);

    const shift = result.structuredContent?.shift as Record<string, unknown>;
    assert.equal(shift.start, "2026-08-22T09:00:00Z");
    assert.equal(shift.end, "2026-08-23T09:00:00Z");
  });

  it("answers 'who is on after this shift' from a reference date", async () => {
    const { client, calls } = stubClient(
      { items: [] },
      {
        routes: [
          { match: "timeline", one: timelineFixture },
          { match: "next-on-calls", one: { nextOnCallUsers: ["user-ada"] } },
        ],
      },
    );
    const mcp = await connectTools(onCallTools, client);

    const result = await callTool(mcp, "jsm_get_next_on_call", {
      schedule_id: "s1",
      date: "2026-08-22T18:00:00Z",
    });

    // The reference date reaches the API rather than being ignored in favour of now.
    const call = calls.find((c) => c.path.includes("next-on-calls"));
    assert.equal(call?.params?.date, "2026-08-22T18:00:00Z");

    const shift = result.structuredContent?.shift as Record<string, unknown>;
    assert.equal(shift.start, "2026-08-23T09:00:00Z");
  });

  // A boundary belonging to a different rotation's responder would be a
  // confidently wrong answer — the exact failure this change set out to remove.
  it("omits the boundary when no period matches the responders", async () => {
    const { client } = stubClient(
      { items: [] },
      {
        routes: [
          { match: "timeline", one: timelineFixture },
          { match: "on-calls", one: { onCallUsers: ["someone-else"] } },
        ],
      },
    );
    const mcp = await connectTools(onCallTools, client);

    const result = await callTool(mcp, "jsm_get_on_call", {
      schedule_id: "s1",
      date: "2026-08-22T18:00:00Z",
    });

    assert.equal(result.structuredContent?.shift, undefined);
    assert.match(textOf(result), /No timeline period matched/);
  });

  // Boundaries are a bonus; the responder is the answer.
  it("still names the responder when the timeline cannot be read", async () => {
    const { client } = stubClient(
      { items: [] },
      {
        routes: [
          { match: "timeline", error: httpError(500) },
          { match: "on-calls", one: { onCallUsers: ["user-saket"] } },
        ],
      },
    );
    const mcp = await connectTools(onCallTools, client);
    const result = await callTool(mcp, "jsm_get_on_call", { schedule_id: "s1" });

    assert.notEqual(result.isError, true);
    assert.match(textOf(result), /user-saket/);
    assert.match(textOf(result), /Shift boundaries are unavailable/);
  });

  // And the timeline is the safety net in the other direction too.
  it("falls back to the timeline when the on-call endpoint fails", async () => {
    const { client } = stubClient(
      { items: [] },
      {
        routes: [
          { match: "timeline", one: timelineFixture },
          { match: "on-calls", error: httpError(500) },
        ],
      },
    );
    const mcp = await connectTools(onCallTools, client);

    const result = await callTool(mcp, "jsm_get_on_call", {
      schedule_id: "s1",
      date: "2026-08-22T18:00:00Z",
    });

    assert.notEqual(result.isError, true);
    assert.match(textOf(result), /user-saket/);
    assert.match(textOf(result), /Derived from the schedule timeline/);
  });

  it("reports an error when neither endpoint can answer", async () => {
    const { client } = stubClient(
      { items: [] },
      {
        routes: [
          { match: "timeline", error: httpError(500) },
          { match: "on-calls", error: httpError(500) },
        ],
      },
    );
    const mcp = await connectTools(onCallTools, client);
    const result = await callTool(mcp, "jsm_get_on_call", { schedule_id: "s1" });

    assert.equal(result.isError, true);
  });
});

describe("jsm_get_schedule_timeline", () => {
  it("lists each period with its boundaries and the people covering it", async () => {
    const { client } = stubClient(
      { items: [] },
      {
        routes: [{ match: "timeline", one: timelineFixture }],
        jira: {
          values: [
            { accountId: "user-saket", displayName: "Saket" },
            { accountId: "user-ada", displayName: "Ada" },
          ],
        },
      },
    );
    const mcp = await connectTools(onCallTools, client);
    const result = await callTool(mcp, "jsm_get_schedule_timeline", { schedule_id: "s1" });

    assert.match(textOf(result), /Saket/);
    assert.match(textOf(result), /Ada/);
    assert.match(textOf(result), /2026-08-23 09:00:00Z/);

    const shifts = result.structuredContent?.shifts as Array<Record<string, unknown>>;
    assert.equal(shifts.length, 2);
    assert.equal(shifts[0]?.rotation_name, "Primary Rotation");
  });

  it("resolves every responder in the window in one lookup", async () => {
    const { client, calls } = stubClient(
      { items: [] },
      { routes: [{ match: "timeline", one: timelineFixture }], jira: { values: [] } },
    );
    const mcp = await connectTools(onCallTools, client);
    await callTool(mcp, "jsm_get_schedule_timeline", { schedule_id: "s1" });

    const lookups = calls.filter((call) => call.path.includes("/user/bulk"));
    assert.equal(lookups.length, 1, "two shifts, two people, one lookup");
  });

  it("says so plainly when the window holds no rotation periods", async () => {
    const { client } = stubClient({ items: [] }, { routes: [{ match: "timeline", one: {} }] });
    const mcp = await connectTools(onCallTools, client);
    const result = await callTool(mcp, "jsm_get_schedule_timeline", { schedule_id: "s1" });

    assert.notEqual(result.isError, true);
    assert.match(textOf(result), /No rotation periods in this window/);
  });
});
