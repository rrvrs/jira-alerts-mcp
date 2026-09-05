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

## Demo

<div align="center">

![An agent answering who is on call, listing the open alerts, then acknowledging one and reading the applied acknowledgement back](https://raw.githubusercontent.com/rrvrs/jira-alerts-mcp/main/docs/demo.gif)

</div>

Three questions in one session, against a live JSM site: who is on call, what is
open, and acknowledge what isn't. Watch the last answer in particular — the agent
confirms the acknowledgement actually landed (`ack landed 16:38:00.577Z`) instead
of assuming it did, which is the asynchronous-write behaviour described under
[What this server handles for you](#what-this-server-handles-for-you).

---

## Quickstart

**You need** Node ≥ 24 and an Atlassian Cloud site with JSM Operations enabled.
There is nothing to clone or build — your MCP client runs the published package.

**1. Find your cloud id.** Open this while logged in to your site:

```
https://<your-site>.atlassian.net/_edge/tenant_info
```

It answers with one line — `{"cloudId":"..."}` — and that UUID is what
`JSM_CLOUD_ID` wants. If you'd rather not rely on that endpoint, the cloud id is
also the segment after `/s/` in the URL at
[admin.atlassian.com](https://admin.atlassian.com) → Apps → Sites → your site.

**2. Create an API token** at
[id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens).

**3. Add the server.**

*Claude Code:*

```bash
claude mcp add jira-alerts-mcp \
  --scope user \
  --env JSM_CLOUD_ID='your-cloud-id' \
  --env JSM_EMAIL='you@example.com' \
  --env JSM_API_TOKEN="${JSM_API_TOKEN}" \
  -- npx -y jira-alerts-mcp
```

`--scope user` registers the server for your whole account rather than only the
directory you happened to run the command in. That is what you want for an
alerts server — you want it in every session. Without the flag `claude mcp add`
defaults to `local` scope, and the server exists in that one directory only.

*Claude Desktop:* open the config from the app rather than by hand — the **Claude
menu in your menu bar** (not the settings inside the window) → Settings →
Developer → **Edit Config**. That creates the file if it doesn't exist yet:

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

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

`mcpServers` is a **top-level key**, and the file holds every server you have
configured. If it already has an `mcpServers` block, add `jira-alerts-mcp` as
another entry inside it — pasting the whole block above over the file replaces
whatever was already there.

Then **quit Claude Desktop completely and reopen it** — the file is read only at
startup, and closing the window is not quitting. The server then appears under
the connectors panel in the message composer.

Most other MCP clients accept that same JSON shape. There is no scope choice to
make here — `claude_desktop_config.json` is already per-user, the same reach as
`--scope user` on the CLI.

**4. Check it works.** Ask your agent to list your open alerts. That runs
`jsm_list_alerts`, which needs no ids and confirms your credentials and the
`read:ops-alert` scope that eight of the thirteen tools share.

Then ask who is on call, which runs `jsm_list_schedules`. That is a **separate**
check, because schedules need `read:ops-config` — if alerts work and schedules
return 401, nothing is wrong with your token; see
[Required scopes](#configuration) below.

Things that catch people out: with `claude mcp add` the server name is the first
positional argument, before any flags; `-y` on `npx` skips the install prompt,
which an MCP client has no way to answer; and in zsh `${VAR}` needs quoting. A
server added without `--scope user` works in the directory you added it from and
is simply missing everywhere else, with no error to explain the absence — if it
seems to have disappeared, run `claude mcp list` from a different directory
before touching anything else. For GUI-launched sessions the token has to live
in the `env` block of the config itself — the shell environment isn't inherited,
which is why the JSON above carries the credentials inline.

**If the server never shows up in Claude Desktop**, two causes account for
almost all of it, and neither announces itself:

- **`npx` wasn't on the PATH.** A GUI app is launched by the window manager, not
  a shell, so a Node installed through nvm often isn't visible to it. Set
  `"command"` to the absolute path from `which node` and point `"args"` at the
  installed `dist/index.js`, or install Node system-wide. A Node older than 24
  that *is* found fails as `EBADENGINE` rather than anything readable.
- **The server exited during startup.** Credentials are validated before the
  handshake, so a bad cloud id or token stops it dead — and because stdout is
  the protocol channel, that message goes to stderr only. Claude Desktop keeps
  it at `~/Library/Logs/Claude/mcp-server-jira-alerts-mcp.log` (Windows:
  `%APPDATA%\Claude\logs\`), named after the key you used under `mcpServers`.
  Look for `Startup failed:` — it names exactly what is wrong.

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

**Required scopes.** Alerts and on-call sit behind **different** scopes, which is
the single most common setup mistake:

| Tools | Scope |
|---|---|
| The 5 alert reads | `read:ops-alert:jira-service-management` |
| The 4 alert writes | `read:ops-alert:…` **and** `write:ops-alert:…` — both |
| `jsm_list_schedules`, `jsm_get_on_call`, `jsm_get_next_on_call`, `jsm_get_schedule_timeline` | `read:ops-config:jira-service-management` |
| Resolving responder ids to names (optional) | `read:jira-user` |

Three consequences worth knowing before you mint a token:

- **Writes need the read scope too.** A token carrying only
  `write:ops-alert:jira-service-management` fails. Atlassian requires the read
  scope alongside it on every write endpoint.
- **`ops-config` is a separate grant, and a missing one returns 401, not 403.**
  Omit it and the nine alert tools work perfectly while the four on-call tools
  fail — which reads like a broken credential and is not one. Both are supported
  configurations: granting only the read scopes, or only `ops-alert`, is a
  deliberate way to narrow what the agent can reach.
- **The Jira user scope is optional, and its absence is visible rather than
  silent.** Every responder the Operations API returns is a bare account id
  (`712020:9ae5385e-…`); with `read:jira-user` the on-call tools resolve those
  to names and emails in the same call. Without it they still answer — you get
  the ids, plus one line saying which scope would have named them. Knowing who
  is on-call matters more than knowing their display name, so a missing scope
  here never turns into an error.

  Reach for `read:jira-user`, not `read:user:jira`. The granular scheme does
  cover these endpoints, but only as the complete set
  `read:application-role:jira` + `read:group:jira` + `read:user:jira` +
  `read:avatar:jira` — `read:user:jira` on its own is not sufficient, and
  Atlassian still marks the whole granular set Beta for this API.

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
| `jsm_get_schedule_timeline` | `GET /v1/schedules/{id}/timeline` | read |

Not implemented yet: alert creation and `DELETE /v1/alerts/{id}`. Creation is a
gap rather than a boundary — `POST /v1/alerts` is part of this API and needs only
the `write:ops-alert:jira-service-management` scope the existing write tools
already require — and it is planned. Deleting an alert destroys audit history
with no undo, which is why it has waited. Open an issue if you need either
sooner.

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
narrows the gap but does not close it. Since February 2026 it ships four JSM
Operations tools — `getJsmOpsAlerts`, `getJsmOpsScheduleInfo`, `getJsmOpsTeamInfo`
and `updateJsmOpsAlert` — and they are coarse: a single `updateJsmOpsAlert` covers
acknowledge, unacknowledge, close and escalate, and nothing covers notes, logs,
tags, attachments, snooze, assign, request status, timelines, rotations,
overrides, heartbeats, maintenance, routing, integrations or audit logs. They are
also absent from that repository's README, documented only on Atlassian's
[supported tools page](https://support.atlassian.com/atlassian-rovo-mcp-server/docs/supported-tools/),
and were API-token-only at launch — an OAuth install sees none of them. Being a
hosted, closed server, those gaps are Atlassian's to close rather than something
a contribution can fix.

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
