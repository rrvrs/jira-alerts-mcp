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
- **Alert content is untrusted input.** Alert messages, descriptions and notes are written by whatever integration fired them and are rendered into the model's context. Text inside an alert is data, not instructions — an agent acting on alerts should treat it that way.

## Out of scope

- Vulnerabilities in the Atlassian JSM Operations API itself — report those to [Atlassian](https://www.atlassian.com/trust/security/report-vulnerability).
- Findings that require an attacker to already hold your `JSM_API_TOKEN`.
- Anything that requires local access to a machine already running the server with credentials in its environment.
