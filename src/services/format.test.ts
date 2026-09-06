/**
 * Tests for response shaping.
 *
 * Every tool's output goes through this module, and the tool descriptions
 * make promises about it — that lists get truncated rather than blowing the
 * context window, and that write tools always hand back the async receipt.
 * These tests pin those promises down.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CHARACTER_LIMIT } from "../constants.js";
import { ResponseFormat } from "../schemas/common.js";
import type { Alert, AlertLog, AlertNote, OnCallData, Schedule } from "../types.js";
import {
  buildPagination,
  emptyResult,
  fail,
  ok,
  renderAlertDetail,
  renderAlertLine,
  renderAsyncReceipt,
  renderFormat,
  renderLogs,
  renderNotes,
  extractOnCall,
  renderOnCall,
  renderSchedules,
  withCharacterLimit,
} from "./format.js";

/** Minimal open, unacked alert. Spread over it to vary a single field. */
const baseAlert: Alert = {
  id: "9b251e07-73c9-4907-9996-8cb53a6a20d0-1704440650350",
  tinyId: "4821",
  message: "Disk usage above 90% on db-01",
  status: "open",
  acknowledged: false,
};

describe("ok / fail", () => {
  it("wraps text and omits structuredContent when none is given", () => {
    const result = ok("hello");
    assert.deepEqual(result.content, [{ type: "text", text: "hello" }]);
    assert.equal("structuredContent" in result, false);
    assert.equal(result.isError, undefined);
  });

  it("attaches structuredContent when given", () => {
    const result = ok("hello", { a: 1 });
    assert.deepEqual(result.structuredContent, { a: 1 });
  });

  it("marks errors in-result rather than as a protocol error", () => {
    const result = fail("boom");
    assert.equal(result.isError, true);
    assert.equal(result.content[0]?.text, "boom");
  });
});

describe("withCharacterLimit", () => {
  const render = (items: string[]) => items.join("\n");

  it("leaves output that already fits untouched", () => {
    const items = ["a", "b", "c"];
    const result = withCharacterLimit(items, render, "narrow the query");

    assert.equal(result.truncated, false);
    assert.equal(result.kept, 3);
    assert.equal(result.text, "a\nb\nc");
    assert.equal(result.text.includes("Truncated"), false);
  });

  it("halves the item list until the rendered text fits", () => {
    // 40 items x ~1000 chars = ~40k, over the 25k limit. Halving once leaves
    // 20 items (~20k), which fits.
    const items = Array.from({ length: 40 }, () => "x".repeat(999));
    const result = withCharacterLimit(items, render, "narrow the query");

    assert.equal(result.truncated, true);
    assert.equal(result.kept, 20);
    assert.match(result.text, /Truncated: showing 20 of 40 records/);
    assert.match(result.text, /narrow the query/);
  });

  it("keeps halving when one pass is not enough", () => {
    const items = Array.from({ length: 100 }, () => "x".repeat(999));
    const result = withCharacterLimit(items, render, "hint");

    assert.equal(result.truncated, true);
    assert.ok(result.kept < 100, "should have dropped items");
    assert.ok(result.kept >= 1);
  });

  it("terminates at one item even when that item alone exceeds the limit", () => {
    const items = ["y".repeat(CHARACTER_LIMIT * 3), "z"];
    const result = withCharacterLimit(items, render, "hint");

    // The guard must not loop forever, and must not return zero items —
    // returning nothing would leave the model with no data and no id to page from.
    assert.equal(result.kept, 1);
    assert.equal(result.truncated, true);
    assert.ok(result.text.length > CHARACTER_LIMIT);
  });

  it("handles an empty list without truncating", () => {
    const result = withCharacterLimit([], render, "hint");
    assert.equal(result.kept, 0);
    assert.equal(result.truncated, false);
  });
});

describe("buildPagination", () => {
  it("reports has_more when the page came back full", () => {
    assert.deepEqual(buildPagination({ returned: 20, fetched: 20, limit: 20, offset: 0 }), {
      count: 20,
      offset: 0,
      has_more: true,
      next_offset: 20,
    });
  });

  it("reports no more when the page came back short", () => {
    assert.deepEqual(buildPagination({ returned: 7, fetched: 7, limit: 20, offset: 40 }), {
      count: 7,
      offset: 40,
      has_more: false,
    });
  });

  it("counts what was returned, not what the API sent", () => {
    // The whole point: reporting `fetched` here would make next_offset skip
    // every record truncation dropped.
    const meta = buildPagination({ returned: 25, fetched: 100, limit: 100, offset: 0 });
    assert.equal(meta.count, 25);
    assert.equal(meta.truncated, true);
    assert.equal(meta.has_more, true);
    assert.equal(meta.next_offset, 25);
  });

  it("resumes at the first record the caller did not receive", () => {
    const meta = buildPagination({ returned: 10, fetched: 50, limit: 50, offset: 200 });
    assert.equal(meta.next_offset, 210);
  });

  it("treats truncation as proof of more results even on a short page", () => {
    const meta = buildPagination({ returned: 2, fetched: 7, limit: 20, offset: 0 });
    assert.equal(meta.has_more, true);
    assert.equal(meta.truncated, true);
  });

  it("omits the truncated flag when nothing was dropped", () => {
    assert.equal("truncated" in buildPagination({ returned: 5, fetched: 5, limit: 20 }), false);
  });

  it("omits offset and next_offset for cursor-paged endpoints", () => {
    const meta = buildPagination({
      returned: 20,
      fetched: 20,
      limit: 20,
      nextCursor: "cursor-abc",
    });
    assert.equal("offset" in meta, false);
    assert.equal("next_offset" in meta, false);
    assert.equal(meta.next_cursor, "cursor-abc");
  });

  it("treats a cursor as proof of more results even on a short page", () => {
    const meta = buildPagination({ returned: 3, fetched: 3, limit: 20, nextCursor: "cursor-abc" });
    assert.equal(meta.has_more, true);
  });

  it("passes through totalCount only when supplied", () => {
    assert.equal(
      buildPagination({ returned: 5, fetched: 5, limit: 20, offset: 0, totalCount: 137 }).total,
      137,
    );
    assert.equal(
      "total" in buildPagination({ returned: 5, fetched: 5, limit: 20, offset: 0 }),
      false,
    );
  });
});

describe("emptyResult", () => {
  it("ships a valid structured payload, because outputSchema demands one", () => {
    // ok(text) alone here is what made an empty search return -32602.
    const result = emptyResult("No alerts matched.", "alerts", 20, 0);
    assert.deepEqual(result.structuredContent?.alerts, []);
    assert.equal(result.isError, undefined);
  });

  it("reports an empty page as the end of the results", () => {
    const meta = emptyResult("none", "schedules", 20, 0).structuredContent?.pagination as Record<
      string,
      unknown
    >;
    assert.equal(meta.count, 0);
    assert.equal(meta.has_more, false);
    assert.equal("next_offset" in meta, false);
  });
});

describe("renderAlertLine", () => {
  it("shouts about unacknowledged alerts", () => {
    assert.match(renderAlertLine(baseAlert), /state: open, UNACKED/);
  });

  it("renders the acknowledged state", () => {
    const line = renderAlertLine({ ...baseAlert, acknowledged: true });
    assert.match(line, /state: open, acked/);
  });

  it("renders the closed state regardless of the acknowledged flag", () => {
    const line = renderAlertLine({ ...baseAlert, status: "closed", acknowledged: false });
    assert.match(line, /state: closed/);
  });

  it("renders the snoozed state with its expiry", () => {
    const line = renderAlertLine({
      ...baseAlert,
      snoozed: true,
      snoozedUntil: "2026-07-01T12:00:00.000Z",
    });
    assert.match(line, /state: open, snoozed until 2026-07-01 12:00:00Z/);
  });

  it("always includes the full id, since tinyId is not accepted by the API", () => {
    assert.match(renderAlertLine(baseAlert), new RegExp(`id: \`${baseAlert.id}\``));
  });

  it("omits absent optional fields rather than printing undefined", () => {
    const line = renderAlertLine(baseAlert);
    assert.equal(line.includes("undefined"), false);
    assert.equal(line.includes("priority:"), false);
    assert.equal(line.includes("owner:"), false);
    assert.equal(line.includes("tags:"), false);
  });

  it("suppresses a deduplication count of one as noise", () => {
    assert.equal(renderAlertLine({ ...baseAlert, count: 1 }).includes("count:"), false);
    assert.match(renderAlertLine({ ...baseAlert, count: 12 }), /count: 12/);
  });

  it("shows last-seen only when it differs from created", () => {
    const same = renderAlertLine({
      ...baseAlert,
      createdAt: "2026-07-01T00:00:00.000Z",
      lastOccurredAt: "2026-07-01T00:00:00.000Z",
    });
    assert.equal(same.includes("last seen"), false);

    const differs = renderAlertLine({
      ...baseAlert,
      createdAt: "2026-07-01T00:00:00.000Z",
      lastOccurredAt: "2026-07-02T00:00:00.000Z",
    });
    assert.match(differs, /last seen: 2026-07-02/);
  });

  it("falls back to ? for a missing tinyId", () => {
    const { tinyId: _omit, ...withoutTinyId } = baseAlert;
    assert.match(renderAlertLine(withoutTinyId), /\*\*#\?\*\*/);
  });

  it("renders an unparseable timestamp verbatim instead of Invalid Date", () => {
    const line = renderAlertLine({ ...baseAlert, createdAt: "not-a-date" });
    assert.match(line, /created: not-a-date/);
    assert.equal(line.includes("Invalid Date"), false);
  });
});

describe("renderAlertDetail", () => {
  it("states 'not set' for a missing priority", () => {
    assert.match(renderAlertDetail(baseAlert), /\*\*Priority\*\*: not set/);
  });

  it("reports 'unknown' for missing timestamps", () => {
    assert.match(renderAlertDetail(baseAlert), /\*\*Created\*\*: unknown/);
  });

  it("merges details and extraProperties into one section", () => {
    const detail = renderAlertDetail({
      ...baseAlert,
      details: { host: "db-01" },
      extraProperties: { runbook: "https://example.com/rb" },
    });
    assert.match(detail, /## Details/);
    assert.match(detail, /\*\*host\*\*: db-01/);
    assert.match(detail, /\*\*runbook\*\*: https:\/\/example\.com\/rb/);
  });

  it("lets extraProperties win on a key collision", () => {
    const detail = renderAlertDetail({
      ...baseAlert,
      details: { host: "from-details" },
      extraProperties: { host: "from-extra" },
    });
    assert.match(detail, /\*\*host\*\*: from-extra/);
    assert.equal(detail.includes("from-details"), false);
  });

  it("omits the Details section entirely when there is nothing to show", () => {
    assert.equal(renderAlertDetail(baseAlert).includes("## Details"), false);
  });

  it("flattens responders and teams into one line, keeping names the API supplied", () => {
    const detail = renderAlertDetail({
      ...baseAlert,
      responders: [
        { id: "u1", name: "Ada" },
        { id: "u2", username: "grace@example.com" },
      ],
      teams: [{ id: "t1", name: "Platform" }],
    });

    assert.match(detail, /Ada/);
    assert.match(detail, /grace@example\.com/);
    assert.match(detail, /Platform/);
  });

  // The API sends responders as bare {id, type}: without resolution this line
  // is a row of uuids, which answers nobody's question about who is on an alert.
  it("resolves responder ids that arrived without a name", () => {
    const detail = renderAlertDetail(
      { ...baseAlert, responders: [{ id: "712020:abc", type: "user" }] },
      {
        names: new Map([
          ["712020:abc", { id: "712020:abc", displayName: "Grace Hopper", type: "user" }],
        ]),
      },
    );

    assert.match(detail, /Grace Hopper/);
    assert.match(detail, /712020:abc/);
  });

  it("omits the description heading when there is no description", () => {
    assert.equal(renderAlertDetail(baseAlert).includes("## Description"), false);
    assert.match(renderAlertDetail({ ...baseAlert, description: "text" }), /## Description/);
  });

  it("renders the integration type alongside its name when present", () => {
    assert.match(
      renderAlertDetail({ ...baseAlert, integration: { name: "Grafana", type: "Webhook" } }),
      /\*\*Integration\*\*: Grafana \(Webhook\)/,
    );
    assert.match(
      renderAlertDetail({ ...baseAlert, integration: { name: "Grafana" } }),
      /\*\*Integration\*\*: Grafana\n/,
    );
  });
});

describe("renderNotes / renderLogs / renderSchedules", () => {
  it("says so plainly when a timeline is empty", () => {
    assert.equal(renderNotes([]), "No notes on this alert.");
    assert.equal(renderLogs([]), "No activity logs on this alert.");
    assert.equal(renderSchedules([]), "No schedules found.");
  });

  it("attributes an ownerless note to 'unknown' and an ownerless log to 'system'", () => {
    const notes: AlertNote[] = [{ note: "looking into it", createdAt: "2026-07-01T00:00:00.000Z" }];
    const logs: AlertLog[] = [{ log: "Alert closed", createdAt: "2026-07-01T00:00:00.000Z" }];
    assert.match(renderNotes(notes), /unknown/);
    assert.match(renderLogs(logs), /system/);
  });

  it("indents continuation lines so multi-line notes stay inside the list item", () => {
    const notes: AlertNote[] = [{ note: "line one\nline two", owner: "ada@example.com" }];
    assert.match(renderNotes(notes), /\n {2}line two/);
  });

  it("flags disabled schedules, which otherwise look identical to live ones", () => {
    const schedules: Schedule[] = [
      { id: "s1", name: "Primary" },
      { id: "s2", name: "Retired", enabled: false },
    ];
    const rendered = renderSchedules(schedules);
    assert.match(rendered, /\*\*Retired\*\* _\(disabled\)_/);
    assert.equal(rendered.includes("**Primary** _(disabled)_"), false);
  });
});

describe("renderOnCall", () => {
  const opts = { scheduleLabel: "Primary" };

  // The bug this file exists to prevent recurring: with flat=true (the default)
  // the API answers under `onCallUsers`. The renderer read `onCallRecipients`
  // — an Opsgenie name JSM Operations never sends — found nothing, and reported
  // that nobody was on-call while response_format=json showed a real person.
  // A false negative on "who do I page".
  it("names the responder the API returned under onCallUsers", () => {
    const data: OnCallData = { onCallUsers: ["712020:9ae5385e-1234"] };
    const rendered = renderOnCall(extractOnCall(data, false), false, opts);

    assert.match(rendered, /712020:9ae5385e-1234/);
    assert.doesNotMatch(rendered, /Nobody is on-call/);
  });

  it("names the responder the API returned under nextOnCallUsers", () => {
    const data: OnCallData = { nextOnCallUsers: ["712020:9ae5385e-1234"] };
    const rendered = renderOnCall(extractOnCall(data, true), true, opts);

    assert.match(rendered, /712020:9ae5385e-1234/);
    assert.doesNotMatch(rendered, /Nobody is on-call/);
  });

  // Legacy tolerance: a tenant still answering in the Opsgenie shape must not
  // regress while we read the documented name first.
  it("still reads the legacy onCallRecipients shape", () => {
    const data: OnCallData = { onCallRecipients: ["ada@example.com"] };
    const rendered = renderOnCall(extractOnCall(data, false), false, opts);

    assert.match(rendered, /ada@example\.com/);
    assert.doesNotMatch(rendered, /Nobody is on-call/);
  });

  it("still reads the legacy nextOnCallRecipients shape", () => {
    const data: OnCallData = { nextOnCallRecipients: ["ada@example.com"] };
    assert.match(renderOnCall(extractOnCall(data, true), true, opts), /ada@example\.com/);
  });

  it("prefers the documented field when both shapes are present", () => {
    const data: OnCallData = {
      onCallUsers: ["documented"],
      onCallRecipients: ["legacy"],
    };
    const rendered = renderOnCall(extractOnCall(data, false), false, opts);

    assert.match(rendered, /documented/);
    assert.doesNotMatch(rendered, /legacy/);
  });

  it("says nobody is on-call rather than returning an empty list", () => {
    assert.match(
      renderOnCall(extractOnCall({ onCallUsers: [] }, false), false, opts),
      /Nobody is on-call/,
    );
  });

  it("prefers the flat user list when the API returns one", () => {
    const data: OnCallData = {
      onCallUsers: ["ada@example.com"],
      onCallParticipants: [{ id: "u2", name: "Should Be Ignored", type: "user" }],
    };
    const rendered = renderOnCall(extractOnCall(data, false), false, opts);

    assert.match(rendered, /ada@example\.com/);
    assert.equal(rendered.includes("Should Be Ignored"), false);
  });

  it("recurses into nested participants from expanded escalations", () => {
    const data: OnCallData = {
      onCallParticipants: [
        {
          id: "e1",
          name: "Escalation",
          type: "escalation",
          onCallParticipants: [{ id: "u1", name: "Ada", type: "user" }],
        },
      ],
    };
    const rendered = renderOnCall(extractOnCall(data, false), false, opts);

    assert.match(rendered, /Escalation/);
    assert.match(rendered, /Ada/);
  });

  it("recurses into next-on-call participants, which nest under their own key", () => {
    const data: OnCallData = {
      nextOnCallParticipants: [
        {
          id: "e1",
          type: "escalation",
          nextOnCallParticipants: [{ id: "u1", name: "Ada", type: "user" }],
        },
      ],
    };
    assert.match(renderOnCall(extractOnCall(data, true), true, opts), /Ada/);
  });

  it("credits a forwarded shift to the person it came from", () => {
    const data: OnCallData = {
      onCallParticipants: [
        {
          id: "u1",
          name: "Grace",
          type: "user",
          forwardedFrom: { user: { id: "u2", name: "Ada" } } as never,
        },
      ],
    };
    assert.match(renderOnCall(extractOnCall(data, false), false, opts), /Ada.*forwarded/);
  });

  it("credits a forward given in the documented un-nested shape", () => {
    const data: OnCallData = {
      onCallParticipants: [
        { id: "u1", name: "Grace", type: "user", forwardedFrom: { id: "u2", name: "Ada" } },
      ],
    };
    assert.match(renderOnCall(extractOnCall(data, false), false, opts), /Ada.*forwarded/);
  });

  // "noone" is the documented sentinel for an unfilled rotation slot. Matching
  // only the misspelled "none" let it through as a responder named by its uuid.
  it("drops placeholder participants of type 'noone'", () => {
    const data: OnCallData = { onCallParticipants: [{ id: "x", type: "noone" }] };
    assert.match(renderOnCall(extractOnCall(data, false), false, opts), /Nobody is on-call/);
  });

  it("drops placeholder participants of the legacy type 'none'", () => {
    const data: OnCallData = { onCallParticipants: [{ id: "x", name: "no-one", type: "none" }] };
    assert.match(renderOnCall(extractOnCall(data, false), false, opts), /Nobody is on-call/);
  });

  // Verbatim from the JSM Operations OpenAPI spec's OnCallResponse example.
  // The escalation expands to a user who is already listed at the top level,
  // so a naive flatten reports one person twice and reads as two responders.
  it("lists a person once even when an escalation expands to them again", () => {
    const data: OnCallData = {
      onCallParticipants: [
        { id: "team-1", type: "team" },
        { id: "5b2b0e011b3a756623f4e25e", type: "user" },
        {
          id: "esc-1",
          type: "escalation",
          onCallParticipants: [{ id: "5b2b0e011b3a756623f4e25e", type: "user" }],
        },
      ],
    };

    const responders = extractOnCall(data, false);
    const ids = responders.map((responder) => responder.id);

    assert.deepEqual(ids, ["team-1", "5b2b0e011b3a756623f4e25e", "esc-1"]);
  });

  // "forwarded" is a reason for being on-call, not a kind of responder. Storing
  // it in `type` made the forwarding person the one id that never resolved,
  // because the directory only looks up ids typed as users.
  it("keeps a forwarding responder typed as a user so it still resolves", () => {
    const data: OnCallData = {
      onCallParticipants: [
        {
          id: "u1",
          type: "user",
          forwardedFrom: { id: "u2", type: "user" },
        },
      ],
    };

    const forwarded = extractOnCall(data, false).find((responder) => responder.id === "u2");

    assert.equal(forwarded?.type, "user");
    assert.equal(forwarded?.forwarded, true);
  });

  it("marks a forwarded responder in the rendered line", () => {
    const rendered = renderOnCall([{ id: "u2", type: "user", forwarded: true }], false, {
      ...opts,
      directory: {
        names: new Map([["u2", { id: "u2", type: "user", displayName: "Grace" }]]),
      },
    });

    assert.match(rendered, /Grace/);
    assert.match(rendered, /forwarded/);
  });

  it("titles on the schedule label the caller resolved", () => {
    const rendered = renderOnCall(extractOnCall({ onCallUsers: ["a"] }, false), false, {
      scheduleLabel: "Payments",
    });
    assert.match(rendered, /# Currently on-call for Payments/);
  });

  it("reports a legacy shift-start time when one is present", () => {
    const data: OnCallData = {
      nextOnCallUsers: ["next@example.com"],
      exactNextOnCallTime: "2026-07-08T09:00:00.000Z",
    };
    const rendered = renderOnCall(extractOnCall(data, true), true, {
      ...opts,
      legacyShiftStart: data.exactNextOnCallTime,
    });

    assert.match(rendered, /# Next on-call for Primary/);
    assert.match(rendered, /Shift starts: 2026-07-08 09:00:00Z/);
  });

  // A real shift beats the legacy field: the timeline knows both ends.
  it("prefers a real shift over the legacy shift-start field", () => {
    const rendered = renderOnCall([{ id: "a" }], true, {
      ...opts,
      legacyShiftStart: "2026-07-08T09:00:00.000Z",
      shift: { start: "2026-08-23T09:00:00Z", end: "2026-08-24T09:00:00Z" },
    });

    assert.match(rendered, /2026-08-24 09:00:00Z/);
    assert.doesNotMatch(rendered, /2026-07-08/);
  });

  it("renders resolved names alongside the id, never instead of it", () => {
    const directory = {
      names: new Map([
        ["712020:abc", { id: "712020:abc", displayName: "Grace Hopper", emailAddress: "g@x.com" }],
      ]),
    };
    const rendered = renderOnCall(extractOnCall({ onCallUsers: ["712020:abc"] }, false), false, {
      ...opts,
      directory,
    });

    assert.match(rendered, /Grace Hopper/);
    assert.match(rendered, /g@x\.com/);
    // The id has to survive: it is what every other tool here accepts.
    assert.match(rendered, /712020:abc/);
  });

  // Losing a display name must never cost the reader the answer.
  it("still answers, with ids and a reason, when the lookup failed", () => {
    const rendered = renderOnCall(extractOnCall({ onCallUsers: ["712020:abc"] }, false), false, {
      ...opts,
      directory: { names: new Map(), note: "the credentials lack the Jira user scope" },
    });

    assert.match(rendered, /712020:abc/);
    assert.doesNotMatch(rendered, /Nobody is on-call/);
    assert.match(rendered, /lack the Jira user scope/);
  });
});

describe("renderAsyncReceipt", () => {
  it("surfaces the request id and points at the verification path", () => {
    const text = renderAsyncReceipt(
      "Acknowledge",
      { noun: "alert", id: baseAlert.id },
      {
        result: "Request will be processed",
        requestId: "req-123",
        took: 3,
      },
    );

    assert.match(text, /req-123/);
    assert.match(text, /asynchronously/);
    // The write tools' descriptions promise this pointer; if it disappears the
    // model will re-read the alert, see no change, and retry the write.
    assert.match(text, /jsm_get_request_status/);
  });

  it("degrades gracefully when the API omits the receipt fields", () => {
    const text = renderAsyncReceipt("Close", { noun: "alert", id: baseAlert.id }, {});
    assert.match(text, /not returned/);
    assert.match(text, /queued/);
  });
});

describe("renderFormat", () => {
  const structured = { alerts: [{ id: "a" }] };

  it("returns markdown text but still attaches the structured payload", () => {
    const result = renderFormat(ResponseFormat.MARKDOWN, "# Heading", structured);
    assert.equal(result.content[0]?.text, "# Heading");
    assert.deepEqual(result.structuredContent, structured);
  });

  it("returns pretty-printed JSON when JSON is requested", () => {
    const result = renderFormat(ResponseFormat.JSON, "# Heading", structured);
    assert.equal(result.content[0]?.text, JSON.stringify(structured, null, 2));
    assert.deepEqual(result.structuredContent, structured);
  });
});
