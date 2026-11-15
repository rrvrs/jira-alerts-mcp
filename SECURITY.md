# Security Policy

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report it privately through GitHub's [private vulnerability reporting](https://github.com/rrvrs/jira-alerts-mcp/security/advisories/new) on this repository. Include what you did, what happened, and what you expected — a proof of concept helps, but redact any real credentials or tenant data from it.

Expect an acknowledgement within a week. If a fix is warranted, you'll be credited in the advisory unless you'd rather not be.

## Supported versions

This project is pre-1.0 in practice: fixes land on `main`, and there are no maintained release branches. Track `main`.

## What this server has access to

Worth understanding before you deploy it, because the threat model follows from it.

The server holds **Atlassian credentials** — either an account API token (`JSM_EMAIL` + `JSM_API_TOKEN`) or an OAuth 3LO bearer (`JSM_OAUTH_TOKEN`). An account API token is not scoped to Operations: it carries the full permissions of the Atlassian account that issued it. Treat it as a password.

With `read:ops-alert:jira-service-management` **and** `write:ops-alert:jira-service-management` — Atlassian requires both on every write endpoint — the server can acknowledge, close, annotate and reassign alerts. Those actions are recorded against the credential owner and appear in the alert's audit log.

Schedules and on-call are a third, separate grant: `read:ops-config:jira-service-management`. It reads operations *configuration*, so it is broader than the on-call lookups this server makes.

## Code mode and the approval surface

`JSM_TOOLSETS=code` registers five dispatch tools instead of ninety-odd and
reaches every verified family through them. It does **not** widen what your
credential can do — the dispatchers are built from the selection, never from the
whole catalogue, so they reach exactly the families the operator enabled. What
it changes is **what one approval covers**, and that is worth understanding
before you deploy it.

Thirty-seven of these operations are destructive: every update and every delete.
As individual tools each prompts on its own, with its own name in the client's
dialog. A single write-capable dispatcher would carry one annotation and
therefore one approval, granted once, for a tool whose description says "writes
things". Four things keep that from being a regression:

- **`jsm_call` cannot write.** Every operation reachable through it issues a
  `GET`, enforced in the dispatcher rather than documented as a convention, so
  the tool is honestly read-only and safe to auto-approve.
- **`jsm_apply` takes one operation per call**, as an argument, so the operation
  is named in what the client shows before the user consents. It is annotated
  destructive, so nothing auto-approves it.
- **Destructive operations need `JSM_CODE_DESTRUCTIVE=true`**, an operator
  setting, default off. Deliberately not an annotation and not a model
  argument: some clients auto-approve by tool name and some read no annotations
  at all, so the only place this can be enforced independently of client
  behaviour is in this process.
- **`JSM_READ_ONLY=true` removes `jsm_apply`**, as it removes every other write
  tool. The read dispatchers survive, which is the right split.

If you auto-approve anything, `JSM_TOOLSETS=code,alert-actions` is the shape to
prefer: the dispatchers plus the eighteen classic alert tools, each keeping its
own name and its own prompt.

**Alert content is still untrusted input.** Alert messages, descriptions and
notes are written by whatever integration fired them, and they reach the model's
context. A model acting on instructions found there can call a dispatcher, just
as it could call a tool — which is why `jsm_call` is restricted to reads and why
writes are approved one at a time. Narrowing `JSM_TOOLSETS` narrows what a
dispatcher can reach at all.

### The script sandbox

`jsm_run` executes JavaScript the model wrote, behind two layers that do
different jobs. Neither is relied on alone.

**Layer one: an empty realm.** The script runs in a `vm` context whose only
globals are `jsm` and `console`. Nothing is taken away from it, because nothing
was there:

| Route out | Result |
|---|---|
| `process`, `require`, `module`, `fetch`, timers, `Buffer` | `undefined` — absent from the realm |
| `import("node:process")` | throws — the script is compiled with no dynamic-import callback |
| `eval`, `Function("…")`, `AsyncFunction("…")` | `EvalError` — code generation from strings is off in the realm |
| `jsm.listAlerts.constructor("return process")()` | `EvalError` — and off in the harness's realm too, via `--disallow-code-generation-from-strings` |

That last row is the classic escape from a `vm` context, and the flag exists to
close it. Values handed to a script are parsed inside its realm, so the only
objects it ever holds from outside are the functions it calls.

This layer matters because of one thing the next layer does not cover:
`process.kill` is not gated by Node's permission model. An earlier version of
this harness ran scripts in its own global scope and removed dangerous globals
afterwards; a review found that `import("node:process")` and
`globalThis.require` both still reached the real `process`, from which a script
could signal this server or any other process its user owns. Each row above is
a test.

**Layer two: a process that can do nothing.** The realm lives in a child
`node --permission` process spawned with an empty environment:

| Capability | Result |
|---|---|
| Filesystem | `ERR_ACCESS_DENIED` |
| TCP, UDP, DNS, HTTPS | `ERR_ACCESS_DENIED` |
| Subprocesses, worker threads | `ERR_ACCESS_DENIED` |
| Environment | empty |

Before the first script runs, the server starts a child exactly as a script's
child is started and has it try to read a file, spawn a process, open a socket
and resolve a name. Every attempt must be denied or `jsm_run` refuses to run
anything. A version check trusts a changelog; this trusts the runtime.

**`jsm_run` requires Node 25 or later, and is not registered below it.** Node's
permission model denies network access only from v25.0.0. On Node 24 — which
this package otherwise supports — `--permission` restricts files and
subprocesses and leaves sockets open, so a script could send out whatever it had
read. `jsm_list_capabilities` reports the reason. This was found in review, not
in testing: the sandbox had been verified on Node 26 only, and no test attempted
a connection.

The Atlassian credential is not hidden from the script, it is **not there** —
it lives in this process's environment and the child is given none of it. Every
API call a script makes is a newline-framed message to this process, which holds
the credential and issues the request. The script is written to the child's stdin
rather than passed in argv, because argv is readable by anything that can list
processes and a script may legitimately carry alert text or an account id. Each
script gets its own process, killed when it finishes, so nothing carries between
runs and there is nowhere to persist to.

**A script can only read.** Every operation reachable from inside the sandbox has
`readOnlyHint` and issues a `GET`, enforced by the dispatcher — the context a
script runs under carries no write allowlist, so a write is refused before a
request is made. This is the mitigation that matters for prompt injection: alert
messages, descriptions and notes are written by whatever integration fired them
and they reach the model's context, so a model acting on instructions found there
can write a script. A script that cannot write cannot be made to delete a
schedule. The residual exposure is *reading* more than you intended, and
narrowing `JSM_TOOLSETS` narrows what a script can reach at all.

**Bounded.** Wall clock, HTTP requests, records, pages, outbound concurrency,
heap (64MB via `--max-old-space-size`), script length, log lines, bytes written
back, and the number of sandbox processes running at once — all capped, all
enforced in this process, with hard limits configuration cannot raise. A runaway
script is SIGKILLed; measured, that takes about 200ms.

**The caveats, stated plainly.** Node documents `vm` as not being a security
mechanism, and the permission model's network gating is recent — added in v25
and still marked as under active development. That is why there are two layers
and a self-test rather than one mechanism trusted on its word. The plan for this
work preferred QuickJS compiled to WebAssembly, which has no filesystem or
network to deny, and its spike failed: a module's top-level `await` left a
pending job that only a synchronous `executePendingJobs` could drive, so every
statement after the first `await` on a host function was dropped, and disposing
the runtime aborted the WASM module with a GC assertion. The write-up is in
`src/tools/code/engine.ts`. The engine sits behind one interface; replacing it
touches two files.

Note also that this server now imports `node:child_process`, which it previously
did not — see the note under *Security alerts on the npm page*. It spawns only
its own Node binary, with a fixed argument list and no shell.

**Every invocation is audited.** Code mode writes one structured line per call
to stderr: the operations called, the request and record counts, the duration,
and any writes that completed. A dispatched write does not carry its operation
in the tool name, so without this the client transcript stops answering "what
did this server do with my credential". Arguments and response bodies are not
logged at `info` — alert content may contain anything, and a log file is a place
people forget to treat as sensitive. `JSM_LOG_LEVEL=debug` widens it knowingly.

**Budgets are enforced here, not by the client.** A classic tool call is one HTTP
request. A dispatched call can page, so the server caps requests, records, pages,
outbound concurrency and wall-clock time per call, with hard limits that
configuration cannot raise. A value outside the permitted range stops the server
at startup rather than being silently clamped.

## Hardening notes

- **Give it its own account.** Prefer a dedicated service account with the minimum Operations access needed, over a human's personal token.
- **Read-only is a supported configuration.** Grant only `read:ops-alert:jira-service-management` and the four write tools will fail with a 403 that says exactly which scope is missing. If the agent doesn't need to change alert state, don't give it the scope.
- **Alert-only is also supported.** Withhold `read:ops-config:jira-service-management` and the nine alert tools work while the three on-call tools return 401. `ops-config` reads operations configuration generally, so if the agent has no need to know who is on call, leaving it out is the narrower grant.
- **The HTTP transport performs no authentication of its own.** Anyone who can reach the port can drive every tool with your credentials. For normal use with an MCP client, prefer the default stdio transport.
- **Loopback binding is not, on its own, a security boundary.** Binding to `127.0.0.1` stops other machines reaching the port, but it does not stop a web page in your own browser from POSTing to it — that is what DNS rebinding is. The server therefore validates the `Host` header on every request (via the SDK's `createMcpExpressApp`), which is the control that actually blocks the attack. If you bind beyond loopback with `HOST`, you **must** also set `ALLOWED_HOSTS` to the hostnames you expect, or that protection is not applied:

  ```bash
  HOST=0.0.0.0 ALLOWED_HOSTS=mcp.internal.example.com node dist/index.js
  ```

  Binding wide is still not sufficient on its own — put an authenticating reverse proxy in front of it.
- **Credentials come from the environment, never from a file the server reads.** There is no `dotenv` dependency and `.env` is gitignored. `.env.example` contains placeholders only.
- **A client config holding the token is still a credential at rest.** The distinction above is about the *server*: it reads only its environment. But a GUI client has no shell environment to inherit, so `claude_desktop_config.json` and the equivalents hold the token in plaintext, readable by anything running as that user. That file deserves the same care as any other secret on disk, and it is a further reason to give the server its own service account rather than a human's personal token.
- **Alert content is untrusted input.** Alert messages, descriptions and notes are written by whatever integration fired them and are rendered into the model's context. Text inside an alert is data, not instructions — an agent acting on alerts should treat it that way.

## Security alerts on the npm page

The package page on npmjs.com renders a supply-chain analysis from Socket. It scans the whole installed dependency tree, not just the files this package publishes, and attributes what it finds to the page of every dependent. Four alerts currently show there. All four come from dependencies; none describe code in this package. They are worth understanding rather than dismissing, so:

- **"Dynamic code execution (eval)"** — this is [`ajv`](https://www.npmjs.com/package/ajv), reached through `@modelcontextprotocol/sdk`. A JSON Schema validator turns schemas into validator functions with `new Function`; that is how the library works, and it is what validates MCP messages. There is no `eval`, `new Function` or `vm` usage anywhere in `src/`.
- **"Accesses the system shell"** — two things now sit behind this one alert, and they deserve separating. [`cross-spawn`](https://www.npmjs.com/package/cross-spawn), via the SDK, needs `child_process` because the SDK ships a stdio *client* transport that launches MCP servers as subprocesses; this package is a server and never calls it. **And `src/tools/code/child-engine.ts` imports `node:child_process` deliberately**, to run `jsm_run`'s sandbox. That used to be something this file could say nothing in `src/` did, and it is no longer true, so: it spawns `process.execPath` — this server's own Node binary — with a fixed argument list, `shell: false` (the default), and an environment containing one variable. It never interpolates user or model input into a command, and the only thing it ever runs is Node with the harness in `src/tools/code/runner.ts`. The spawn is the mechanism by which model-written code is kept *away* from this process, not a way for it to reach out.
- **A finding describing a shopping cart, unescaped HTML and `origin: '*'` CORS** — this is the SDK's `dist/examples/server/elicitationUrlExample.js`, a demo that ships inside its tarball because the SDK's `files` is `["dist"]` and `dist/examples/` sits within it. Nothing in `src/` imports from `examples/`, so it is dead code in your install. This server has no cart, no sessions, no elicitation, and emits no HTML at all — every response is JSON.
- **"Can be replaced with a Socket optimized override"** — a vendor suggestion, not a finding about this package.

What this package itself does, for comparison: `files` is `["dist"]`, so tests, sources and `scripts/` are not published. It installs no CORS middleware. The HTTP transport binds `127.0.0.1` by default and validates the `Host` header, as described above. Credentials are read from the environment and never serialised into an error or a log line — the error handler reads only the HTTP status, the API's `message` field and the network error code, never the request config that carries the `Authorization` header.

None of this makes the alerts wrong to investigate. It means the answer is upstream: excluding `examples` from the SDK's published files would clear the third one for every dependent at once.

## What runs on this repository

Three checks, with different reach — none of them a guarantee about any particular moment:

- [CodeQL](.github/workflows/codeql.yml) analyses this repository's TypeScript on every push, every pull request, and weekly. It does not analyse dependencies.
- [Dependency review](.github/workflows/dependency-review.yml) fails a pull request that *introduces* a dependency carrying a known high-severity advisory. It sees only what a pull request changes, so it never re-examines the existing tree.
- [Dependency audit](.github/workflows/audit.yml) runs `npm audit --audit-level=high` against the whole installed tree on every pull request and weekly, and files an issue when a scheduled run fails. This is the one that catches an advisory published against a dependency already in the lockfile.

The last two are deliberately **not** required status checks. A supply-chain finding should be visible on the pull request, not a gate that blocks unrelated work until someone waives it.

## Out of scope

- Vulnerabilities in the Atlassian JSM Operations API itself — report those to [Atlassian](https://www.atlassian.com/trust/security/report-vulnerability).
- Findings that require an attacker to already hold your `JSM_API_TOKEN`.
- Anything that requires local access to a machine already running the server with credentials in its environment.
