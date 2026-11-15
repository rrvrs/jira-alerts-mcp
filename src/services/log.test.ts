import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createLogger, parseLogLevel } from "./log.js";

/** Collects finished lines, parsed, so assertions read as fields not substrings. */
function sink() {
  const lines: Array<Record<string, unknown>> = [];
  const raw: string[] = [];
  return {
    lines,
    raw,
    write: (line: string) => {
      raw.push(line);
      lines.push(JSON.parse(line) as Record<string, unknown>);
    },
  };
}

describe("parseLogLevel", () => {
  it("accepts the four levels, case and whitespace insensitively", () => {
    assert.equal(parseLogLevel("debug"), "debug");
    assert.equal(parseLogLevel(" WARN "), "warn");
  });

  it("falls back rather than throwing, so a typo cannot stop the server", () => {
    // Deliberately unlike JSM_TOOLSETS, which fails loudly: a wrong toolset
    // silently shrinks what an agent can reach, and a wrong log level costs
    // nothing but log lines.
    assert.equal(parseLogLevel("verbose"), "info");
    assert.equal(parseLogLevel(undefined), "info");
    assert.equal(parseLogLevel(""), "info");
  });
});

describe("createLogger", () => {
  it("emits one JSON object per line, with ts, level and event", () => {
    const out = sink();
    const log = createLogger({ write: out.write, now: () => new Date("2026-11-07T12:00:00Z") });

    log.info("code.invocation", { requests: 7 });

    assert.equal(out.lines.length, 1);
    assert.deepEqual(out.lines[0], {
      ts: "2026-11-07T12:00:00.000Z",
      level: "info",
      event: "code.invocation",
      requests: 7,
    });
    assert.ok(!out.raw[0]?.includes("\n"), "a line must not contain a newline");
  });

  it("withholds anything above the configured level", () => {
    const out = sink();
    const log = createLogger({ level: "warn", write: out.write });

    log.error("a");
    log.warn("b");
    log.info("c");
    log.debug("d");

    assert.deepEqual(
      out.lines.map((line) => line.event),
      ["a", "b"],
    );
    assert.equal(log.enabled("info"), false);
    assert.equal(log.enabled("warn"), true);
  });

  it("redacts credential-shaped strings wherever they are nested", () => {
    // Defence in depth: nothing is supposed to pass a credential here, and a
    // separate test proves the dispatcher does not. This asserts that if a
    // future change breaks that, the token lands in the log redacted.
    const out = sink();
    const log = createLogger({ write: out.write });

    log.info("probe", {
      header: "Authorization: Bearer abcdef0123456789",
      nested: { list: ["Basic dXNlcjpwYXNzd29yZA=="] },
    });

    const line = out.raw[0] ?? "";
    assert.ok(!line.includes("abcdef0123456789"), `token survived: ${line}`);
    assert.ok(!line.includes("dXNlcjpwYXNzd29yZA=="), `basic auth survived: ${line}`);
    assert.match(line, /Bearer \[REDACTED\]/);
    assert.match(line, /Basic \[REDACTED\]/);
  });

  it("truncates a long field rather than writing a response body into the log", () => {
    const out = sink();
    const log = createLogger({ write: out.write });

    log.info("probe", { body: "x".repeat(5_000) });

    const body = out.lines[0]?.body as string;
    assert.ok(body.length < 2_200, `expected truncation, got ${body.length} chars`);
    assert.match(body, /… \[5000 chars\]$/);
  });

  it("costs a self-referential field, not the whole line", () => {
    // Without cycle detection scrub() recurses until the stack overflows, and
    // it throws before JSON.stringify could be caught — so the logger itself
    // became the thing that failed the request.
    const out = sink();
    const log = createLogger({ write: out.write });

    const cyclic: Record<string, unknown> = { kept: "visible" };
    cyclic.self = cyclic;
    log.info("probe", cyclic);

    assert.equal(out.lines.length, 1);
    assert.equal(out.lines[0]?.event, "probe");
    assert.equal(out.lines[0]?.kept, "visible");
    assert.equal(out.lines[0]?.self, "[Circular]");
  });

  it("still emits a line when a field genuinely cannot be serialised", () => {
    const out = sink();
    const log = createLogger({ write: out.write });

    log.info("probe", { big: 1n });

    assert.equal(out.lines.length, 1);
    assert.equal(out.lines[0]?.logError, "unserialisable fields");
    assert.equal(out.lines[0]?.event, "probe");
  });

  it("keeps an Error readable instead of serialising it to {}", () => {
    const out = sink();
    const log = createLogger({ write: out.write });

    log.error("failed", { cause: new TypeError("bad shape") });

    assert.deepEqual(out.lines[0]?.cause, { name: "TypeError", message: "bad shape" });
  });
});
