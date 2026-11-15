/**
 * What one code-mode invocation carries: its budgets, its deadline, and the
 * record of what it did.
 *
 * One context object is threaded through every operation a single dispatched
 * call or script performs, which is what makes the budgets *shared* rather than
 * per-call. A per-call budget would be no budget at all: a script could call
 * sixty operations, each one request, and spend sixty requests against a limit
 * of sixty-per-call without ever tripping it.
 *
 * Nothing in here is reachable from inside a sandbox. The budgets are charged
 * by the host function that implements an operation, on the parent side of the
 * boundary, so a script cannot raise one by assigning to it.
 */

import { randomUUID } from "node:crypto";

import type { CodeLimits } from "./limits.js";
import { createSemaphore, type Semaphore } from "./semaphore.js";

/**
 * Why an invocation failed.
 *
 * Five kinds rather than one message, because each has a different fix and the
 * model is the one who has to apply it: a `script` error means rewrite the
 * logic, a `budget` error means narrow the query, an `operation` error means
 * read the API's own advice, and an `engine` error is not the model's fault at
 * all. Collapsing them into "it failed" is how a model retries the same broken
 * script three times.
 */
export type CodeErrorKind =
  /** The script did not parse. */
  | "syntax"
  /** An exception the script did not catch. */
  | "script"
  /**
   * The call was refused before it was issued: an operation that does not
   * exist, is not loaded here, was not in the write allowlist, or was given
   * arguments its schema rejects.
   *
   * Separate from "script" because the fix is different and specific — enable a
   * toolset, name the operation in `allow`, correct a field — and separate from
   * "operation" because nothing reached Atlassian, so there is no API advice to
   * read.
   */
  | "dispatch"
  /** A budget was spent. */
  | "budget"
  /** An operation returned an API error. */
  | "operation"
  /** The sandbox itself failed. */
  | "engine";

/** Base for the errors code mode raises, so a handler can switch on `kind`. */
export abstract class CodeError extends Error {
  abstract readonly kind: CodeErrorKind;
}

/** A budget was spent. Thrown inside the script, so it can report partial results. */
export class BudgetError extends CodeError {
  readonly kind = "budget" as const;

  constructor(
    readonly budget: keyof CodeLimits,
    readonly limit: number,
    message: string,
  ) {
    super(message);
    this.name = "BudgetError";
  }
}

/**
 * An operation returned an API error.
 *
 * `message` is handleApiError's prose — the same text a classic tool returns,
 * carrying the scope advice, the plan-limit split and the tinyId hint that took
 * a live tenant to learn. The structured fields are additional, so a script can
 * branch on `status` instead of matching on prose, and the prose is still there
 * for the model to read when the script gives up.
 */
export class OperationError extends CodeError {
  readonly kind = "operation" as const;

  constructor(
    readonly operation: string,
    message: string,
    readonly status: number | undefined,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "OperationError";
  }
}

/** A call refused before it was issued. The message says what to change. */
export class DispatchError extends CodeError {
  readonly kind = "dispatch" as const;

  constructor(message: string) {
    super(message);
    this.name = "DispatchError";
  }
}

/** The sandbox itself failed. Reported as not the model's fault, and logged at error. */
export class EngineError extends CodeError {
  readonly kind = "engine" as const;

  constructor(message: string) {
    super(message);
    this.name = "EngineError";
  }
}

/**
 * The invocation-wide spend. Charged by the host, never by the script.
 *
 * Records are charged separately from requests because they bound different
 * things: requests bound what we do to Atlassian, records bound what we hold in
 * memory. A single request can return 100 records and a hundred requests can
 * return none.
 */
export interface Budget {
  /** Charges one HTTP request, retries included. Throws when the budget is spent. */
  chargeRequest(): void;
  /** Charges `count` materialised records. Throws when the budget is spent. */
  chargeRecords(count: number): void;
  readonly requests: number;
  readonly records: number;
}

export function createBudget(limits: CodeLimits): Budget {
  let requests = 0;
  let records = 0;

  return {
    chargeRequest() {
      // Charged before the request is issued, not after it succeeds: a budget
      // that only counted successes would let a script retry forever.
      if (requests >= limits.maxRequests) {
        throw new BudgetError(
          "maxRequests",
          limits.maxRequests,
          `This call has already made ${requests} HTTP requests, which is its limit. ` +
            `Narrow the query, lower 'max' on an auto-paged read, or split the work across ` +
            `calls. Results gathered before this point are still valid.`,
        );
      }
      requests += 1;
    },
    chargeRecords(count) {
      if (records + count > limits.maxRecords) {
        throw new BudgetError(
          "maxRecords",
          limits.maxRecords,
          `This call has read ${records} records and asked for ${count} more, past its limit ` +
            `of ${limits.maxRecords}. Filter server-side with a narrower query, or ask for ` +
            `fewer records.`,
        );
      }
      records += count;
    },
    get requests() {
      return requests;
    },
    get records() {
      return records;
    },
  };
}

/**
 * The invocation's wall clock, as an AbortSignal the HTTP client can honour.
 *
 * This exists because the two timeouts disagree: REQUEST_TIMEOUT_MS is 30
 * seconds and a code-mode invocation gets 10, so without propagating a signal
 * one slow request would outlive the whole invocation's deadline and block for
 * twenty seconds after it had already failed. Passing this signal into axios is
 * what makes the deadline mean something.
 */
export interface Deadline {
  readonly signal: AbortSignal;
  remainingMs(): number;
  expired(): boolean;
  /** Throws a BudgetError if the deadline has passed. Call before starting work. */
  check(): void;
  /** Clears the timer. Must be called in a finally, or a busy server accumulates them. */
  dispose(): void;
}

export function createDeadline(timeoutMs: number, now: () => number = Date.now): Deadline {
  const startedAt = now();
  const controller = new AbortController();
  // Unref'd so a pending deadline cannot hold the event loop open and keep a
  // stdio server alive after its client has gone.
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  const remainingMs = () => Math.max(0, timeoutMs - (now() - startedAt));

  return {
    signal: controller.signal,
    remainingMs,
    expired: () => remainingMs() === 0,
    check() {
      if (remainingMs() === 0) {
        throw new BudgetError(
          "timeoutMs",
          timeoutMs,
          `This call ran past its ${timeoutMs}ms deadline. Narrow the work, or raise ` +
            `JSM_CODE_TIMEOUT_MS where this server is configured. Results gathered before ` +
            `this point are still valid.`,
        );
      }
    },
    dispose() {
      clearTimeout(timer);
    },
  };
}

/** A write that completed, for reporting partial application. */
export interface AppliedWrite {
  operation: string;
  subject?: string;
}

export interface CallContext {
  /** Correlates every log line and every error message for this invocation. */
  readonly invocationId: string;
  readonly limits: CodeLimits;
  readonly budget: Budget;
  readonly deadline: Deadline;
  /** Caps concurrent outbound requests across the whole invocation. */
  readonly inflight: Semaphore;
  /**
   * Write operations this invocation may call. Empty means reads only.
   *
   * A set rather than a boolean because the approval the client showed named
   * specific operations, and anything outside that set was not approved.
   */
  readonly allowWrites: ReadonlySet<string>;
  /** Operations called, in order, for the audit line. */
  readonly operations: string[];
  /**
   * Writes that completed, in order.
   *
   * There are no transactions here. A script that fails after three of forty
   * writes has applied three, and without this the only recovery is to re-run
   * and risk doing those three twice.
   */
  readonly applied: AppliedWrite[];
}

export interface CallContextOptions {
  limits: CodeLimits;
  allowWrites?: Iterable<string>;
  invocationId?: string;
  now?: () => number;
}

export function createCallContext(options: CallContextOptions): CallContext {
  const { limits } = options;
  return {
    invocationId: options.invocationId ?? randomUUID(),
    limits,
    budget: createBudget(limits),
    deadline: createDeadline(limits.timeoutMs, options.now),
    inflight: createSemaphore(limits.maxInflight),
    allowWrites: new Set(options.allowWrites ?? []),
    operations: [],
    applied: [],
  };
}
