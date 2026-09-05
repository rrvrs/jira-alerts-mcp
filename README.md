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
`read:ops-alert` scope that nine of the fourteen tools share.

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
| `JSM_TOOLSETS` | no | Which tool families to register — see [Choosing your toolsets](#choosing-your-toolsets). Unset registers `responder` |
| `JSM_READ_ONLY` | no | `true` withholds every write tool |
| `TRANSPORT` | no | `stdio` (default) or `http` |
| `PORT` / `HOST` | no | HTTP transport; defaults to `127.0.0.1:3000` |
| `ALLOWED_HOSTS` | no | Comma-separated `Host` allowlist. Required if you set `HOST` beyond loopback — see [SECURITY.md](SECURITY.md) |

Credentials are validated at startup, so a bad config fails immediately with an
actionable message rather than on the first tool call.

[`.env.example`](.env.example) lists these for reference. The server does **not**
read `.env` itself — an MCP server is launched by its client, and the client owns
the environment. Use the file as a checklist for your client's `env` block, or
`set -a; source .env; set +a` for local development.

### What your credentials can and cannot do

Both auth methods are not equivalent, and the difference is not documented by
Atlassian. Verified against a live tenant on 2026-09-05:

**An Atlassian account API token (`JSM_EMAIL` + `JSM_API_TOKEN`) carries the read
and write ops scopes, but not the delete ones.** Every DELETE-based tool answers
`401 Unauthorized; scope does not match` — the credentials are valid, the grant
is missing. That is five tools:

`jsm_delete_alert` · `jsm_delete_alert_note` · `jsm_remove_alert_tags` ·
`jsm_remove_alert_extra_properties` · `jsm_delete_alert_attachment`

They need a 3LO or Forge OAuth token granted
`delete:ops-alert:jira-service-management`, supplied as `JSM_OAUTH_TOKEN`. The
401 handler says exactly this, so the model reports it rather than retrying.

**The alert attachment endpoints reject API tokens outright**, and the API's own
OpenAPI document maps them to no OAuth scope at all — so there is no grant to
request. `jsm_list_alert_attachments` and `jsm_get_alert_attachment` are
registered because they are real endpoints, but treat them as unavailable on
token auth.

**Some actions depend on your JSM plan, not on your scopes.** On a Standard
tenant, snooze, assign and custom actions are accepted and then fail out of band
with `Your account plan does not support …`. The request is well-formed; the
plan is the limit. This is exactly why writes are asynchronous and why
`jsm_get_request_status` matters — the immediate response to all three is a
successful receipt.

### Choosing your toolsets

The JSM Operations API is roughly 240 operations. Registering all of them would
hand your client a tool list it cannot choose from accurately, so the surface is
cut into named **toolsets** and you pick:

| Name | What it registers | Scope |
|---|---|---|
| `alerts` | Alert reads: search, detail, notes, activity logs, attachments, request status | `read:ops-alert:…` |
| `alert-actions` | Create, acknowledge, close, snooze, assign, escalate, annotate, tag, and delete | `read:` + `write:ops-alert:…`, plus `delete:ops-alert:…` for the destructive ones |
| `oncall` | Schedules, who is on call now and next, shift timelines | `read:ops-config:…` |

Plus three **profiles**, which are bundles of the above:

| Profile | Contents |
|---|---|
| `responder` | **The default.** `alerts` + `alert-actions` + `oncall` — the whole alert and on-call surface |
| `core` | The thirteen tools that shipped before toolsets existed, plus `jsm_create_alert` |
| `all` | Every toolset |

```jsonc
"env": { "JSM_TOOLSETS": "responder" }     // or "alerts,oncall", or "all"
```

Names combine freely, and the flags `--toolsets=a,b` and `--read-only` override
the environment. A name that isn't in the tables above stops the server at
startup with the valid names and a suggestion — a typo should not quietly leave
you with fewer tools than you asked for.

`core` is a frozen list of names — the surface this server had before toolsets
existed — kept so an install that wants exactly that can ask for it without
listing thirteen tools. `responder` is derived from its toolsets and widens as
families land, which is why it is the default: an alerts server whose alert tools
are mostly invisible until you reconfigure it is not much use.

`responder` and `all` hold the same tools today, because every toolset that
exists is an alert or on-call one. They stop being the same request as soon as
the configuration families land.

**`jsm_list_capabilities` is always registered**, whatever you select. It reports
every toolset, whether it is loaded, its scopes, and the variable to change — so
when you ask for something the current selection doesn't cover, you get "that's
in the `oncall` toolset" rather than "this server can't do that". Changing
`JSM_TOOLSETS` needs a restart; nothing can enable a toolset mid-conversation.

**Required scopes.** Alerts and on-call sit behind **different** scopes, which is
the single most common setup mistake:

| Tools | Scope |
|---|---|
| The 5 alert reads | `read:ops-alert:jira-service-management` |
| The alert writes | `read:ops-alert:…` **and** `write:ops-alert:…` — both |
| The destructive alert tools | also `delete:ops-alert:jira-service-management` |
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
| `jsm_list_alert_attachments` | `GET /v1/alerts/{id}/attachments` | read |
| `jsm_get_alert_attachment` | `GET /v1/alerts/{id}/attachments/{id}` | read |
| `jsm_get_request_status` | `GET /v1/alerts/requests/{id}` | read |
| `jsm_create_alert` | `POST /v1/alerts` | write |
| `jsm_acknowledge_alert` | `POST /v1/alerts/{id}/acknowledge` | write |
| `jsm_close_alert` | `POST /v1/alerts/{id}/close` | write |
| `jsm_add_alert_note` | `POST /v1/alerts/{id}/notes` | write |
| `jsm_unacknowledge_alert` | `POST /v1/alerts/{id}/unacknowledge` | write |
| `jsm_snooze_alert` | `POST /v1/alerts/{id}/snooze` | write |
| `jsm_assign_alert` | `POST /v1/alerts/{id}/assign` | write |
| `jsm_escalate_alert` | `POST /v1/alerts/{id}/escalate` | write |
| `jsm_add_alert_responder` | `POST /v1/alerts/{id}/responders` | write |
| `jsm_update_alert_field` | `PATCH /v1/alerts/{id}/{priority,message,description}` | write |
| `jsm_update_alert_note` | `PATCH /v1/alerts/{id}/notes/{id}` | write |
| `jsm_delete_alert_note` | `DELETE /v1/alerts/{id}/notes/{id}` | **destructive** |
| `jsm_add_alert_tags` | `POST /v1/alerts/{id}/tags` | write |
| `jsm_remove_alert_tags` | `DELETE /v1/alerts/{id}/tags` | **destructive** |
| `jsm_add_alert_extra_properties` | `POST /v1/alerts/{id}/extra-properties` | **destructive** |
| `jsm_remove_alert_extra_properties` | `DELETE /v1/alerts/{id}/extra-properties` | **destructive** |
| `jsm_delete_alert_attachment` | `DELETE /v1/alerts/{id}/attachments/{id}` | **destructive** |
| `jsm_execute_alert_action` | `POST /v1/alerts/{id}/action` | **destructive** |
| `jsm_delete_alert` | `DELETE /v1/alerts/{id}` | **destructive** |
| `jsm_list_schedules` | `GET /v1/schedules` | read |
| `jsm_get_on_call` | `GET /v1/schedules/{id}/on-calls` | read |
| `jsm_get_next_on_call` | `GET /v1/schedules/{id}/next-on-calls` | read |
| `jsm_get_schedule_timeline` | `GET /v1/schedules/{id}/timeline` | read |
| `jsm_list_capabilities` | — (answers from configuration) | read |

Schedule configuration — the `schedules` toolset, **not** registered by default:

| Tool | Endpoint | Read/Write |
|---|---|---|
| `jsm_get_schedule` | `GET /v1/schedules/{id}` | read |
| `jsm_create_schedule` | `POST /v1/schedules` | write |
| `jsm_update_schedule` | `PATCH /v1/schedules/{id}` | **destructive** |
| `jsm_delete_schedule` | `DELETE /v1/schedules/{id}` | **destructive** |
| `jsm_list_rotations` | `GET /v1/schedules/{id}/rotations` | read |
| `jsm_get_rotation` | `GET /v1/schedules/{id}/rotations/{id}` | read |
| `jsm_create_rotation` | `POST /v1/schedules/{id}/rotations` | write |
| `jsm_update_rotation` | `PATCH /v1/schedules/{id}/rotations/{id}` | **destructive** |
| `jsm_delete_rotation` | `DELETE /v1/schedules/{id}/rotations/{id}` | **destructive** |
| `jsm_list_overrides` | `GET /v1/schedules/{id}/overrides` | read |
| `jsm_get_override` | `GET /v1/schedules/{id}/overrides/{alias}` | read |
| `jsm_create_override` | `POST /v1/schedules/{id}/overrides` | write |
| `jsm_update_override` | `PUT /v1/schedules/{id}/overrides/{alias}` | **destructive** |
| `jsm_delete_override` | `DELETE /v1/schedules/{id}/overrides/{alias}` | **destructive** |

Teams and permissions — the `teams` toolset, **not** registered by default:

| Tool | Endpoint | Read/Write |
|---|---|---|
| `jsm_list_teams` | `GET /v1/teams` | read |
| `jsm_list_team_roles` | `GET /v1/teams/{id}/roles` | read |
| `jsm_get_team_role` | `GET /v1/teams/{id}/roles/{identifier}` | read |
| `jsm_create_team_role` | `POST /v1/teams/{id}/roles` | write |
| `jsm_update_team_role` | `PATCH /v1/teams/{id}/roles/{identifier}` | **destructive** |
| `jsm_delete_team_role` | `DELETE /v1/teams/{id}/roles/{identifier}` | **destructive** |
| `jsm_list_user_roles` | `GET /v1/roles` | read |
| `jsm_get_user_role` | `GET /v1/roles/{identifier}` | read |
| `jsm_create_user_role` | `POST /v1/roles` | write |
| `jsm_update_user_role` | `PUT /v1/roles/{identifier}` | **destructive** |
| `jsm_delete_user_role` | `DELETE /v1/roles/{identifier}` | **destructive** |
| `jsm_assign_user_role` | `POST /v1/roles/assign` | **destructive** |
| `jsm_list_contacts` | `GET /v1/users/contacts` | read |
| `jsm_get_contact` | `GET /v1/users/contacts/{id}` | read |
| `jsm_create_contact` | `POST /v1/users/contacts` | write |
| `jsm_update_contact` | `PATCH /v1/users/contacts/{id}` | **destructive** |
| `jsm_delete_contact` | `DELETE /v1/users/contacts/{id}` | **destructive** |
| `jsm_activate_contact` | `PATCH /v1/users/contacts/{id}/activate` | write |
| `jsm_deactivate_contact` | `PATCH /v1/users/contacts/{id}/deactivate` | **destructive** |

Maintenance windows — the `maintenance` toolset, **not** registered by default:

| Tool | Endpoint | Read/Write |
|---|---|---|
| `jsm_list_maintenances` | `GET /v1/maintenances` or `GET /v1/teams/{id}/maintenances` | read |
| `jsm_get_maintenance` | `GET /v1/maintenances/{id}` or the team twin | read |
| `jsm_create_maintenance` | `POST /v1/maintenances` or the team twin | write |
| `jsm_update_maintenance` | `PATCH /v1/maintenances/{id}` or the team twin | **destructive** |
| `jsm_delete_maintenance` | `DELETE /v1/maintenances/{id}` or the team twin | **destructive** |
| `jsm_cancel_maintenance` | `POST /v1/maintenances/{id}/cancel` or the team twin | write |

Each of these is one tool over two endpoints: pass `team_id` for a team's
windows, omit it for site-wide ones. They are separate collections, so omitting
`team_id` does not return both — worth knowing when you are trying to explain
why alerting has gone quiet.

Heartbeats — the `heartbeats` toolset, **not** registered by default:

| Tool | Endpoint | Read/Write |
|---|---|---|
| `jsm_list_heartbeats` | `GET /v1/teams/{id}/heartbeats` | read |
| `jsm_ping_heartbeat` | `GET /v1/teams/{id}/heartbeats/ping` | **destructive** |
| `jsm_create_heartbeat` | `POST /v1/teams/{id}/heartbeats` | write |
| `jsm_update_heartbeat` | `PATCH /v1/teams/{id}/heartbeats?name=` | **destructive** |
| `jsm_delete_heartbeat` | `DELETE /v1/teams/{id}/heartbeats?name=` | **destructive** |

Heartbeats are identified by `name` in the query string rather than by an id in
the path — there is no item URL for them. They are a paid feature: on a plan
without them every heartbeat endpoint answers `402 Please upgrade your pricing
plan for Heartbeat Monitoring`, which the error handler reports as a plan limit
rather than as something to retry. `jsm_ping_heartbeat` is marked
destructive because sending a ping by hand asserts, on the monitored job's
behalf, that it is alive: it resets the timer and clears a firing alert.

Enable them with `JSM_TOOLSETS=responder,schedules,teams`, or `JSM_TOOLSETS=admin` for
on-call reads plus schedule and team configuration. They are separate from
`responder` on purpose: editing a rotation or granting a role is not something a
responder working an incident should be one tool call away from, and the write
scopes are a different grant.

`jsm_deactivate_contact` and `jsm_assign_user_role` are marked destructive
without deleting anything. Deactivating a contact method stops a person being
notified — silently, which is the failure mode worth prompting on — and
assigning a role grants site-wide rights.

The alert and on-call tables above are registered by default. Narrow the surface with `JSM_TOOLSETS`
or `JSM_READ_ONLY` — see [Choosing your toolsets](#choosing-your-toolsets).

`jsm_create_alert` pages people. A created alert enters the team's routing and
escalation rules exactly as one raised by a monitoring integration would. Its
`alias` is the de-duplication key: creating against an alias that already has an
open alert increments that alert's count instead of raising a second one, which
is what makes a retried create safe — and what makes a carelessly reused alias
quietly do nothing.

Tools marked **destructive** carry `destructiveHint: true`, which is what MCP
clients read to decide whether to prompt before running something. They are
registered like any other tool — the annotation is the guardrail, not absence —
and several of them need `delete:ops-alert:jira-service-management`, a separate
grant from `write:ops-alert`. A token that can close alerts usually cannot delete
them, and that is a sensible configuration rather than something to work around.

`jsm_delete_alert` is included and is almost never the right tool. Closing an
alert takes it out of the open queue and keeps the record of who was paged and
what they tried; deleting throws that away for everyone, with no undo.

Not implemented: `POST /v1/alerts/{id}/attachments` (uploading a file). It is the
only endpoint in the API with a non-JSON body, and the only one that would
require this server to read your local filesystem — a capability worth deciding
on deliberately rather than acquiring as a side effect. Open an issue if you need
it.

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

4. **Alert actions take no actor or note.** Opsgenie accepted `user`, `source`
   and `note` alongside an acknowledge or a close, and JSM Operations is an
   Opsgenie rehost — but it declares no request body for those endpoints and
   discards the fields silently. Acknowledging with a note and reading the
   activity log back shows neither the note nor the actor. So these tools do not
   offer the parameters at all: a rejected argument is a fact the model can act
   on, where an ignored one looks like a recorded decision that has actually
   vanished. To leave a durable note, call `jsm_add_alert_note`. `jsm_create_alert`
   *does* take `note` and `source`, because `CreateAlertRequest` declares both
   and the API honours them — also verified.

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
