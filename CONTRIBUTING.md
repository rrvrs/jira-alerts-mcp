# Contributing

Thanks for taking an interest. This is a small, focused MCP server — the bar for a change is that it makes the server more useful to an agent working real alerts, not that it covers more of the API surface.

## Before you open an issue or PR

**Never include tenant data.** No cloud ids, no API tokens, no OAuth bearers, no real alert ids, messages, or on-call names. Redact them. An alert message from a production incident is somebody's outage; an API token in a public issue is a credential leak that needs rotating.

## Getting set up

Requires **Node ≥ 24**.

```bash
git clone https://github.com/rrvrs/jira-alerts-mcp.git
cd jira-alerts-mcp
npm install
npm run build
```

Then:

| Command | What it does |
|---|---|
| `npm run dev` | Runs the server from source with reload on change |
| `npm run lint` | Biome lint + format check over `src/` and `scripts/` |
| `npm run format` | Applies what `lint` would ask for |
| `npm run typecheck` | `tsc --noEmit` over sources *and* tests — must pass, `strict` is on |
| `npm test` | The offline test suite (`node:test`, no network, no tenant) |
| `npm run build` | Compiles to `dist/` |
| `npm run inspect` | MCP Inspector against `dist/index.js` — needs credentials |

CI runs lint, typecheck, test, and build on Node 24 and 26, plus CodeQL. All of them must pass — the `main` ruleset gates merges on them.

## Verifying against a real tenant

The test suite is deliberately offline, so it cannot catch a wrong endpoint path or a changed response envelope. For anything touching the API, also check it by hand:

```bash
npm run build
npm run inspect
```

Start with `jsm_list_schedules`. It needs no ids and confirms auth, scopes, and team visibility in one call. If it returns an empty list rather than an error, the credentials are valid but the account can't see the team's Operations page.

### Endpoint verification status

Paths were checked against the [JSM ops REST API reference](https://developer.atlassian.com/cloud/jira/service-desk-ops/rest/v2/api-group-alerts/) rather than assumed. Which ones rest on firmer ground matters when a call misbehaves:

- **Confirmed in the published docs**: `/v1/alerts`, `/v1/alerts/{id}`, `/v1/alerts/alias`, `/v1/alerts/requests/{id}`, `/v1/alerts/{id}/acknowledge`, `/v1/alerts/{id}/close`, `/v1/alerts/{id}/responders`, `/v1/alerts/{id}/notes`, `/v1/schedules/{id}/on-calls`, `/v1/schedules/{id}/next-on-calls`.
- **Opsgenie parity, worth confirming on first run**: `GET /v1/alerts/{id}/logs`, and the exact query parameters for note/log paging (`order`, `offset` cursor). JSM Operations is a rehost of the Opsgenie API and these are unchanged there, but the docs site renders client-side and could not be read end to end.
- **Collection envelope**: Atlassian is inconsistent about whether collections come back under `data` or `values`. `JsmClient.getCollection` accepts both and normalises, so this needs no change either way — but if a list tool returns zero items against data you know exists, that normaliser is the first thing to inspect.

## Conventions worth preserving

Three things in this codebase are load-bearing. Changing them by accident is the most likely way to break the server subtly.

**1. Every write goes through `executeAction`.** All four mutating tools share the helper in [`src/tools/actions/execute-action.ts`](src/tools/actions/execute-action.ts). JSM applies alert actions asynchronously and returns a receipt rather than the updated alert, and `executeAction` is what guarantees every write tool reports that receipt the same way and points at `jsm_get_request_status`. A new write tool that renders its own response will teach the model an inconsistent contract, and it will start believing writes have landed when they haven't.

**2. Every list tool goes through `executeList`.** See [`src/tools/list-executor.ts`](src/tools/list-executor.ts). It owns fetching, the empty-result branch, truncation to 25,000 characters, the pagination block and the format switch.

This is not tidiness. Those five steps were once copy-pasted into each list handler, and two bugs lived in the copies: an empty result set returned `ok(text)` with no `structuredContent`, which the SDK rejects outright when an `outputSchema` is declared, so "no alerts matched" became `-32602`; and the pagination block was computed from the untruncated page, so `next_offset` skipped every record truncation had dropped. Both had to be fixed four times. If you find yourself hand-rolling a list handler, that is the bug re-entering.

Two rules follow from it: an empty page is an ordinary answer and must still ship a structured payload (use `emptyResult`), and `count`/`next_offset` describe what the response actually contains, never what the API returned.

**3. `inputSchema` takes a raw Zod shape, not a `z.object(...)`.** Tools define a plain object of Zod types, and [`defineTool`](src/tools/define.ts) infers the handler's `params` from it, so no tool needs to write `z.infer<z.ZodObject<typeof shape>>` by hand. Keep writing raw shapes — but the reason is inference, not a hard SDK requirement.

The wrapping happens once, in `registerTools`, which passes `z.strictObject(shape)` to the SDK. That is deliberate. Left as a raw shape, the SDK wraps it in a plain `z.object`, and under Zod 4 a plain object emits no `additionalProperties` — so nothing in the advertised schema tells a model that a key it invented is not a real parameter, and the key is silently dropped at runtime. `strictObject` restores `additionalProperties: false` and turns an unknown key into a visible `-32602` naming it.

Two older claims about this are no longer true, and are worth un-learning: SDK ≥ 1.30 *accepts* a pre-wrapped Zod schema (`getZodSchemaObject` returns it as-is), and unknown keys are now **rejected, not stripped**. Both held on SDK 1.12.

Related: `ToolResult` in `src/services/format.ts` is a **type alias, not an interface**. The SDK's `CallToolResult` carries an index signature, and TypeScript only grants an implicit one to type aliases. Making it an interface breaks every tool callback's typecheck.

## Adding a tool

1. Add any request/response types to [`src/types.ts`](src/types.ts). Type fields optional unless the API always returns them — the list endpoint returns a thinner object than the get endpoint.
2. Reuse the shared Zod fragments from [`src/schemas/common.ts`](src/schemas/common.ts) (`limitField`, `offsetField`, `alertIdField`, `responseFormatField`, …) rather than redefining bounds.
3. Create one file per tool under the domain it belongs to — `tools/alerts/` (read), `tools/actions/` (write), `tools/oncall/` (schedules) — exporting a single `defineTool({ ... })`. `defineTool` infers your handler's `params` from `inputSchema`, so don't hand-annotate them.
4. Add it to that domain's `index.ts` array. `server.ts` picks it up from there.
5. Add rendering to [`src/services/format.ts`](src/services/format.ts). Don't build markdown inline in the tool.
6. Set `annotations` honestly — `readOnlyHint`, `destructiveHint`, `idempotentHint`. Clients use these to decide what to auto-approve.
7. Add tests, and drive them through `connectTools` from [`src/tools/test-support.ts`](src/tools/test-support.ts) rather than calling the handler directly. Calling handlers directly skips the SDK's output-schema validation — that is exactly how the empty-result bug above shipped with a green suite asserting it was fine.
8. Update the tool table in the README.

### On tool descriptions

The descriptions in this repo are long on purpose. They are the only documentation the model reads, and they carry three API behaviours that silently break naive integrations: writes are asynchronous, `tinyId` is not an id, and the search window caps at 20,000. If you add a tool with a sharp edge, state it in the description — not just in a code comment.

## Deliberately out of scope

- `DELETE /v1/alerts/{id}` — destroys audit history with no undo.
- Alert **creation** — belongs to the integration API (`/jsm/ops/integration/v2/alerts`) with an integration key, not to an interactive agent.

If you have a concrete need for either, open an issue describing the workflow before writing code.

## Pull requests

- One logical change per PR.
- Say what you verified and how. "Ran `jsm_list_schedules` against a test tenant" is worth more than "should work".
- New API behaviour needs a test, or an explanation of why it isn't testable offline.
- By contributing you agree your work is licensed under [Apache-2.0](LICENSE).

## Releasing

Maintainers only, and it is a two-step publish — npm first, then the MCP
Registry, which stores metadata pointing at the npm package. `package.json` and
`server.json` have to agree on name and version or the registry rejects the
listing; `npm run check:manifests` asserts that and CI runs it on every push.
The full sequence is in [RELEASING.md](RELEASING.md).

## Repository setup

Maintainers only. The GitHub settings that no commit can set — the About box,
merge behaviour, private vulnerability reporting and the `main` ruleset — live
in [`scripts/setup-repo.sh`](scripts/setup-repo.sh), with the ruleset itself
versioned as [`.github/rulesets/main.json`](.github/rulesets/main.json) so it
shows up in a diff rather than only in a settings page.

```bash
scripts/setup-repo.sh --dry-run   # prints every call, changes nothing
scripts/setup-repo.sh             # needs gh, and admin rights on the repo
```

What the ruleset enforces on `main`: no deletion, no force-push, squash merges
only, and a pull request that has one approval, resolved review threads, and
green CI on **both** Node versions.

Two things about it are easy to get wrong.

**Admins are not exempt from a ruleset by default.** This is where rulesets
differ from classic branch protection. With one required approval and a single
maintainer, an admin without a bypass cannot merge their own PR by any route.
The ruleset therefore lists the repository admin role in `bypass_actors`. The
rule is still fully enforced for outside contributors, which is its purpose.
When a second maintainer joins, delete that array.

**The required checks are named after the CI job.** They are `Node 24` and
`Node 26`, produced by `name: Node ${{ matrix.node }}` expanding over the
matrix in [`ci.yml`](.github/workflows/ci.yml). Rename that job and the ruleset
waits forever on checks that no longer report — every PR blocks, and nothing in
the diff explains why. `npm run check:manifests` compares the two and fails on
a mismatch, so change them together.
