/**
 * Structured logging, to stderr, one JSON object per line.
 *
 * Two constraints shape this file, and both are absolute.
 *
 * **stdout is the protocol channel.** index.ts already says so where it logs
 * the startup banner. A stray console.log anywhere in a request path writes
 * non-JSON-RPC bytes into the stream a client is parsing, and the client's
 * failure mode is "the server is broken" with nothing pointing at the cause.
 * Everything here writes to stderr and nothing in this module can be configured
 * to do otherwise.
 *
 * **Code mode needs an audit record.** A classic tool call is one request and
 * the client's own transcript is the record of it. A dispatched call can issue
 * sixty, and a script can call operations nobody wrote down, so "what did this
 * server actually do with my credential" stops being answerable from the
 * transcript alone. One `info` line per invocation — operations, counts,
 * duration, and a hash of the script — is what makes it answerable again.
 *
 * What is deliberately NOT logged at `info`: script source, request bodies and
 * response bodies. Alert messages, descriptions and notes are written by
 * whatever integration fired them, so they are untrusted input that may contain
 * anything, and a log file is a place people forget to treat as sensitive.
 * Script source is available at `debug`, which an operator turns on knowingly.
 */

/** Ordered least to most verbose; a level enables itself and everything above it. */
export const LOG_LEVELS = ["error", "warn", "info", "debug"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export const DEFAULT_LOG_LEVEL: LogLevel = "info";

/**
 * A single long field is almost always a mistake — a whole response body, or a
 * script — and it is the thing that turns a log into an exfiltration channel.
 * Truncated rather than dropped, so the line still says something happened.
 */
const MAX_FIELD_CHARS = 2_000;

/**
 * Credential shapes, scrubbed on the way out.
 *
 * This is defence in depth, not the guarantee. The guarantee is that nothing
 * passes a credential to this module, and a test asserts it by running the
 * dispatcher with a recognisable token and grepping every emitted line. This
 * regex is here for the case the guarantee is broken by a future change: a
 * redacted token in a log file is recoverable, a leaked one is not.
 */
const CREDENTIAL = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

export type LogFields = Record<string, unknown>;

export interface Logger {
  error(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  debug(event: string, fields?: LogFields): void;
  /** Whether a level would be emitted, so a caller can skip building the fields. */
  enabled(level: LogLevel): boolean;
}

export interface LoggerOptions {
  level?: LogLevel;
  /**
   * Where a finished line goes. Defaults to stderr.
   *
   * Injectable for tests only — there is no environment variable for it, so no
   * configuration can redirect these lines to stdout.
   */
  write?: (line: string) => void;
  /** Clock, for tests that assert on the timestamp. */
  now?: () => Date;
}

/** Parses JSM_LOG_LEVEL, falling back rather than failing: a typo should not stop the server. */
export function parseLogLevel(raw: string | undefined): LogLevel {
  const value = raw?.trim().toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(value ?? "")
    ? (value as LogLevel)
    : DEFAULT_LOG_LEVEL;
}

function scrub(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === "string") {
    const text = value.replace(CREDENTIAL, "$1 [REDACTED]");
    return text.length > MAX_FIELD_CHARS
      ? `${text.slice(0, MAX_FIELD_CHARS)}… [${text.length} chars]`
      : text;
  }
  if (value instanceof Error) {
    return { name: value.name, message: scrub(value.message, seen) };
  }
  if (value && typeof value === "object") {
    // Cycle detection is not defensive politeness — without it this function
    // recurses until the stack overflows, and it does so *before* the
    // JSON.stringify below could catch anything, so the whole log line is lost
    // to a RangeError thrown from inside a logger. A field that points at
    // itself should cost that field, not the line.
    if (seen.has(value)) return "[Circular]";
    seen.add(value);

    if (Array.isArray(value)) {
      return value.map((entry) => scrub(entry, seen));
    }
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = scrub(entry, seen);
    }
    return out;
  }
  return value;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const threshold = LOG_LEVELS.indexOf(options.level ?? DEFAULT_LOG_LEVEL);
  // Bound once rather than read per call: console.error is the only stderr
  // writer here, and capturing it means a later reassignment of console cannot
  // redirect these lines somewhere else.
  const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const now = options.now ?? (() => new Date());

  const emit = (level: LogLevel, event: string, fields?: LogFields): void => {
    if (LOG_LEVELS.indexOf(level) > threshold) return;

    try {
      const line = {
        ts: now().toISOString(),
        level,
        event,
        ...(scrub(fields ?? {}) as LogFields),
      };
      write(JSON.stringify(line));
    } catch {
      // Cycles are handled in scrub; this is the remaining tail — a BigInt, a
      // getter that throws — and it must not take down the request it was
      // describing. Saying a line was degraded beats an unhandled rejection
      // surfacing from inside a transport.
      write(
        JSON.stringify({
          ts: now().toISOString(),
          level,
          event,
          logError: "unserialisable fields",
        }),
      );
    }
  };

  return {
    error: (event, fields) => emit("error", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    info: (event, fields) => emit("info", event, fields),
    debug: (event, fields) => emit("debug", event, fields),
    enabled: (level) => LOG_LEVELS.indexOf(level) <= threshold,
  };
}

/**
 * The process-wide logger, configured from the environment at import time.
 *
 * Read once rather than per call for the same reason resolveSelection is read
 * once at startup: a value that can change between two lines of the same
 * invocation is a value nobody can reason about.
 */
export const log: Logger = createLogger({ level: parseLogLevel(process.env.JSM_LOG_LEVEL) });
