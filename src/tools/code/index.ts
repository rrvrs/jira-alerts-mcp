/**
 * Code mode's tools, assembled for one process.
 *
 * Built per process rather than declared statically, for the same reason
 * createCapabilitiesTool is: their descriptions report what THIS install can
 * reach. jsm_call embeds the operation index, jsm_apply lists the writes, and
 * both change with JSM_TOOLSETS — a static description would be wrong on every
 * install but one.
 *
 * They are therefore not in `allTools`, which is also what keeps them out of
 * the endpoint drift guard: `jsm_call` reaches ninety-four endpoints and has no
 * single one to declare.
 */

import type { JsmClient } from "../../services/client.js";
import type { AnyToolDefinition } from "../define.js";
import { createApplyTool } from "./apply.js";
import { createCallTool, type CodeToolDependencies } from "./call.js";
import { type SandboxSupport, sandboxSupport, sharedChildEngine } from "./child-engine.js";
import { createCallContext } from "./context.js";
import { createDispatcher } from "./dispatch.js";
import type { ScriptEngine } from "./engine.js";
import {
  type CodeLimits,
  type CodePermissions,
  resolveCodePermissions,
  resolveLimits,
} from "./limits.js";
import { createRegistry, type OperationRegistry } from "./registry.js";
import { createReadTool } from "./read.js";
import { createRunTool } from "./run.js";
import { createSearchTool } from "./search.js";

export interface CodeModeOptions {
  /** The whole catalogue. Searched in full, so a model is never told a family does not exist. */
  catalogue: readonly AnyToolDefinition[];
  /** Tool names this process may dispatch, from the selection. */
  reachable: ReadonlySet<string>;
  client: JsmClient;
  limits?: CodeLimits;
  permissions?: CodePermissions;
  /** Withholds every write tool, as JSM_READ_ONLY does for the classic ones. */
  readOnly?: boolean;
  /**
   * What runs a script. Defaults to the process-wide sandbox.
   *
   * Injectable so a test can drive jsm_run without spawning a process, and so
   * the engine stays swappable — the choice between a child process and a WASM
   * interpreter was made on evidence and may be revisited. See engine.ts.
   */
  engine?: ScriptEngine;
  /**
   * Whether scripts can be run here. Defaults to asking the runtime.
   *
   * jsm_run is registered only when they can: its sandbox depends on Node's
   * permission model denying the network, which it does only from Node 25, and
   * this package still supports 24. A tool that is listed and then refuses
   * every call is worse than one that is absent and explained — the model
   * plans around a capability it does not have.
   */
  sandbox?: SandboxSupport;
}

/**
 * Every name code mode can register, on any runtime.
 *
 * Stated rather than derived, because what is registered varies — jsm_run by
 * Node version, jsm_apply by read-only mode — and the docs coverage test needs
 * the whole set whichever runtime it happens to run on.
 */
export const CODE_TOOL_NAMES = [
  "jsm_search_api",
  "jsm_read_api",
  "jsm_call",
  "jsm_run",
  "jsm_apply",
] as const;

export interface CodeMode {
  tools: AnyToolDefinition[];
  registry: OperationRegistry;
  /** Whether jsm_run was registered, and why not when it was not. */
  sandbox: SandboxSupport;
}

/**
 * The tools, plus the registry so a caller can report on it.
 *
 * The registry is built once here and shared by every tool: it runs 94
 * input shapes through z.toJSONSchema to build declarations, and doing that per
 * call would be work with no reason to repeat.
 */
export function createCodeMode(options: CodeModeOptions): CodeMode {
  const limits = options.limits ?? resolveLimits(process.env);
  const permissions = options.permissions ?? resolveCodePermissions(process.env);

  const registry = createRegistry(options.catalogue, options.reachable);
  const dispatcher = createDispatcher(registry, options.client, {
    writesAvailable: !options.readOnly,
  });
  // An injected engine is the caller vouching for it; otherwise ask the runtime.
  const sandbox = options.sandbox ?? (options.engine ? { supported: true } : sandboxSupport());

  const dependencies: CodeToolDependencies = {
    registry,
    dispatcher,
    limits,
    newContext: (allowWrites) =>
      createCallContext({ limits, ...(allowWrites ? { allowWrites } : {}) }),
  };

  const tools = [
    createSearchTool(registry),
    createReadTool(registry),
    createCallTool(dependencies),
    // Read-only by construction: the context it builds carries no write
    // allowlist, so the dispatcher refuses anything that is not a GET. It
    // therefore survives JSM_READ_ONLY, like the other read tools.
    ...(sandbox.supported
      ? [createRunTool(dependencies, options.engine ?? sharedChildEngine())]
      : []),
    // Withheld under read-only, exactly as resolveSelection withholds every
    // write tool.
    ...(options.readOnly ? [] : [createApplyTool(dependencies, permissions)]),
  ];

  return { tools, registry, sandbox };
}

export { createRegistry, type OperationRegistry } from "./registry.js";
export { resolveCodePermissions, resolveLimits } from "./limits.js";
export { type SandboxSupport, sandboxSupport, sharedChildEngine } from "./child-engine.js";
export type { ScriptEngine } from "./engine.js";
