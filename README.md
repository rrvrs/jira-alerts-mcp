<div align="center">

# Jira Alerts MCP

**Find what is paging you, and who is on call — from your agent.**

[![CI](https://github.com/rrvrs/jira-alerts-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/rrvrs/jira-alerts-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/jira-alerts-mcp.svg)](https://www.npmjs.com/package/jira-alerts-mcp)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-brightgreen.svg)](https://nodejs.org)

</div>

An MCP server for **Jira Service Management Operations** — the alert surface that
replaced Opsgenie, which no other Jira MCP server covers.

Search alerts and read their notes and activity timeline; acknowledge, close,
annotate them and add responders; and look up who is on call now and next.
Twelve tools, four of them writes.

---

## Quickstart

**You need** Node ≥ 24 and an Atlassian Cloud site with JSM Operations enabled.
There is nothing to clone or build — your MCP client runs the published package.

**1. Find your cloud id.** Open this while logged in to your site:

```
https://<your-site>.atlassian.net/_edgeAuth/tenantInfo
```

**2. Create an API token** at
[id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens).

**3. Add the server.** For Claude Code:

```bash
claude mcp add jira-alerts-mcp \
  --env JSM_CLOUD_ID='your-cloud-id' \
  --env JSM_EMAIL='you@example.com' \
  --env JSM_API_TOKEN="${JSM_API_TOKEN}" \
  -- npx -y jira-alerts-mcp
```

Most other MCP clients take a JSON config of this shape:

```json
{
  "mcpServers": {
    "jira-alerts-mcp": {
      "command": "npx",
      "args": ["-y", "jira-alerts-mcp"],
      "env": {
        "JSM_CLOUD_ID": "your-cloud-id",
        "JSM_EMAIL": "you@example.com",
        "JSM_API_TOKEN": "your-api-token"
      }
    }
  }
}
```

**4. Check it works.** Ask your agent to list your on-call schedules. That runs
`jsm_list_schedules`, which needs no ids and confirms auth, scopes and team
visibility in a single call — if it returns schedules, you are set up correctly.

Three things that catch people out: with `claude mcp add` the server name is the
first positional argument, before any flags; `-y` on `npx` skips the install
prompt, which an MCP client has no way to answer; and in zsh `${VAR}` needs
quoting. For GUI-launched sessions the token has to live in the `env` block of
`~/.claude/settings.json` — the shell environment isn't inherited.

<details>
<summary><b>Came here from this repository's Packages panel?</b></summary>

You found `@rrvrs/jira-alerts-mcp` on GitHub Packages. That is a mirror of the
same build, published so the panel is not empty. GitHub Packages requires a
personal access token even for public packages, so installing from it needs auth
that npmjs.com does not.

Use `npx jira-alerts-mcp` above — that is
[the package on npmjs.com](https://www.npmjs.com/package/jira-alerts-mcp),
installable anonymously, and the only supported install route. The two are
separate names on separate registries; nothing redirects between them.

</details>

<details>
<summary><b>Running from a clone instead</b></summary>

Only needed to work on the server itself, or to run a revision that has not been
released:

```bash
git clone https://github.com/rrvrs/jira-alerts-mcp.git
cd jira-alerts-mcp
npm install
npm run build
```

Then point your client at the build rather than at npx, so edits take effect
without republishing:

```bash
  -- node /absolute/path/to/jira-alerts-mcp/dist/index.js
```

</details>

---

## Configuration

| Variable | Required | Notes |
|---|---|---|
| `JSM_CLOUD_ID` | yes | Your Atlassian site's cloud id (a UUID) |
| `JSM_EMAIL` + `JSM_API_TOKEN` | one of | [Create a token](https://id.atlassian.com/manage-profile/security/api-tokens) |
| `JSM_OAUTH_TOKEN` | one of | OAuth 3LO bearer; takes precedence if set |
| `TRANSPORT` | no | `stdio` (default) or `http` |
| `PORT` / `HOST` | no | HTTP transport; defaults to `127.0.0.1:3000` |
| `ALLOWED_HOSTS` | no | Comma-separated `Host` allowlist. Required if you set `HOST` beyond loopback — see [SECURITY.md](SECURITY.md) |

Credentials are validated at startup, so a bad config fails immediately with an
actionable message rather than on the first tool call.

[`.env.example`](.env.example) lists these for reference. The server does **not**
read `.env` itself — an MCP server is launched by its client, and the client owns
the environment. Use the file as a checklist for your client's `env` block, or
`set -a; source .env; set +a` for local development.

**Required scopes.** Read tools need `read:ops-alert:jira-service-management`;
write tools need `write:ops-alert:jira-service-management`. Granting only the
read scope is a supported configuration — the write tools will fail with a 403
naming the missing scope.

**Team visibility.** The account also needs JSM Operations access on the relevant
team. Alerts and schedules hang off a team's Operations page, so credentials that
can't see the team will get **empty lists rather than errors**.

---

## Example

Asking who is on call resolves to `jsm_list_schedules`, then `jsm_get_on_call`:

> **you** — who's on call for payments right now?

```markdown
# Currently on-call for Payments — Primary

- Dana Okafor
```

Acknowledging an alert returns a **receipt**, not the updated alert — because
JSM applies alert actions out of band:

> **you** — ack alert 4f2a9c1e-…-1718395200000, I'm looking at it

```markdown
Acknowledge request accepted for alert `4f2a9c1e-…-1718395200000`.

- **Request id**: `c7b41f30-…`
- **Result**: Request will be processed

JSM applies alert actions asynchronously, so the alert may not reflect this
change immediately. Confirm with jsm_get_request_status using the request id
above, or re-read the alert after a moment.
```

That last paragraph is the point: without it an agent re-reads the alert, sees it
still unacknowledged, and acknowledges it again.

---

## Tools

| Tool | Endpoint | Read/Write |
|---|---|---|
| `jsm_list_alerts` | `GET /v1/alerts` | read |
| `jsm_get_alert` | `GET /v1/alerts/{id}` or `GET /v1/alerts/alias` | read |
| `jsm_list_alert_notes` | `GET /v1/alerts/{id}/notes` | read |
| `jsm_list_alert_logs` | `GET /v1/alerts/{id}/logs` | read |
| `jsm_get_request_status` | `GET /v1/alerts/requests/{id}` | read |
| `jsm_acknowledge_alert` | `POST /v1/alerts/{id}/acknowledge` | write |
| `jsm_close_alert` | `POST /v1/alerts/{id}/close` | write |
| `jsm_add_alert_note` | `POST /v1/alerts/{id}/notes` | write |
| `jsm_add_alert_responder` | `POST /v1/alerts/{id}/responders` | write |
| `jsm_list_schedules` | `GET /v1/schedules` | read |
| `jsm_get_on_call` | `GET /v1/schedules/{id}/on-calls` | read |
| `jsm_get_next_on_call` | `GET /v1/schedules/{id}/next-on-calls` | read |

Deliberately **not** implemented: `DELETE /v1/alerts/{id}` and alert creation.
Deleting alerts destroys audit history with no undo, and alert creation belongs
to the integration API (`/jsm/ops/integration/v2/alerts`) with an integration
key, not to an interactive agent. Open an issue if you have a concrete need.

---

## What this server handles for you

Three API behaviours silently break naive integrations. Each is stated in the
tool descriptions, where the model will actually read it:

1. **Writes are asynchronous.** Every mutating endpoint returns
   `{ result, requestId, took }` immediately and applies the change out of band.
   Re-reading the alert right after an ack will often show it still
   unacknowledged. `jsm_get_request_status` is the correct verification path, and
   each write tool points at it.

2. **`tinyId` is not an id.** The short number in the JSM UI (`#4821`) is
   rejected by `/v1/alerts/{id}`, which accepts only the full `uuid-timestamp`
   id. Aliases need a different endpoint entirely (`/v1/alerts/alias?alias=`).
   Both the schema descriptions and the 404 handler say so explicitly, so the
   model self-corrects instead of retrying the same call.

3. **The search window caps at 20,000.** `offset + limit` must stay under it.
   `jsm_list_alerts` rejects deeper paging locally with a message telling the
   model to narrow the query instead of burning a round trip on a guaranteed 400.

---

## Why this exists

**Alerts are not work items.** They live behind a different API — `/jsm/ops/api`,
the rehosted Opsgenie surface — with its own scopes, its own id format and its
own asynchronous write semantics. The MCP Registry lists 30 Jira servers; every
one of them talks to work items. None can tell you what is paging you right now.
[`atlassian/atlassian-mcp-server`](https://github.com/atlassian/atlassian-mcp-server)
does not close the gap either: it covers Jira, Confluence, JSM *requests*,
Bitbucket, Compass and the Teamwork Graph, but has no tool for alerts, schedules
or on-call — and being a hosted, closed server, that gap is Atlassian's to close
rather than something a contribution can fix.

**The Opsgenie MCP servers that do exist speak an API with an end date.**
[giantswarm/mcp-opsgenie](https://github.com/giantswarm/mcp-opsgenie),
[burakdirin/opsgenie-mcp-server](https://github.com/burakdirin/opsgenie-mcp-server)
and [daviddykeuk/opsgenie-mcp](https://github.com/daviddykeuk/opsgenie-mcp) all
call `api.opsgenie.com` with a GenieKey. Opsgenie
[reached end-of-sale on 4 June 2025 and shuts down on 5 April 2027](https://community.atlassian.com/forums/Opsgenie-Migration-articles/The-Evolution-of-IT-Operations-Opsgenie-s-Transition-into/ba-p/2968088),
at which point those REST APIs stop responding. This server targets the surface
that replaces them: `https://api.atlassian.com/jsm/ops/api/{cloudId}/v1`.

**Compatibility.** For Atlassian Cloud tenants with JSM Operations — sites
already migrated off standalone Opsgenie, or provisioned after the merge. If your
team still logs in at `app.opsgenie.com` and authenticates with a GenieKey, this
server will not reach your data; one of the Opsgenie servers above will, until
2027.

---

## Project layout

```
src/
├── index.ts                 # transports and startup credential validation
├── server.ts                # assembles the tool domains
├── constants.ts             # API root, limits
├── types.ts                 # JSM API interfaces
├── schemas/common.ts        # Zod fragments shared across domains
├── services/
│   ├── client.ts            # auth, request, envelope normalisation, error mapping
│   └── format.ts            # markdown rendering, truncation, result envelopes
└── tools/
    ├── define.ts            # defineTool() + registerTools()
    ├── list-executor.ts     # the shared list pipeline
    ├── alerts/              # read tools — one file per tool, plus shapes.ts
    ├── actions/             # write tools, all via execute-action.ts
    └── oncall/              # schedules and on-call
```

One tool per file. A tool module owns its input shape, its description and its
handler, and nothing else — the largest is ~100 lines. `server.ts` concatenates
the three domains' exported arrays; `index.ts` only knows about transports.

Three conventions in here are load-bearing, and changing them by accident is the
most likely way to break the server subtly. They are written up, with the bugs
that motivated each, under
[Conventions worth preserving](CONTRIBUTING.md#conventions-worth-preserving).

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development loop, the conventions
worth preserving, and how to add a tool. Issues and PRs must not contain cloud
ids, tokens, or real alert data.

## Security

This server holds Atlassian credentials, and the HTTP transport performs no
authentication of its own — see [SECURITY.md](SECURITY.md) for the threat model,
hardening notes, and how to report a vulnerability privately.

## License

[Apache-2.0](LICENSE)
