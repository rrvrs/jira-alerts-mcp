/**
 * The sandbox: a child `node --permission` process with an empty environment.
 *
 * See engine.ts for why this rather than QuickJS-WASM. What matters here is the
 * shape of the boundary: the child can compute and it can talk to this process
 * over a pipe, and that is all it can do. It has no filesystem, no sockets, no
 * `fetch`, no ability to spawn anything, and nothing in its environment — so
 * the Atlassian credential is not merely hidden from it, it is not there. Every
 * operation it performs is a message to this process, which holds the
 * credential and makes the request.
 *
 * The script is written to stdin rather than passed in argv, because argv is
 * readable by anything that can list processes and a script may legitimately
 * carry alert text or an account id.
 */

import { spawn } from "node:child_process";

import {
  CODE_MAX_CONCURRENT,
  CODE_MAX_LOG_LINES,
  CODE_MAX_SCRIPT_CHARS,
  CODE_MEMORY_MB,
} from "../../constants.js";
import { log as defaultLog, type Logger } from "../../services/log.js";
import { BudgetError, CodeError, DispatchError } from "./context.js";
import type { ScriptEngine, ScriptOutcome, ScriptRequest } from "./engine.js";
import { RUNNER_SOURCE, SELFTEST_SOURCE } from "./runner.js";
import { createSemaphore } from "./semaphore.js";

/** Cap on what the child may write back, so it cannot flood this process. */
const MAX_CHILD_BYTES = 8 * 1024 * 1024;

/** Longest single log line a script may send. Longer ones are cut in the child. */
const MAX_LINE_CHARS = 20_000;

/**
 * The first Node major whose permission model gates the network.
 *
 * `--allow-net` was added in v25.0.0. On Node 24 — which this package's
 * `engines` field allows — `--permission` restricts the filesystem,
 * subprocesses and workers and leaves sockets alone, so a script could open a
 * connection and send whatever it had read. Nothing in the test suite noticed,
 * because nothing in it tried to connect.
 */
export const SANDBOX_MIN_NODE_MAJOR = 25;

export interface SandboxSupport {
  supported: boolean;
  /** Why not, in words an operator can act on. */
  reason?: string;
}

/**
 * Whether this runtime can run the sandbox at all.
 *
 * The child runs `process.execPath`, so this process's version is the child's.
 * A version check is a claim read from a changelog; `verifyBoundary` below is
 * the same claim checked against the runtime, and both have to hold.
 */
export function sandboxSupport(version: string = process.versions.node): SandboxSupport {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  if (Number.isFinite(major) && major >= SANDBOX_MIN_NODE_MAJOR) return { supported: true };
  return {
    supported: false,
    reason:
      `jsm_run needs Node ${SANDBOX_MIN_NODE_MAJOR} or later; this server is running on Node ` +
      `${version}. Its sandbox relies on Node's permission model to deny network access, ` +
      `and that only exists from Node ${SANDBOX_MIN_NODE_MAJOR}. Every other tool works on ` +
      `this version.`,
  };
}

/** The flags every sandbox child is started with — scripts and the self-test alike. */
function sandboxArgs(memoryMb: number, source: string): string[] {
  return [
    "--permission",
    "--no-warnings",
    // Closes the way out of a vm context: without this, any host-realm function
    // a script holds leads to `fn.constructor("return process")()`.
    "--disallow-code-generation-from-strings",
    `--max-old-space-size=${memoryMb}`,
    "-e",
    source,
  ];
}

/** Nothing inherited — the credential lives in this process's environment. */
function sandboxEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...extra,
    // Node on Windows can fail to initialise without SystemRoot. It names a
    // directory and carries nothing sensitive.
    ...(process.platform === "win32" && process.env.SystemRoot
      ? { SystemRoot: process.env.SystemRoot }
      : {}),
  };
}

const DENIED = "ERR_ACCESS_DENIED";

/**
 * Starts a child exactly as a script's child is started and has it try to
 * read a file, spawn a process, open a socket and resolve a name.
 *
 * Every attempt has to be denied. Resolves to a reason when one was not.
 */
export async function verifyBoundary(execPath: string = process.execPath): Promise<SandboxSupport> {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const settle = (support: SandboxSupport) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve(support);
    };

    const child = spawn(execPath, sandboxArgs(CODE_MEMORY_MB, SELFTEST_SOURCE), {
      env: sandboxEnv(),
      stdio: ["ignore", "pipe", "ignore"],
    });
    const timer = setTimeout(
      () => settle({ supported: false, reason: "The sandbox self-test did not finish." }),
      10_000,
    );
    timer.unref?.();

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.on("error", (error) =>
      settle({ supported: false, reason: `The sandbox could not be started: ${error.message}` }),
    );
    child.on("exit", () => {
      let report: Record<string, string>;
      try {
        report = JSON.parse(output) as Record<string, string>;
      } catch {
        settle({ supported: false, reason: "The sandbox self-test produced no report." });
        return;
      }

      const open = ["fs", "spawn", "tcp", "dns"].filter((probe) => report[probe] !== DENIED);
      settle(
        open.length
          ? {
              supported: false,
              reason:
                `The sandbox does not hold on this runtime: ${open
                  .map((probe) => `${probe} was ${report[probe] ?? "not reported"}`)
                  .join(", ")}. jsm_run refuses to run scripts rather than run them ` +
                `somewhere they could reach out of. Every other tool still works.`,
            }
          : { supported: true },
      );
    });
  });
}

export interface ChildEngineOptions {
  memoryMb?: number;
  maxConcurrent?: number;
  maxLogLines?: number;
  logger?: Logger;
  /** Node binary to run. Defaults to this process's own. */
  execPath?: string;
}

interface ChildMessage {
  t: string;
  id?: number;
  text?: string;
  operation?: string;
  args?: unknown;
  allPages?: boolean;
  max?: number;
  kind?: string;
  name?: string;
  message?: string;
  logTruncated?: boolean;
}

export function createChildEngine(options: ChildEngineOptions = {}): ScriptEngine {
  const memoryMb = options.memoryMb ?? CODE_MEMORY_MB;
  const maxLogLines = options.maxLogLines ?? CODE_MAX_LOG_LINES;
  const logger = options.logger ?? defaultLog;
  const execPath = options.execPath ?? process.execPath;

  // Process-wide, not per server instance: the HTTP transport builds a fresh
  // server per request, so a per-instance cap would be no cap at all.
  const slots = createSemaphore(options.maxConcurrent ?? CODE_MAX_CONCURRENT);

  async function runInChild(request: ScriptRequest): Promise<ScriptOutcome> {
    const { script, ctx, call } = request;
    const logs: string[] = [];
    let truncated = false;
    let budgetHit: BudgetError | undefined;
    // Remembered so an error the script let propagate is reported as the kind
    // it actually was. The harness can only tell a SyntaxError from a thrown
    // one; it has no idea the parent refused a write, and reporting that as
    // "fix your script" would send the model to rewrite a correct script.
    let refusal: DispatchError | undefined;
    let received = 0;

    const child = spawn(execPath, sandboxArgs(memoryMb, RUNNER_SOURCE), {
      env: sandboxEnv({
        JSM_RUNNER_MAX_LOGS: String(maxLogLines),
        JSM_RUNNER_MAX_LINE: String(MAX_LINE_CHARS),
      }),
      stdio: ["pipe", "pipe", "pipe"],
    });

    // A reply written to a child that has just exited fails with EPIPE, and a
    // stream error with no listener is an uncaught exception — which would
    // take this whole server down because one script ended early. The reply is
    // simply no longer wanted.
    child.stdin.on("error", () => {});
    // Decoded as one stream, not chunk by chunk: a multi-byte character split
    // across two chunks would otherwise arrive as two replacement characters.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    let settle!: (outcome: ScriptOutcome) => void;
    const finished = new Promise<ScriptOutcome>((resolve) => {
      settle = resolve;
    });

    let done = false;
    const finish = (outcome: ScriptOutcome) => {
      if (done) return;
      done = true;
      clearTimeout(killTimer);
      child.kill("SIGKILL");
      settle(outcome);
    };

    // The deadline is the invocation's, not a second one: a script gets
    // whatever is left of the time its call was given.
    const killTimer = setTimeout(
      () =>
        finish({
          logs,
          truncated,
          error: {
            kind: "budget",
            message:
              `The script ran past its ${ctx.limits.timeoutMs}ms deadline and was stopped. ` +
              `Anything it logged before that point is above. Narrow the work, or raise ` +
              `JSM_CODE_TIMEOUT_MS where this server is configured.`,
          },
        }),
      Math.max(1, ctx.deadline.remainingMs()),
    );
    killTimer.unref?.();

    const write = (message: unknown) => {
      if (child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    async function onCall(message: ChildMessage): Promise<void> {
      try {
        const value = await call(
          message.operation ?? "",
          message.args ?? {},
          Boolean(message.allPages),
          message.max,
        );
        write({ t: "ok", id: message.id, value });
      } catch (error) {
        // Sent into the script rather than ending the run, so a script can
        // catch a 404 and carry on — and so a budget error lets it report what
        // it gathered before the budget ran out.
        if (error instanceof BudgetError) budgetHit = error;
        if (error instanceof DispatchError) refusal = error;
        const asCode = error instanceof CodeError ? error : undefined;
        write({
          t: "err",
          id: message.id,
          name: asCode?.name ?? "Error",
          message: error instanceof Error ? error.message : String(error),
          operation: message.operation,
          status: (error as { status?: number }).status,
          retryable: (error as { retryable?: boolean }).retryable ?? false,
        });
      }
    }

    let buffer = "";
    child.stdout.on("data", (chunk: string) => {
      received += chunk.length;
      if (received > MAX_CHILD_BYTES) {
        finish({
          logs,
          truncated: true,
          error: {
            kind: "budget",
            message: `The script wrote more than ${MAX_CHILD_BYTES} bytes and was stopped. Log a summary rather than whole records.`,
          },
        });
        return;
      }

      buffer += chunk;
      // Newline-framed: a chunk can split a message, so only complete lines are
      // parsed and the remainder waits for the next chunk.
      while (true) {
        const index = buffer.indexOf("\n");
        if (index < 0) break;

        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;

        let message: ChildMessage;
        try {
          message = JSON.parse(line) as ChildMessage;
        } catch {
          // The child only ever writes framed JSON, so this is a bug or a
          // corrupted pipe. Skipping is better than failing the whole run.
          continue;
        }

        if (message.t === "log") {
          // The child cuts long lines itself. Cut again here, because this
          // process is the authority on what reaches the model and should not
          // depend on the child having behaved.
          const text = message.text ?? "";
          if (text.length > MAX_LINE_CHARS + 200) truncated = true;
          logs.push(text.slice(0, MAX_LINE_CHARS + 200));
        } else if (message.t === "call") {
          void onCall(message);
        } else if (message.t === "done") {
          finish({ logs, truncated: truncated || Boolean(message.logTruncated) });
        } else if (message.t === "fail") {
          finish({
            logs,
            truncated: truncated || Boolean(message.logTruncated),
            error: {
              // A budget or a refusal reached mid-script is reported as what it
              // was, even when the script let it propagate: "narrow the work"
              // and "that operation is not available here" are the actionable
              // advice, not "fix your script".
              kind: budgetHit
                ? "budget"
                : refusal
                  ? "dispatch"
                  : message.kind === "syntax"
                    ? "syntax"
                    : "script",
              message: budgetHit
                ? budgetHit.message
                : refusal
                  ? refusal.message
                  : `${message.name ?? "Error"}: ${message.message ?? "the script failed"}`,
            },
          });
        }
      }
    });

    let stderr = "";
    child.stderr.on("data", (chunk: string) => {
      // Kept for diagnostics only. A heap exhaustion prints here rather than
      // sending a message, which is the one failure the protocol cannot report.
      if (stderr.length < 4_000) stderr += chunk;
    });

    child.on("error", (error) => {
      finish({
        logs,
        truncated,
        error: {
          kind: "engine",
          message:
            `The sandbox could not be started: ${error.message}. This is not a problem with ` +
            `the script. Every other tool on this server still works.`,
        },
      });
    });

    child.on("exit", (code, signal) => {
      if (done) return;
      const outOfMemory = /heap out of memory|Allocation failed/i.test(stderr);
      finish({
        logs,
        truncated,
        error: {
          kind: outOfMemory ? "budget" : "engine",
          message: outOfMemory
            ? `The script exhausted its ${memoryMb}MB of memory and was stopped. Hold less at once — filter each page before keeping it rather than collecting everything first.`
            : `The sandbox exited unexpectedly (code ${code}, signal ${signal}) without reporting a result.${stderr ? ` It said: ${stderr.trim().slice(0, 300)}` : ""}`,
        },
      });
    });

    write({ t: "script", code: script });

    const outcome = await finished;
    if (outcome.error?.kind === "engine") {
      logger.error("code.sandbox", {
        invocationId: ctx.invocationId,
        message: outcome.error.message,
      });
    }
    return outcome;
  }

  // Checked once per engine, on first use, and remembered. Lazily, so a server
  // that never runs a script never pays for a probe.
  let boundary: Promise<SandboxSupport> | undefined;
  const boundaryHolds = (): Promise<SandboxSupport> => {
    const byVersion = sandboxSupport();
    if (!byVersion.supported) return Promise.resolve(byVersion);
    boundary ??= verifyBoundary(execPath);
    return boundary;
  };

  return {
    async run(request) {
      const support = await boundaryHolds();
      if (!support.supported) {
        logger.error("code.sandbox", { message: support.reason });
        return {
          logs: [],
          truncated: false,
          error: { kind: "engine", message: support.reason ?? "The sandbox is unavailable." },
        };
      }

      if (request.script.length > CODE_MAX_SCRIPT_CHARS) {
        // Refused before a process is spawned: there is no point paying for one
        // to reject something this early.
        throw new DispatchError(
          `The script is ${request.script.length} characters, past the ` +
            `${CODE_MAX_SCRIPT_CHARS}-character limit. Split the work across calls.`,
        );
      }

      // Over capacity, say so and let the model retry. A call that queues
      // indefinitely looks to a client exactly like a server that has hung.
      if (slots.active >= (options.maxConcurrent ?? CODE_MAX_CONCURRENT)) {
        throw new DispatchError(
          `This server is already running ${slots.active} scripts, which is its limit. ` +
            `Retry in a moment, or use jsm_call for a single operation.`,
        );
      }

      return slots.run(() => runInChild(request));
    },

    async dispose() {
      // Nothing is held between invocations: each script gets its own process
      // and that process is killed when it finishes. There is deliberately no
      // pool — a reused sandbox is a sandbox one script can leave dirty for the
      // next, which is the failure QuickJS demonstrated when an out-of-memory
      // condition poisoned every later run in the same runtime.
    },
  };
}

/**
 * The process-wide engine.
 *
 * Memoised deliberately. The HTTP transport builds a fresh McpServer for every
 * request, so an engine created per server would give each request its own
 * concurrency semaphore — which is no cap at all, and the difference between
 * two sandbox processes and one per in-flight request.
 */
let shared: ScriptEngine | undefined;

export function sharedChildEngine(options: ChildEngineOptions = {}): ScriptEngine {
  shared ??= createChildEngine(options);
  return shared;
}

/** Test-only: drops the memoised engine so options can be changed. */
export function resetSharedChildEngine(): void {
  shared = undefined;
}
