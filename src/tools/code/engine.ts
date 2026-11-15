/**
 * What runs a script, behind one interface.
 *
 * The interface exists because the engine was chosen on evidence rather than on
 * paper, and may be chosen again. The plan for this work named QuickJS compiled
 * to WebAssembly as the first choice — a runtime with no filesystem, no network
 * and no `process` to deny — and said to spike the asyncify bridge before
 * committing to the dependency. The spike failed, twice over: a module's
 * top-level `await` leaves a pending job that only a synchronous
 * `executePendingJobs` can drive, so every statement after the first `await` on
 * a host function was silently dropped; and disposing a runtime afterwards
 * aborted the WASM module with `Assertion failed: list_empty(&rt->gc_obj_list)`.
 * An engine that loses half a script and then crashes on cleanup is not one to
 * build a security boundary on.
 *
 * So the implementation is the fallback the plan pre-designed: a child
 * `node --permission` process. Measured on this machine, bare `--permission`
 * denies the guest `fs` (ERR_ACCESS_DENIED), outbound DNS and sockets
 * (`getaddrinfo ERR_ACCESS_DENIED`), `fetch`, `child_process` and
 * `worker_threads`, and spawning with `env: {}` leaves it nothing to read: the
 * only variable present was macOS's own `__CF_USER_TEXT_ENCODING`. SIGKILL ends
 * a runaway in about 200ms.
 *
 * Two things that first version got wrong, both found in review rather than in
 * testing, and both now covered:
 *
 * It was verified on Node 26 only. The permission model denies network access
 * from v25.0.0; on Node 24, which this package's `engines` allows, the same
 * flags leave sockets open. So scripts run only on Node 25+, and before the
 * first one a self-test has a child try a file, a subprocess, a socket and a
 * lookup — see `verifyBoundary`.
 *
 * And `process.kill` is not gated by the permission model at all, so anything
 * that let a script reach the real `process` let it signal this server. The
 * script therefore runs in an empty `vm` realm inside the child — see
 * runner.ts — which makes the difference from the WASM option smaller than it
 * was: what the script can see is now "absent from its realm", and only the
 * process-level guarantees remain "denied by a check".
 *
 * Swapping the engine later touches this file and its implementation only.
 */

import type { CallContext, CodeErrorKind } from "./context.js";

/** Resolves one operation call made from inside a script. */
export type ScriptCall = (
  operation: string,
  args: unknown,
  allPages: boolean,
  max?: number,
) => Promise<unknown>;

export interface ScriptRequest {
  script: string;
  ctx: CallContext;
  call: ScriptCall;
}

export interface ScriptOutcome {
  /** What the script logged, in order. This is all the model sees of its working. */
  logs: string[];
  /** True when log lines were dropped because the script emitted too many. */
  truncated: boolean;
  error?: { kind: CodeErrorKind; message: string };
}

export interface ScriptEngine {
  run(request: ScriptRequest): Promise<ScriptOutcome>;
  /** Releases anything held across invocations. Called when the server closes. */
  dispose(): Promise<void>;
}
