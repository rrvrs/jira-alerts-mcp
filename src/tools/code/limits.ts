/**
 * The budgets one code-mode invocation may spend, resolved from the environment.
 *
 * Pure, like resolveSelection and for the same reason: the whole mechanism is
 * testable offline without starting a server, and no function in here reads
 * process.env behind your back.
 *
 * Out-of-range and non-numeric values throw rather than falling back. A budget
 * is set deliberately, so one that silently reverts to the default is a config
 * that looks applied and is not — the same failure toolsets.ts calls "the worst
 * bug report there is" and refuses to produce.
 */

import {
  CODE_MAX_INFLIGHT,
  CODE_MAX_INFLIGHT_MAX,
  CODE_MAX_PAGES,
  CODE_MAX_PAGES_MAX,
  CODE_MAX_RECORDS,
  CODE_MAX_RECORDS_MAX,
  CODE_MAX_REQUESTS,
  CODE_MAX_REQUESTS_MAX,
  CODE_TIMEOUT_MS,
  CODE_TIMEOUT_MS_MAX,
} from "../../constants.js";

export interface CodeLimits {
  /** Wall clock for the whole invocation. */
  timeoutMs: number;
  /** HTTP requests, shared across every operation the invocation calls. */
  maxRequests: number;
  /** Records materialised, across every collection it reads. */
  maxRecords: number;
  /** Pages one auto-paged read may fetch. */
  maxPages: number;
  /** Concurrent outbound requests. */
  maxInflight: number;
}

/** Thrown for a budget that cannot be honoured. Fatal at startup. */
export class CodeLimitsError extends Error {}

interface Setting {
  env: string;
  key: keyof CodeLimits;
  fallback: number;
  /** Environment cannot raise a budget past this. */
  ceiling: number;
}

const SETTINGS: readonly Setting[] = [
  {
    env: "JSM_CODE_TIMEOUT_MS",
    key: "timeoutMs",
    fallback: CODE_TIMEOUT_MS,
    ceiling: CODE_TIMEOUT_MS_MAX,
  },
  {
    env: "JSM_CODE_MAX_REQUESTS",
    key: "maxRequests",
    fallback: CODE_MAX_REQUESTS,
    ceiling: CODE_MAX_REQUESTS_MAX,
  },
  {
    env: "JSM_CODE_MAX_RECORDS",
    key: "maxRecords",
    fallback: CODE_MAX_RECORDS,
    ceiling: CODE_MAX_RECORDS_MAX,
  },
  {
    env: "JSM_CODE_MAX_PAGES",
    key: "maxPages",
    fallback: CODE_MAX_PAGES,
    ceiling: CODE_MAX_PAGES_MAX,
  },
  {
    env: "JSM_CODE_MAX_INFLIGHT",
    key: "maxInflight",
    fallback: CODE_MAX_INFLIGHT,
    ceiling: CODE_MAX_INFLIGHT_MAX,
  },
];

/** Every environment variable this module reads, for the --help text and the README. */
export const LIMIT_VARIABLES: readonly string[] = SETTINGS.map((setting) => setting.env);

function read(setting: Setting, raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return setting.fallback;

  // Number() accepts "", " ", "0x10" and "1e3"; a budget is a plain decimal
  // integer and anything else is a typo worth reporting rather than coercing.
  if (!/^\d+$/.test(raw.trim())) {
    throw new CodeLimitsError(
      `${setting.env} must be a whole number, got '${raw}'. Valid range: 1 to ${setting.ceiling}.`,
    );
  }

  const value = Number.parseInt(raw.trim(), 10);
  if (value < 1 || value > setting.ceiling) {
    throw new CodeLimitsError(
      `${setting.env}=${value} is outside the permitted range 1 to ${setting.ceiling}. ` +
        `The upper bound is a hard limit in src/constants.ts and cannot be raised by ` +
        `configuration — it is what keeps a misconfiguration from becoming a way to ` +
        `hammer the Atlassian API with your credential.`,
    );
  }
  return value;
}

export function resolveLimits(env: NodeJS.ProcessEnv = {}): CodeLimits {
  const limits = {} as CodeLimits;
  for (const setting of SETTINGS) {
    limits[setting.key] = read(setting, env[setting.env]);
  }
  return limits;
}

/**
 * What code mode is permitted to do, as distinct from how much of it.
 *
 * Separate from CodeLimits because a budget and a permission fail differently:
 * exceeding a budget is a thing to narrow, and lacking a permission is a thing
 * the operator has to grant. Collapsing them would put "ask your admin" and
 * "ask for fewer records" behind the same error.
 */
export interface CodePermissions {
  /**
   * Whether jsm_apply may call a destructive operation.
   *
   * Default false, and deliberately an operator switch rather than something a
   * client annotation or a model argument can satisfy. Thirty-seven of the
   * ninety-four operations are destructive, and some clients auto-approve by
   * tool name or do not read annotations at all — so the only place this can be
   * enforced independently of client behaviour is here.
   *
   * This is the same shape as `unverified` in toolsets.ts: the capability
   * ships, and reaching it requires naming it.
   */
  destructive: boolean;
}

/** Every environment variable this module reads for permissions. */
export const PERMISSION_VARIABLES: readonly string[] = ["JSM_CODE_DESTRUCTIVE"];

function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function resolveCodePermissions(env: NodeJS.ProcessEnv = {}): CodePermissions {
  return { destructive: isTruthy(env.JSM_CODE_DESTRUCTIVE) };
}
