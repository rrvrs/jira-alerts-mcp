/**
 * Which tools this process registers, and how the user chooses.
 *
 * The JSM Operations API is ~240 operations. Registering all of them would
 * hand every client a tool list it cannot select from accurately, so the
 * surface is cut into named toolsets and the user picks. The catalogue grows;
 * what any one install loads does not have to.
 *
 * Two kinds of name are accepted in the same namespace, because from the
 * user's side they are the same thing — a label that expands to some tools:
 *
 *   toolsets  one API family, mapping to exactly one scope family, so
 *             JSM_TOOLSETS doubles as documentation of the grants the token
 *             needs.
 *   profiles  a workflow-shaped bundle of toolsets, because the personas
 *             genuinely differ: an incident responder never touches sync
 *             actions, and someone configuring routing rules is not mid-page.
 *
 * Only implemented toolsets are listed. A family that has not shipped yet is
 * not a name you can type — an empty toolset would answer "enabled, 0 tools"
 * to jsm_list_capabilities, which reads as a broken install rather than an
 * absent feature. Adding a family adds its name here, in one place.
 */

import type { AnyToolDefinition } from "./tools/define.js";

/** Every toolset that ships tools today. */
export const TOOLSETS = ["alerts", "alert-actions", "oncall"] as const;

export type ToolsetName = (typeof TOOLSETS)[number];

/**
 * Marks a tool that registers regardless of what the user selected. Not a name
 * anyone can type in JSM_TOOLSETS — it is how jsm_list_capabilities stays
 * present to explain a selection that would otherwise hide it.
 */
export const ALWAYS = "always";

/** What a tool declares: a real toolset, or ALWAYS. */
export type ToolGroup = ToolsetName | typeof ALWAYS;

export interface ToolsetInfo {
  /** One line, shown by jsm_list_capabilities. */
  summary: string;
  /** OAuth scopes every tool in this set needs. */
  scopes: string[];
}

export const TOOLSET_INFO: Record<ToolsetName, ToolsetInfo> = {
  alerts: {
    summary: "Read alerts: search, detail, notes, activity logs, async request status.",
    scopes: ["read:ops-alert:jira-service-management"],
  },
  "alert-actions": {
    summary: "Act on alerts: acknowledge, close, annotate, add responders.",
    scopes: ["read:ops-alert:jira-service-management", "write:ops-alert:jira-service-management"],
  },
  oncall: {
    summary: "On-call: schedule discovery, who is on call now and next, shift timelines.",
    scopes: ["read:ops-config:jira-service-management"],
  },
};

/**
 * The default selection: the tools that shipped before toolsets existed, plus
 * jsm_create_alert. Named individually rather than computed from toolsets.
 *
 * A computed default would silently grow every time a tool is added, and an
 * existing install would wake up to a changed tool list — and a changed
 * auto-approval surface — after a patch bump. Naming them freezes that: the
 * default moves only when someone edits this array and the snapshot test that
 * guards it, in a change that has to explain itself.
 *
 * It has moved once: jsm_create_alert was added, because a create tool nobody
 * can see without reconfiguring is not a create tool. That widens the default
 * auto-approval surface by one write, which is the cost, and it is why the
 * snapshot below is a literal list rather than a reference to this array.
 */
export const CORE_TOOL_NAMES = [
  "jsm_list_alerts",
  "jsm_get_alert",
  "jsm_list_alert_notes",
  "jsm_list_alert_logs",
  "jsm_get_request_status",
  "jsm_create_alert",
  "jsm_acknowledge_alert",
  "jsm_close_alert",
  "jsm_add_alert_note",
  "jsm_add_alert_responder",
  "jsm_list_schedules",
  "jsm_get_on_call",
  "jsm_get_next_on_call",
  "jsm_get_schedule_timeline",
] as const;

/**
 * Workflow bundles. `core` is by name and stays put; every other profile is by
 * toolset and grows with its families.
 *
 * `responder` and `core` hold the same tools today. They are not the same
 * thing: `responder` widens as the alert family is completed, `core` does not,
 * which is what makes it safe as the default.
 */
export const PROFILES = {
  core: { toolsets: ["alerts", "alert-actions", "oncall"], only: CORE_TOOL_NAMES },
  responder: { toolsets: ["alerts", "alert-actions", "oncall"] },
  all: { toolsets: TOOLSETS },
} as const satisfies Record<string, { toolsets: readonly ToolsetName[]; only?: readonly string[] }>;

export type ProfileName = keyof typeof PROFILES;

export const PROFILE_NAMES = Object.keys(PROFILES) as ProfileName[];

/** Everything accepted in JSM_TOOLSETS / --toolsets. */
export const SELECTABLE_NAMES: string[] = [...PROFILE_NAMES, ...TOOLSETS];

/** Thrown for a selection that cannot be honoured. Fatal at startup. */
export class ToolsetSelectionError extends Error {}

export interface Selection {
  /** The tools to register, in catalogue order. */
  tools: AnyToolDefinition[];
  /** Names the user asked for, verbatim, or ["core"] when they asked for nothing. */
  requested: string[];
  /** Toolsets those names expanded to. */
  toolsets: ToolsetName[];
  readOnly: boolean;
}

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv;
  argv?: string[];
}

function isProfile(name: string): name is ProfileName {
  return Object.hasOwn(PROFILES, name);
}

function isToolset(name: string): name is ToolsetName {
  return (TOOLSETS as readonly string[]).includes(name);
}

/** Edit distance, used only to turn a typo into a suggestion. */
function distance(a: string, b: string): number {
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) rows.push([i, ...Array<number>(b.length).fill(0)]);
  const first = rows[0]!;
  for (let j = 0; j <= b.length; j++) first[j] = j;

  for (let i = 1; i <= a.length; i++) {
    const row = rows[i]!;
    const prev = rows[i - 1]!;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost);
    }
  }
  return rows[a.length]![b.length]!;
}

function closest(name: string): string | undefined {
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of SELECTABLE_NAMES) {
    const d = distance(name.toLowerCase(), candidate.toLowerCase());
    if (d < bestDistance) {
      bestDistance = d;
      best = candidate;
    }
  }
  // Past roughly half the name's length a "did you mean" is noise, not help.
  return bestDistance <= Math.max(2, Math.ceil(name.length / 2)) ? best : undefined;
}

/** Reads `--flag=value`; returns undefined when the flag is absent. */
function flagValue(argv: string[], flag: string): string | undefined {
  const prefix = `${flag}=`;
  const hit = argv.find((entry) => entry.startsWith(prefix));
  return hit?.slice(prefix.length);
}

function parseNames(raw: string): string[] {
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Turns environment and argv into the exact tool list to register.
 *
 * Pure on purpose: no process.env read inside, no side effects, so the whole
 * mechanism is testable offline without spawning a server. CLI flags win over
 * environment, since a client's env block is configured once and a supervisor's
 * argv is the thing someone changes deliberately.
 */
export function resolveSelection(
  catalogue: AnyToolDefinition[],
  options: ResolveOptions = {},
): Selection {
  const env = options.env ?? {};
  const argv = options.argv ?? [];

  const rawNames = flagValue(argv, "--toolsets") ?? env.JSM_TOOLSETS ?? "";
  const requested = parseNames(rawNames);
  const readOnly = argv.includes("--read-only") || isTruthy(env.JSM_READ_ONLY);

  // Nothing asked for is not an error and not "everything" — it is the frozen
  // default. Falling back to the full catalogue would make a forgotten env var
  // silently widen what an agent can do.
  const effective = requested.length ? requested : ["core"];

  const toolsets = new Set<ToolsetName>();
  const onlyNames = new Set<string>();
  let restrictToNames = true;

  for (const name of effective) {
    if (isProfile(name)) {
      const profile = PROFILES[name];
      for (const toolset of profile.toolsets) toolsets.add(toolset);
      const only = "only" in profile ? profile.only : undefined;
      if (only) {
        for (const toolName of only) onlyNames.add(toolName);
      } else {
        restrictToNames = false;
      }
      continue;
    }

    if (isToolset(name)) {
      toolsets.add(name);
      restrictToNames = false;
      continue;
    }

    // A typo that silently yields a smaller surface is the worst bug report
    // there is — the tool "disappeared" and nothing said why. Fail loudly.
    const suggestion = closest(name);
    throw new ToolsetSelectionError(
      `Unknown toolset '${name}'. Valid names: ${SELECTABLE_NAMES.join(", ")}.` +
        (suggestion ? ` Did you mean '${suggestion}'?` : ""),
    );
  }

  // Widened to string: a tool's group may be ALWAYS, which is never a member
  // of the resolved toolsets and so is correctly excluded here. Tools marked
  // ALWAYS are registered by buildServer, outside the selection.
  const enabled: ReadonlySet<string> = toolsets;
  let tools = catalogue.filter((tool) => enabled.has(tool.toolset));
  if (restrictToNames && onlyNames.size) {
    tools = tools.filter((tool) => onlyNames.has(tool.name));
  }
  if (readOnly) {
    tools = tools.filter((tool) => tool.annotations.readOnlyHint);
  }

  if (!tools.length) {
    throw new ToolsetSelectionError(
      `That selection registers no tools: ${effective.join(", ")}` +
        (readOnly ? " with read-only mode on" : "") +
        `. Valid names: ${SELECTABLE_NAMES.join(", ")}.`,
    );
  }

  return {
    tools,
    requested: effective,
    toolsets: TOOLSETS.filter((name) => toolsets.has(name)),
    readOnly,
  };
}

function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}
