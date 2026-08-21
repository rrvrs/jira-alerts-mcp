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
  fail,
  ok,
  renderAlertDetail,
  renderAlertLine,
  renderAsyncReceipt,
  renderFormat,
  renderLogs,
  renderNotes,
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
    assert.deepEqual(buildPagination(20, 20, 0), {
      count: 20,
      offset: 0,
      has_more: true,
      next_offset: 20,
    });
  });

  it("reports no more when the page came back short", () => {
    assert.deepEqual(buildPagination(7, 20, 40), {
      count: 7,
      offset: 40,
      has_more: false,
    });
  });

  it("omits offset and next_offset for cursor-paged endpoints", () => {
    const meta = buildPagination(20, 20, undefined, undefined, "cursor-abc");
    assert.equal("offset" in meta, false);
    assert.equal("next_offset" in meta, false);
    assert.equal(meta.next_cursor, "cursor-abc");
  });

  it("treats a cursor as proof of more results even on a short page", () => {
    const meta = buildPagination(3, 20, undefined, undefined, "cursor-abc");
    assert.equal(meta.has_more, true);
  });

  it("passes through totalCount only when supplied", () => {
    assert.equal(buildPagination(5, 20, 0, 137).total, 137);
    assert.equal("total" in buildPagination(5, 20, 0), false);
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

  it("flattens responders and teams into one line, preferring name over id", () => {
    const detail = renderAlertDetail({
      ...baseAlert,
      responders: [{ id: "u1", name: "Ada" }, { id: "u2", username: "grace@example.com" }],
      teams: [{ id: "t1", name: "Platform" }],
    });
    assert.match(detail, /\*\*Responders\*\*: Ada, grace@example\.com, Platform/);
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
  it("says nobody is on-call rather than returning an empty list", () => {
    const data: OnCallData = { _parent: { name: "Primary" }, onCallRecipients: [] };
    assert.match(renderOnCall(data, false), /Nobody is on-call/);
  });

  it("prefers the flat recipient list when the API returns one", () => {
    const data: OnCallData = {
      _parent: { name: "Primary" },
      onCallRecipients: ["ada@example.com"],
      onCallParticipants: [{ id: "u2", name: "Should Be Ignored", type: "user" }],
    };
    const rendered = renderOnCall(data, false);
    assert.match(rendered, /- ada@example\.com/);
    assert.equal(rendered.includes("Should Be Ignored"), false);
  });

  it("recurses into nested participants from expanded escalations", () => {
    const data: OnCallData = {
      _parent: { name: "Primary" },
      onCallParticipants: [
        {
          id: "e1",
          name: "Escalation",
          type: "escalation",
          onCallParticipants: [{ id: "u1", name: "Ada", type: "user" }],
        },
      ],
    };
    const rendered = renderOnCall(data, false);
    assert.match(rendered, /Escalation \(escalation\)/);
    assert.match(rendered, /Ada \(user\)/);
  });

  it("credits a forwarded shift to the person it came from", () => {
    const data: OnCallData = {
      _parent: { name: "Primary" },
      onCallParticipants: [
        {
          id: "u1",
          name: "Grace",
          type: "user",
          forwardedFrom: { user: { id: "u2", name: "Ada" } },
        },
      ],
    };
    assert.match(renderOnCall(data, false), /Ada \(forwarded\)/);
  });

  it("drops placeholder participants of type 'none'", () => {
    const data: OnCallData = {
      _parent: { name: "Primary" },
      onCallParticipants: [{ id: "x", name: "no-one", type: "none" }],
    };
    assert.match(renderOnCall(data, false), /Nobody is on-call/);
  });

  it("reads the next-shift fields and reports when the shift starts", () => {
    const data: OnCallData = {
      _parent: { name: "Primary" },
      onCallRecipients: ["current@example.com"],
      nextOnCallRecipients: ["next@example.com"],
      exactNextOnCallTime: "2026-07-08T09:00:00.000Z",
    };
    const rendered = renderOnCall(data, true);
    assert.match(rendered, /# Next on-call for Primary/);
    assert.match(rendered, /- next@example\.com/);
    assert.match(rendered, /Shift starts: 2026-07-08 09:00:00Z/);
    assert.equal(rendered.includes("current@example.com"), false);
  });

  it("falls back to a generic heading when the schedule name is missing", () => {
    assert.match(renderOnCall({ onCallRecipients: ["a"] }, false), /Currently on-call for schedule/);
  });
});

describe("renderAsyncReceipt", () => {
  it("surfaces the request id and points at the verification path", () => {
    const text = renderAsyncReceipt("Acknowledge", baseAlert.id, {
      result: "Request will be processed",
      requestId: "req-123",
      took: 3,
    });

    assert.match(text, /req-123/);
    assert.match(text, /asynchronously/);
    // The write tools' descriptions promise this pointer; if it disappears the
    // model will re-read the alert, see no change, and retry the write.
    assert.match(text, /jsm_get_request_status/);
  });

  it("degrades gracefully when the API omits the receipt fields", () => {
    const text = renderAsyncReceipt("Close", baseAlert.id, {});
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
