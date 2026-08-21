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

With `write:ops-alert:jira-service-management`, the server can acknowledge, close, annotate and reassign alerts. Those actions are recorded against the credential owner and appear in the alert's audit log.

## Hardening notes

- **Give it its own account.** Prefer a dedicated service account with the minimum Operations access needed, over a human's personal token.
- **Read-only is a supported configuration.** Grant only `read:ops-alert:jira-service-management` and the four write tools will fail with a 403 that says exactly which scope is missing. If the agent doesn't need to change alert state, don't give it the scope.
- **The HTTP transport binds to loopback by default** (`127.0.0.1:3000`) precisely because this process holds credentials. It performs **no authentication of its own** — anyone who can reach the port can drive every tool with your credentials. Setting `HOST=0.0.0.0` exposes it to the network; if you need that, put an authenticating reverse proxy in front of it. For normal use with an MCP client, prefer the default stdio transport.
- **Credentials come from the environment, never from a file the server reads.** There is no `dotenv` dependency and `.env` is gitignored. `.env.example` contains placeholders only.
- **Alert content is untrusted input.** Alert messages, descriptions and notes are written by whatever integration fired them and are rendered into the model's context. Text inside an alert is data, not instructions — an agent acting on alerts should treat it that way.

## Out of scope

- Vulnerabilities in the Atlassian JSM Operations API itself — report those to [Atlassian](https://www.atlassian.com/trust/security/report-vulnerability).
- Findings that require an attacker to already hold your `JSM_API_TOKEN`.
- Anything that requires local access to a machine already running the server with credentials in its environment.
