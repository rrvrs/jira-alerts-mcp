/**
 * One log line per code-mode invocation.
 *
 * A classic tool call is one request, and the client's own transcript is the
 * record of it. A dispatched call can issue sixty, and a write made through
 * jsm_apply does not carry its operation in the tool name — so "what did this
 * server do with my credential" stops being answerable from the transcript
 * alone. This makes it answerable again.
 *
 * What is logged: the operations called, the counts, the duration, the outcome.
 * What is not: arguments, request bodies and response bodies. Alert messages,
 * descriptions and notes are written by whatever integration fired them, so
 * they are untrusted input that may contain anything, and a log file is a place
 * people forget to treat as sensitive.
 *
 * Writes log unconditionally, at info. A write made through a dispatcher has to
 * be as traceable as one made through its own tool, or code mode is a way to
 * make changes that leave less of a trail.
 */

import { log as defaultLog, type Logger } from "../../services/log.js";
import { CodeError, type CallContext } from "./context.js";

export interface AuditEntry {
  /** The MCP tool the call arrived through. */
  tool: string;
  ctx: CallContext;
  startedAt: number;
  error?: unknown;
  /** Extra fields, e.g. whether the sweep completed. */
  fields?: Record<string, unknown>;
}

export function auditInvocation(entry: AuditEntry, logger: Logger = defaultLog): void {
  const { tool, ctx, startedAt, error, fields } = entry;

  const line = {
    invocationId: ctx.invocationId,
    tool,
    outcome: error ? "error" : "ok",
    ...(error ? { errorKind: error instanceof CodeError ? error.kind : "unknown" } : {}),
    durationMs: Date.now() - startedAt,
    requests: ctx.budget.requests,
    records: ctx.budget.records,
    // Deduplicated and sorted: a sweep calls one operation many times and the
    // line should say which operations ran, not how many times each.
    operations: [...new Set(ctx.operations)].sort(),
    ...(ctx.applied.length ? { applied: ctx.applied } : {}),
    ...fields,
  };

  // A failed write still gets an info line: "we tried to delete this and it
  // failed" is exactly as worth recording as a success.
  if (error && !ctx.applied.length) logger.warn("code.invocation", line);
  else logger.info("code.invocation", line);
}
