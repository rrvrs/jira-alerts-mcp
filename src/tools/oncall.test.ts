/**
 * Tests for the on-call tools, driven through a real McpServer.
 *
 * jsm_list_schedules gets the most attention here because it is the tool the
 * README and CONTRIBUTING both name as the first-run smoke test — and its
 * empty-list case is the one a misconfigured account actually hits.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Schedule } from "../types.js";
import { registerOnCallTools } from "./oncall.js";
import { callTool, connectTools, stubClient, textOf } from "./test-support.js";

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
    const mcp = await connectTools(registerOnCallTools, client);
    const result = await callTool(mcp, "jsm_list_schedules", {});

    assert.notEqual(result.isError, true);
    assert.doesNotMatch(textOf(result), /Output validation error/);
    assert.match(textOf(result), /confirm the credentials can see that team/);
    assert.deepEqual(result.structuredContent?.schedules, []);
  });

  it("lists schedules and reports honest pagination", async () => {
    const { client, calls } = stubClient({ items: [schedule(1), schedule(2)] });
    const mcp = await connectTools(registerOnCallTools, client);
    const result = await callTool(mcp, "jsm_list_schedules", { limit: 20 });

    assert.equal(calls[0]?.path, "/v1/schedules");
    assert.match(textOf(result), /Rotation 1/);

    const pagination = result.structuredContent?.pagination as Record<string, unknown>;
    assert.equal(pagination.count, 2);
    assert.equal(pagination.has_more, false);
  });

  it("does not skip schedules that truncation withheld", async () => {
    const items = Array.from({ length: 100 }, (_, i) => schedule(i, ` ${"x".repeat(400)}`));
    const { client } = stubClient({ items });
    const mcp = await connectTools(registerOnCallTools, client);
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
  it("passes the schedule identifier type and date through to the API", async () => {
    const { client, calls } = stubClient({ items: [{ onCallRecipients: ["ada@example.com"] }] });
    const mcp = await connectTools(registerOnCallTools, client);

    await callTool(mcp, "jsm_get_on_call", {
      schedule_id: "platform",
      schedule_identifier_type: "name",
      date: "2026-08-20T03:14:00Z",
    });

    assert.equal(calls[0]?.path, "/v1/schedules/platform/on-calls");
    assert.equal(calls[0]?.params?.scheduleIdentifierType, "name");
    assert.equal(calls[0]?.params?.date, "2026-08-20T03:14:00Z");
    assert.equal(calls[0]?.params?.flat, true);
  });

  it("treats nobody being rostered as an answer, not an error", async () => {
    const { client } = stubClient({ items: [{ onCallRecipients: [] }] });
    const mcp = await connectTools(registerOnCallTools, client);
    const result = await callTool(mcp, "jsm_get_on_call", { schedule_id: "s1" });

    assert.notEqual(result.isError, true);
    assert.match(textOf(result), /Nobody is on-call/);
  });

  it("url-encodes a schedule name containing a slash", async () => {
    const { client, calls } = stubClient({ items: [{ onCallRecipients: [] }] });
    const mcp = await connectTools(registerOnCallTools, client);

    await callTool(mcp, "jsm_get_on_call", {
      schedule_id: "platform/eu",
      schedule_identifier_type: "name",
    });

    assert.equal(calls[0]?.path, "/v1/schedules/platform%2Feu/on-calls");
  });
});

describe("jsm_get_next_on_call", () => {
  it("hits the next-on-calls endpoint and reports the shift start", async () => {
    const { client, calls } = stubClient({
      items: [
        {
          _parent: { name: "Primary" },
          nextOnCallRecipients: ["grace@example.com"],
          exactNextOnCallTime: "2026-07-08T09:00:00.000Z",
        },
      ],
    });
    const mcp = await connectTools(registerOnCallTools, client);
    const result = await callTool(mcp, "jsm_get_next_on_call", { schedule_id: "s1" });

    assert.equal(calls[0]?.path, "/v1/schedules/s1/next-on-calls");
    assert.match(textOf(result), /grace@example\.com/);
    assert.match(textOf(result), /Shift starts: 2026-07-08 09:00:00Z/);
  });
});
