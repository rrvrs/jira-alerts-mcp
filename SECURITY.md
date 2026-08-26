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
- **"Accesses the system shell"** — this is [`cross-spawn`](https://www.npmjs.com/package/cross-spawn), also via the SDK, which needs `child_process` because the SDK ships a stdio *client* transport that launches MCP servers as subprocesses. This package is a server and never calls it. Nothing in `src/` imports `child_process`.
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
