/**
 * The harness that runs inside the sandbox child.
 *
 * Embedded as a string rather than kept as its own `.mjs` file because `tsc`
 * copies no non-TypeScript files into `dist`, and a runtime that cannot find
 * its own harness after `npm install` is a packaging bug waiting to happen.
 * It is passed to `node -e`, so it must be plain JavaScript — and it must not
 * contain a backtick, which would end the template literal it lives in.
 *
 * THE SCRIPT DOES NOT RUN IN THIS REALM. An earlier version ran it with
 * `new AsyncFunction(code)` in the harness's own global scope and tried to take
 * dangerous things away afterwards — shadowing `require`, deleting `fetch`,
 * replacing `globalThis.process` with a stub. A review found three ways round
 * that, all confirmed by running them:
 *
 *   (await import("node:process")).default      dynamic import ignores shadowing
 *   globalThis.require("node:process")          `node -e` puts require on globalThis
 *   Function('return import("node:process")')() and so does generated code
 *
 * and the real `process` matters, because `process.kill` is not gated by the
 * permission model: `process.kill(process.ppid, 0)` returned true. A script
 * could SIGKILL this server, or any other process its user owns.
 *
 * Taking things away from a realm that has everything is a list that is never
 * finished. So the script now gets a realm that has nothing:
 *
 *   - a fresh `vm` context whose only globals are `jsm` and `console`, so there
 *     is no `process`, `require`, `fetch` or timer to remove;
 *   - compiled with no dynamic-import callback, so `import()` throws;
 *   - code generation from strings disabled in the context AND, by a flag on
 *     the child, in this realm — which is what closes the classic way out of a
 *     vm context, `someHostFunction.constructor("return process")()`;
 *   - values handed to the script are parsed inside the context, so the only
 *     host-realm objects it ever holds are the functions it calls.
 *
 * Node documents `vm` as not being a security mechanism on its own, and this
 * does not lean on it alone: `--permission` is still the boundary for the
 * filesystem, the network and subprocesses. The context is what keeps a script
 * away from the one dangerous thing the permission model leaves reachable.
 *
 * The script arrives over stdin, not in argv. Argv is visible to anything that
 * can list processes on the machine, and a script may legitimately contain
 * alert text, an account id or a query someone would not want there.
 */

export const RUNNER_SOURCE = String.raw`
"use strict";
const vm = require("node:vm");

// Captured once, at load. Nothing the script can reach leads back to these.
const OUT = process.stdout;
const EXIT = process.exit.bind(process);
const send = (message) => OUT.write(JSON.stringify(message) + "\n");

const MAX_LOG_LINES = Number(process.env.JSM_RUNNER_MAX_LOGS || 1000);
const MAX_LINE_CHARS = Number(process.env.JSM_RUNNER_MAX_LINE || 20000);
let logLines = 0;
let logTruncated = false;

const render = (value) => {
  if (typeof value === "string") return value;
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
};

const log = (...args) => {
  if (logLines >= MAX_LOG_LINES) {
    logTruncated = true;
    return;
  }
  logLines += 1;
  let text = args.map(render).join(" ");
  // One line cannot be allowed to be the whole budget: a script that logs
  // JSON.stringify of five thousand records would otherwise hand the model
  // megabytes, which is the thing running a script was meant to avoid.
  if (text.length > MAX_LINE_CHARS) {
    text = text.slice(0, MAX_LINE_CHARS) + " ... [line cut at " + MAX_LINE_CHARS + " of " + text.length + " characters - log a summary, not whole records]";
    logTruncated = true;
  }
  send({ t: "log", text });
};

let nextId = 1;
const pending = new Map();

const callHost = (operation, args, allPages, max) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ t: "call", id, operation, args: args === undefined ? {} : args, allPages: Boolean(allPages), max });
  });

/**
 * Every operation, without the child needing to know their names.
 *
 * A Proxy means the parent stays the single source of truth about what exists
 * and what is permitted — the child cannot be out of date about the catalogue,
 * and it cannot be tricked into believing an operation exists that the parent
 * will not dispatch.
 *
 * jsm.listAlerts(args)            -> one page
 * jsm.listAllAlerts(args, {max})  -> every page, bounded by the parent
 */
const jsm = new Proxy(Object.create(null), {
  get(_target, property) {
    // "then" must be absent, or "await jsm" and "return jsm" treat the proxy as
    // a thenable and call it as one. Symbols are never operations.
    if (typeof property !== "string" || property === "then") return undefined;
    const all = property.startsWith("listAll") && property.length > "listAll".length;
    const operation = all ? "list" + property.slice("listAll".length) : property;
    return (args, options) => callHost(operation, args, all, options ? options.max : undefined);
  },
});

// The script's whole world. A null prototype so not even Object.prototype of
// this realm is reachable through it.
const sandbox = Object.create(null);
sandbox.jsm = jsm;
sandbox.console = Object.freeze({ log, error: log, warn: log, info: log, debug: log });
const context = vm.createContext(sandbox, {
  name: "jsm-script",
  codeGeneration: { strings: false, wasm: false },
});

// Built inside the context, so what they return belongs to the script's realm:
// arrays are its Array, errors are its Error, and no object from this realm is
// handed over as data.
const parseInContext = vm.runInContext("(text) => JSON.parse(text)", context);
const errorInContext = vm.runInContext(
  "(message, fields) => Object.assign(new Error(message), fields)",
  context,
);

process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const index = buffer.indexOf("\n");
    if (index < 0) break;
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }

    const waiting = pending.get(message.id);
    if (message.t === "script") {
      void start(message.code);
    } else if (message.t === "ok" && waiting) {
      pending.delete(message.id);
      waiting.resolve(parseInContext(JSON.stringify(message.value === undefined ? null : message.value)));
    } else if (message.t === "err" && waiting) {
      pending.delete(message.id);
      // Carried through so a script can branch on a status rather than parse
      // prose: catch (e) { if (e.status === 404) ... }
      waiting.reject(
        errorInContext(String(message.message), {
          name: message.name || "OperationError",
          operation: message.operation,
          status: message.status,
          retryable: Boolean(message.retryable),
        }),
      );
    }
  }
});

const describe = (error) => ({
  name: error && error.name ? String(error.name) : "Error",
  message: error && error.message ? String(error.message) : String(error),
});

function finish(message) {
  send(message);
  // Flush before exiting, or the last message can be lost on a pipe.
  if (OUT.writableLength === 0) EXIT(0);
  OUT.once("drain", () => EXIT(0));
}

async function start(code) {
  let script;
  try {
    // An async wrapper gives the script top-level await. It starts on the same
    // line as the script, so a reported line number is the author's own.
    // No importModuleDynamically: import() throws rather than loading anything.
    script = new vm.Script("(async () => {" + code + "\n})()", { filename: "script.js" });
  } catch (error) {
    // It did not parse. Reported apart from a thrown error because the fix is
    // different: rewrite the syntax, not the logic.
    finish({ t: "fail", kind: "syntax", ...describe(error), logTruncated });
    return;
  }

  try {
    await script.runInContext(context);
    finish({ t: "done", logTruncated });
  } catch (error) {
    finish({ t: "fail", kind: "script", ...describe(error), logTruncated });
  }
}

const crashed = (error) => finish({ t: "fail", kind: "script", ...describe(error), logTruncated });
process.on("uncaughtException", crashed);
// A promise the script never awaited and that rejected. Reported, because a
// silent exit would read as a script that ran and logged nothing.
process.on("unhandledRejection", crashed);
`;

/**
 * Asks a child, started exactly as a script's child is, whether the boundary
 * actually holds on this runtime.
 *
 * It exists because the boundary was once assumed from one machine. The
 * permission model gates the network only from Node 25: on Node 24 — which
 * this package's `engines` field permits — `--permission` leaves sockets wide
 * open, and nothing but a real attempt would have said so. Every probe here
 * must come back ERR_ACCESS_DENIED; anything else and the sandbox refuses to
 * run scripts at all.
 */
export const SELFTEST_SOURCE = String.raw`
"use strict";
const report = {};
const code = (error) => (error && (error.code || error.name)) || "UNKNOWN";

try {
  require("node:fs").readFileSync(process.execPath);
  report.fs = "ALLOWED";
} catch (error) {
  report.fs = code(error);
}

try {
  require("node:child_process").spawnSync(process.execPath, ["-v"]);
  report.spawn = "ALLOWED";
} catch (error) {
  report.spawn = code(error);
}

const tcp = new Promise((resolve) => {
  try {
    // A literal address, so this tests the socket and not just the resolver.
    const socket = require("node:net").connect(9, "127.0.0.1");
    socket.on("connect", () => { socket.destroy(); resolve("ALLOWED"); });
    // Refused means the attempt reached the network stack: that is allowed.
    socket.on("error", (error) => resolve(code(error) === "ERR_ACCESS_DENIED" ? "ERR_ACCESS_DENIED" : "ALLOWED"));
  } catch (error) {
    resolve(code(error));
  }
});

const dns = require("node:dns").promises.lookup("localhost").then(
  () => "ALLOWED",
  (error) => code(error),
);

const timeout = new Promise((resolve) => setTimeout(() => resolve("TIMEOUT"), 2000));

Promise.all([Promise.race([tcp, timeout]), Promise.race([dns, timeout])]).then(([tcpResult, dnsResult]) => {
  report.tcp = tcpResult;
  report.dns = dnsResult;
  process.stdout.write(JSON.stringify(report) + "\n", () => process.exit(0));
});
`;
