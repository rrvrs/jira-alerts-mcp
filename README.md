# jira-alerts-mcp

[![CI](https://github.com/rrvrs/jira-alerts-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/rrvrs/jira-alerts-mcp/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](https://nodejs.org)

An MCP server for the **Jira Service Management Operations** REST API — alerts and on-call.

## Why this exists

Every other Jira MCP server talks to Jira *work items*. Alerts are not work items. They live behind a different API (`/jsm/ops/api`, the rehosted Opsgenie surface) with its own scopes, its own id format, and its own asynchronous write semantics — and nothing reaches it.

The Atlassian Rovo connector doesn't close the gap either: it grants `read:jira-work` and Confluence read scopes, which cannot touch `/jsm/ops/api` at all. So an agent connected to Jira can read your tickets and still have no idea what is paging you right now.

This server covers that surface: search alerts, read their notes and activity timeline, acknowledge / close / annotate / add responders, and look up who is on call now and next.

Base URL: `https://api.atlassian.com/jsm/ops/api/{cloudId}/v1`

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

Deliberately **not** implemented: `DELETE /v1/alerts/{id}` and alert creation. Deleting alerts destroys audit history with no undo, and alert creation belongs to the integration API (`/jsm/ops/integration/v2/alerts`) with an integration key, not to an interactive agent. Open an issue if you have a concrete need.

---

## Three API behaviours the tool descriptions encode

These are the things that silently break naive integrations, so they are stated in the tool descriptions where the model will actually read them:

1. **Writes are asynchronous.** Every mutating endpoint returns `{ result, requestId, took }` immediately and applies the change out of band. Re-reading the alert right after an ack will often show it still unacknowledged. `jsm_get_request_status` is the correct verification path, and each write tool points at it.

2. **`tinyId` is not an id.** The short number in the JSM UI (`#4821`) is rejected by `/v1/alerts/{id}`, which accepts only the full `uuid-timestamp` id. Aliases need a different endpoint entirely (`/v1/alerts/alias?alias=`). Both the schema descriptions and the 404 handler say so explicitly, so the model self-corrects instead of retrying the same call.

3. **The search window caps at 20,000.** `offset + limit` must stay under it. `jsm_list_alerts` rejects deeper paging locally with a message telling the model to narrow the query instead of burning a round trip on a guaranteed 400.

---

## Setup

Requires **Node ≥ 22**.

```bash
git clone https://github.com/rrvrs/jira-alerts-mcp.git
cd jira-alerts-mcp
npm install
npm run build
```

### Configuration

Copy [`.env.example`](.env.example) for reference. Note that the server does **not** read `.env` itself — an MCP server is launched by its client, and the client owns the environment. Use the file as a checklist for your client's `env` block, or `set -a; source .env; set +a` for local development.

| Variable | Required | Notes |
|---|---|---|
| `JSM_CLOUD_ID` | yes | Your Atlassian site's cloud id (a UUID) |
| `JSM_EMAIL` + `JSM_API_TOKEN` | one of | [Create a token](https://id.atlassian.com/manage-profile/security/api-tokens) |
| `JSM_OAUTH_TOKEN` | one of | OAuth 3LO bearer; takes precedence if set |
| `TRANSPORT` | no | `stdio` (default) or `http` |
| `PORT` / `HOST` | no | HTTP transport; defaults to `127.0.0.1:3000` |
| `ALLOWED_HOSTS` | no | Comma-separated `Host` allowlist. Required if you set `HOST` beyond loopback — see [SECURITY.md](SECURITY.md) |

Credentials are validated at startup, so a bad config fails immediately with an actionable message rather than on the first tool call.

**Finding your cloud id.** Open `https://<your-site>.atlassian.net/_edgeAuth/tenantInfo` while logged in, or call `GET https://api.atlassian.com/oauth/token/accessible-resources` with your token.

**Required scopes.** Read tools need `read:ops-alert:jira-service-management`; write tools need `write:ops-alert:jira-service-management`. Granting only the read scope is a supported configuration — the write tools will fail with a 403 naming the missing scope.

The account also needs JSM Operations access on the relevant team. Alerts and schedules hang off a team's Operations page, so credentials that can't see the team will get **empty lists rather than errors**.

### Wiring into Claude Code

```bash
claude mcp add jsm-alerts \
  --env JSM_CLOUD_ID='your-cloud-id' \
  --env JSM_EMAIL='you@example.com' \
  --env JSM_API_TOKEN="${JSM_API_TOKEN}" \
  -- node /absolute/path/to/jira-alerts-mcp/dist/index.js
```

Two things that catch people out: the server name is the first positional argument, before any flags; and in zsh `${VAR}` needs quoting. For GUI-launched sessions the token has to live in the `env` block of `~/.claude/settings.json` — the shell environment isn't inherited.

### Testing

```bash
npm test           # offline test suite — no network, no tenant
npm run inspect    # MCP Inspector against dist/index.js — needs credentials
```

For the live check, start with `jsm_list_schedules`. It needs no ids and confirms auth, scopes and team visibility in one call.

---

## Endpoint verification status

Paths were checked against the [JSM ops REST API reference](https://developer.atlassian.com/cloud/jira/service-desk-ops/rest/v2/api-group-alerts/) rather than assumed:

- **Confirmed in the published docs**: `/v1/alerts`, `/v1/alerts/{id}`, `/v1/alerts/alias`, `/v1/alerts/requests/{id}`, `/v1/alerts/{id}/acknowledge`, `/v1/alerts/{id}/close`, `/v1/alerts/{id}/responders`, `/v1/alerts/{id}/notes`, `/v1/schedules/{id}/on-calls`, `/v1/schedules/{id}/next-on-calls`.
- **Opsgenie parity, worth confirming on first run**: `GET /v1/alerts/{id}/logs` and the exact query parameters for note/log paging (`order`, `offset` cursor). JSM Operations is a rehost of the Opsgenie API and these are unchanged there, but the docs site renders client-side and could not be read end to end.
- **Collection envelope**: Atlassian is inconsistent about whether collections come back under `data` or `values`. `JsmClient.getCollection` accepts both and normalises, so this needs no change either way — but if a list tool returns zero items against data you know exists, that normaliser is the first thing to inspect.

---

## Architecture

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

One tool per file. A tool module owns its input shape, its description and its handler, and nothing else — the largest is ~100 lines. `server.ts` concatenates the three domains' exported arrays; `index.ts` only knows about transports.

Three conventions worth preserving as you extend it:

- **Every list tool goes through `executeList`** (`tools/list-executor.ts`). It owns fetching, the empty-result branch, truncation to 25,000 characters, the pagination block and the format switch. Two bugs once lived in per-tool copies of that logic — an empty page returned a result the SDK rejected, and `next_offset` skipped records truncation had dropped. There is one copy now, on purpose.
- **Every write goes through `executeAction`** (`tools/actions/execute-action.ts`), so the async-receipt contract can't drift between the four write tools.
- **Pagination reports what was delivered, not what was fetched.** `count` and `next_offset` describe the records actually in the response, and `truncated` flags when the API returned more than fitted.

### A note on `inputSchema`

The MCP TypeScript SDK's `registerTool` expects a **raw Zod shape** (a plain object of Zod types), not a `z.object(...)`. Passing a `z.object` — as some examples show — fails. Tools here define a plain shape and derive their input type with `z.infer<z.ZodObject<typeof shape>>`. One consequence: `.strict()` can't be applied to a raw shape, so unknown keys are stripped rather than rejected.

Relatedly, `ToolResult` is a **type alias, not an interface**: the SDK's `CallToolResult` carries an index signature, and TypeScript only grants an implicit one to type aliases.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development loop, the conventions worth preserving, and how to add a tool. Issues and PRs must not contain cloud ids, tokens, or real alert data.

## Security

This server holds Atlassian credentials, and the HTTP transport performs no authentication of its own — see [SECURITY.md](SECURITY.md) for the threat model, hardening notes, and how to report a vulnerability privately.

## License

[Apache-2.0](LICENSE)
