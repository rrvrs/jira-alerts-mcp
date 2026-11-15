/**
 * What the sandbox does and does not let a script do.
 *
 * These are the assertions SECURITY.md's claims rest on, so they run against
 * the real engine — real child processes, really started with `--permission`.
 * Mocking the boundary would test the mock. Each spawn costs about 30ms.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { CODE_MAX_SCRIPT_CHARS } from "../../constants.js";
import { createChildEngine, sandboxSupport, verifyBoundary } from "./child-engine.js";
import { BudgetError, createCallContext, DispatchError, OperationError } from "./context.js";
import type { ScriptCall } from "./engine.js";
import { resolveLimits } from "./limits.js";

/**
 * The sandbox needs a Node whose permission model gates the network. CI runs
 * Node 24 as well as 26, and there these tests would be asserting properties of
 * a boundary the engine itself refuses to use.
 */
const UNSUPPORTED = sandboxSupport().supported
  ? false
  : "needs Node 25+: the permission model does not gate the network before that";

const engine = createChildEngine({ maxConcurrent: 4 });

const rows = (count: number, op: string) =>
  Array.from({ length: count }, (_, index) => ({ id: index, op, flagged: index % 100 === 0 }));

/** A host that answers everything, so these tests are about the sandbox only. */
const answers: ScriptCall = async (operation, _args, allPages) => ({
  items: rows(allPages ? 1_000 : 25, operation),
  ...(allPages ? { pages: 10, complete: true } : {}),
});

async function run(
  script: string,
  options: { call?: ScriptCall; limits?: Partial<ReturnType<typeof resolveLimits>> } = {},
) {
  const ctx = createCallContext({ limits: { ...resolveLimits(), ...options.limits } });
  try {
    return await engine.run({ script, ctx, call: options.call ?? answers });
  } finally {
    ctx.deadline.dispose();
  }
}

describe("what a script can reach", { skip: UNSUPPORTED }, () => {
  it("has no process, require, fetch or timers in its realm at all", async () => {
    // Absent, not removed. An earlier harness ran the script in its own global
    // scope and deleted things afterwards, which is a list that is never
    // finished; the script now gets a realm that never had them.
    const outcome = await run(`
      const names = ['process', 'require', 'module', 'fetch', 'WebSocket', 'setTimeout', 'setInterval', 'Buffer', 'crypto'];
      console.log(names.map(n => n + '=' + typeof globalThis[n]).join(' '));
      console.log('globals: ' + Object.getOwnPropertyNames(globalThis).filter(n => n === 'jsm' || n === 'console').join(','));
    `);
    assert.equal(outcome.error, undefined);
    assert.equal(
      outcome.logs[0],
      "process=undefined require=undefined module=undefined fetch=undefined WebSocket=undefined setTimeout=undefined setInterval=undefined Buffer=undefined crypto=undefined",
    );
    assert.equal(outcome.logs[1], "globals: console,jsm");
  });

  // Each of these reached the real process object before the script was moved
  // into its own context, and the real process is dangerous: process.kill is
  // not gated by the permission model, so a script could signal this server or
  // any other process its user owns.
  const escapes: Array<[string, string]> = [
    ["dynamic import", `await import('node:process');`],
    ["dynamic import of a relative path", `await import('./anything.js');`],
    [
      "the Function constructor, through an operation",
      `jsm.listAlerts.constructor('return process')();`,
    ],
    ["the Function constructor, through console", `console.log.constructor('return process')();`],
    [
      "the AsyncFunction constructor",
      `const AF = Object.getPrototypeOf(async () => {}).constructor; await AF('return 1')();`,
    ],
    ["eval", `eval('1 + 1');`],
    ["indirect eval", `(0, eval)('1 + 1');`],
    ["the Function constructor in its own realm", `Function('return 1')();`],
    [
      "a constructor reached through a returned promise",
      `const p = jsm.listAlerts({}); p.constructor.constructor('return process')();`,
    ],
  ];

  for (const [label, script] of escapes) {
    it(`cannot get out through ${label}`, async () => {
      const outcome = await run(`${script}\nconsole.log('ESCAPED');`);
      assert.ok(!outcome.logs.includes("ESCAPED"), `${label} was not blocked`);
      assert.equal(outcome.error?.kind, "script");
    });
  }

  it("is handed data that belongs to its own realm", async () => {
    // Parsed inside the context, so nothing from the harness's realm is passed
    // over as data — and so instanceof behaves the way a script author expects.
    const outcome = await run(
      `
      const page = await jsm.listAlerts({});
      console.log('array=' + (page.items instanceof Array) + ' object=' + (page instanceof Object));
      try { await jsm.boom({}); } catch (e) { console.log('error=' + (e instanceof Error) + ' status=' + e.status); }
    `,
      {
        call: async (operation, args, allPages) => {
          if (operation === "boom") throw new OperationError(operation, "nope", 404, false);
          return answers(operation, args, allPages);
        },
      },
    );
    assert.deepEqual(outcome.logs, ["array=true object=true", "error=true status=404"]);
  });

  it("can await or return jsm itself without it posing as a promise", async () => {
    // A Proxy that answers every property answers 'then', and anything with a
    // 'then' is treated as a thenable — so 'await jsm' called an operation
    // named 'then' and never settled.
    const outcome = await run(
      `const same = await jsm; console.log('settled ' + (typeof same.listAlerts));`,
    );
    assert.deepEqual(outcome.logs, ["settled function"]);
  });
});

describe("the boundary itself", () => {
  it("refuses Node 24, whose permission model does not gate the network", () => {
    // --allow-net arrived in v25.0.0. On 24, --permission restricts files and
    // subprocesses and leaves sockets open, so a script could send out whatever
    // it had read. package.json permits 24, so this has to be checked at runtime.
    assert.equal(sandboxSupport("24.11.0").supported, false);
    assert.match(sandboxSupport("24.11.0").reason ?? "", /Node 25 or later/);
    assert.equal(sandboxSupport("22.3.0").supported, false);
    assert.equal(sandboxSupport("25.0.0").supported, true);
    assert.equal(sandboxSupport("26.5.0").supported, true);
  });

  it("refuses a version it cannot read rather than assuming", () => {
    assert.equal(sandboxSupport("").supported, false);
    assert.equal(sandboxSupport("nightly").supported, false);
  });

  it("holds on this runtime: files, subprocesses, sockets and DNS are all denied", {
    skip: UNSUPPORTED,
  }, async () => {
    // The version check trusts a changelog. This starts a child exactly as a
    // script's child is started and has it try each thing for real.
    assert.deepEqual(await verifyBoundary(), { supported: true });
  });

  it("reports an engine error, not a script error, when the boundary does not hold", async () => {
    // A runtime that cannot be trusted must not run the script at all — and the
    // model must not be told to fix a script that was never run.
    const broken = createChildEngine({ execPath: "/nonexistent/node" });
    const ctx = createCallContext({ limits: resolveLimits() });
    try {
      const outcome = await broken.run({ script: `console.log('ran');`, ctx, call: answers });
      if (sandboxSupport().supported) {
        assert.equal(outcome.error?.kind, "engine");
        assert.deepEqual(outcome.logs, []);
      } else {
        assert.equal(outcome.error?.kind, "engine");
      }
    } finally {
      ctx.deadline.dispose();
    }
  });
});

describe("what a script can do", { skip: UNSUPPORTED }, () => {
  it("runs statements after an await, which is the whole point", async () => {
    // The failure that ruled out the QuickJS engine: a module's top-level await
    // left a pending job nothing could drive, so everything after the first
    // await on a host function was silently dropped.
    const outcome = await run(`
      const first = await jsm.listAlerts({});
      console.log('first=' + first.items.length);
      const second = await jsm.getAlert({ identifier: 'x' });
      console.log('second=' + second.items[0].op);
    `);
    assert.equal(outcome.error, undefined);
    assert.deepEqual(outcome.logs, ["first=25", "second=getAlert"]);
  });

  it("reads many records and returns only what it logs", async () => {
    // The benefit the whole design exists for: a thousand rows are scanned in
    // the sandbox and one sentence reaches the model.
    const outcome = await run(`
      const all = await jsm.listAllAlerts({}, { max: 1000 });
      const flagged = all.items.filter(r => r.flagged);
      console.log('scanned ' + all.items.length + ', kept ' + flagged.length);
    `);
    assert.deepEqual(outcome.logs, ["scanned 1000, kept 10"]);
    assert.ok(JSON.stringify(outcome).length < 500, "the rows must not come back");
  });

  it("fans out concurrently", async () => {
    const outcome = await run(`
      const pages = await Promise.all(['a','b','c','d','e','f'].map(n => jsm.listAlerts({ query: n })));
      console.log('fanned=' + pages.length);
    `);
    assert.deepEqual(outcome.logs, ["fanned=6"]);
  });

  it("sees an API failure as a throwable carrying status and operation", async () => {
    const call: ScriptCall = async (operation) => {
      throw new OperationError(operation, "Error (getAlert): no alert with that id", 404, false);
    };
    const outcome = await run(
      `
      try { await jsm.getAlert({ identifier: 'nope' }); console.log('not reached'); }
      catch (e) { console.log('status=' + e.status + ' op=' + e.operation + ' retryable=' + e.retryable); }
    `,
      { call },
    );
    assert.equal(outcome.error, undefined);
    assert.equal(outcome.logs[0], "status=404 op=getAlert retryable=false");
  });

  it("cuts a single enormous log line rather than returning megabytes", async () => {
    // withCharacterLimit can drop lines but cannot shorten one, so a script
    // that logged JSON.stringify of a whole sweep returned 1.9 MB to the model.
    const outcome = await run(`
      const all = await jsm.listAllAlerts({}, { max: 1000 });
      console.log(JSON.stringify(all.items) + JSON.stringify(all.items));
    `);
    assert.equal(outcome.logs.length, 1);
    assert.ok((outcome.logs[0]?.length ?? 0) < 21_000, `line was ${outcome.logs[0]?.length} chars`);
    assert.match(outcome.logs[0] ?? "", /line cut at 20000 of \d+ characters/);
    assert.equal(outcome.truncated, true);
  });

  it("keeps nothing between runs", async () => {
    // Each script gets its own process. A pool would let one script leave the
    // next a dirty runtime, which is exactly how an out-of-memory condition
    // poisoned every later run under the engine this replaced.
    await run(`globalThis.__leak = 'first script was here';`);
    const outcome = await run(`console.log('leak=' + typeof globalThis.__leak);`);
    assert.equal(outcome.logs[0], "leak=undefined");
  });
});

describe("how a script fails", { skip: UNSUPPORTED }, () => {
  it("reports a parse failure as a syntax error", async () => {
    const outcome = await run(`const x = ;`);
    assert.equal(outcome.error?.kind, "syntax");
  });

  it("reports an uncaught throw as a script error, keeping what it logged", async () => {
    const outcome = await run(`console.log('got this far'); throw new Error('my bug');`);
    assert.equal(outcome.error?.kind, "script");
    assert.match(outcome.error?.message ?? "", /my bug/);
    assert.deepEqual(outcome.logs, ["got this far"], "work before the failure must survive");
  });

  it("reports a refused operation as a dispatch error, not as the script's fault", async () => {
    // The script is correct; the server refused. Telling a model to fix a
    // correct script is how it rewrites the same thing three times.
    const call: ScriptCall = async () => {
      throw new DispatchError("'acknowledgeAlert' writes, and this call may only read.");
    };
    const outcome = await run(`await jsm.acknowledgeAlert({ alert_id: 'a' });`, { call });
    assert.equal(outcome.error?.kind, "dispatch");
    assert.match(outcome.error?.message ?? "", /may only read/);
  });

  it("reports a spent budget as a budget error even when the script let it propagate", async () => {
    const call: ScriptCall = async () => {
      throw new BudgetError("maxRequests", 60, "This call has already made 60 HTTP requests");
    };
    const outcome = await run(`await jsm.listAlerts({});`, { call });
    assert.equal(outcome.error?.kind, "budget");
    assert.match(outcome.error?.message ?? "", /60 HTTP requests/);
  });

  it("stops a runaway script at the deadline and says which budget it was", async () => {
    const started = Date.now();
    const outcome = await run(`while (true) {}`, { limits: { timeoutMs: 400 } });
    assert.equal(outcome.error?.kind, "budget");
    assert.match(outcome.error?.message ?? "", /deadline/);
    assert.ok(Date.now() - started < 4_000, "the kill must not wait for the script");
  });

  it("refuses an over-long script before spawning anything", async () => {
    await assert.rejects(
      () => run("x".repeat(CODE_MAX_SCRIPT_CHARS + 1)),
      (error: unknown) => {
        assert.ok(error instanceof DispatchError);
        assert.match(error.message, /past the/);
        return true;
      },
    );
  });
});

describe("concurrency", { skip: UNSUPPORTED }, () => {
  it("refuses a script when the sandbox is already full, retryably", async () => {
    // A call that queues indefinitely looks to a client exactly like a server
    // that has hung, and a model handles "busy, retry" far better.
    const small = createChildEngine({ maxConcurrent: 1 });
    const ctx = createCallContext({ limits: resolveLimits() });
    try {
      const slow = small.run({
        script: `await new Promise(r => { const t = Date.now(); while (Date.now() - t < 300) {} r(); });`,
        ctx,
        call: answers,
      });
      // Give the first one time to take the only slot.
      await new Promise((resolve) => setTimeout(resolve, 80));

      const second = createCallContext({ limits: resolveLimits() });
      try {
        await assert.rejects(
          () => small.run({ script: `console.log('hi');`, ctx: second, call: answers }),
          (error: unknown) => {
            assert.ok(error instanceof DispatchError);
            assert.match(error.message, /already running/);
            return true;
          },
        );
      } finally {
        second.deadline.dispose();
      }
      await slow;
    } finally {
      ctx.deadline.dispose();
      await small.dispose();
    }
  });
});
