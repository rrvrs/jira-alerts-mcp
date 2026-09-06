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
| `npm run check:endpoints` | Every tool's declared endpoint, checked against the vendored OpenAPI spec |
| `npm run spec:refresh` | Re-downloads that spec and rewrites its recorded hash |
| `npm run inspect` | MCP Inspector against `dist/index.js` — needs credentials |

CI runs lint, typecheck, test, and build on Node 24 and 26, plus CodeQL. All of them must pass — the `main` ruleset gates merges on them.

## Verifying against a real tenant

The test suite is deliberately offline, so it cannot catch a wrong endpoint path or a changed response envelope. For anything touching the API, also check it by hand:

```bash
npm run build
npm run inspect
```

Start with `jsm_list_alerts`. It needs no ids and confirms the credentials plus `read:ops-alert:jira-service-management`, the scope eight of the twelve tools share.

Check `jsm_list_schedules` **separately**. Schedules and on-call need `read:ops-config:jira-service-management`, a different grant, so this call can 401 on a token where every alert tool works. That is a scope gap, not a bad credential — do not treat one call as proof the other is healthy. If it returns an empty list rather than an error, the scope is present and the account simply can't see the team's Operations page.

### Endpoint verification

Paths are no longer checked by reading the docs site, which renders client-side and cannot be read end to end. The machine-readable spec is vendored at [`spec/jsm-ops.v3.json`](spec/jsm-ops.v3.json) and `npm run check:endpoints` asserts every tool against it — path, method, query names, body fields, and that nothing the spec marks required is missing. CI runs it. `npm run spec:refresh` re-downloads the spec and rewrites the recorded SHA-256, which the check verifies so a hand-edited spec cannot be used to make a failure disappear.

The vendored spec is a CI input, not a runtime dependency: `package.json` `files` is an allowlist that excludes it, and `check-manifests` asserts that so a later edit cannot quietly add 614 KB to every install.

Two things the check cannot settle, both recorded in the code as `allowUnknownQuery` / `allowUnknownBody` with the reasoning inline:

- **`order` on `GET /v1/alerts/{id}/notes` and `/logs`.** The spec declares only `after` and `size`. Opsgenie accepted `order` and JSM Operations is a rehost of it, so the tools still send it — but if a tenant returns newest-first regardless, drop it from the shape *and* the description rather than leaving both promising something the API does not do.
**Settled on 2026-09-05, against a live tenant — do not re-add:** `user` / `source` / `note` on the alert action endpoints. The check was the one described here: acknowledge with all three, then read the activity log back. Neither the note nor the actor appeared; the log recorded the credential owner and `customSource[api]`, exactly as it does without them. The spec agrees — no alert action endpoint declares any of the three. They are gone from the shapes, and the strict input schema now rejects them outright, which is the point: an ignored argument looks to a model like a recorded decision. `jsm_create_alert` keeps `note` and `source` because `CreateAlertRequest` declares both and the tenant honours them.

Adding a parameter on Opsgenie-parity grounds is still reasonable when the spec is thin — but record it as `allowUnknownBody` with the tenant check that would settle it, and go run that check before the tool ships to anyone.

Neither allowance is free: the check also fails when the spec *does* declare an allowed name, so a stale allowance has to be removed rather than accumulating into noise.

**Collection envelope**: Atlassian is inconsistent about whether collections come back under `data` or `values`, and two endpoints use neither — `GET /v1/teams` answers under `platformTeams` and `GET /v1/teams/{id}/roles` returns a bare array. `JsmClient.getCollection` handles all four, the last two via an explicit `itemsKey`. If a list tool returns zero items against data you know exists, that normaliser is still the first thing to inspect.

## Conventions worth preserving

Four things in this codebase are load-bearing. Changing them by accident is the most likely way to break the server subtly.

**1. Every write goes through `executeWrite`.** See [`src/tools/execute-write.ts`](src/tools/execute-write.ts); the alert family reaches it through the one-line [`alertAction`](src/tools/actions/alert-action.ts) helper, which owns the `/v1/alerts/{id}/` prefix. JSM applies alert actions asynchronously and returns a receipt rather than the updated alert, and one executor is what guarantees every write tool reports that receipt the same way and points at `jsm_get_request_status`. A new write tool that renders its own response will teach the model an inconsistent contract, and it will start believing writes have landed when they haven't.

Asynchrony is a `mode`, not an assumption. Alert actions are asynchronous; note edits and every configuration write are not, and a 204 carries no body at all. Telling the model to poll a request id that was never issued teaches a false contract just as surely as rendering your own receipt, so state the mode per tool — and use `renderDeleted` for a 204 that removed something or `renderConfirmed` for one that did not. Both exist for the same reason `emptyResult` does: a result with no `structuredContent` is rejected outright when an `outputSchema` is declared. Declaring the updated object as the output of a 204 endpoint is not a cosmetic mistake — the empty body deserialises to a string, output validation rejects it, and the tool is unreachable on every call. `check:endpoints` fails any tool that does this.

**2. Every list tool goes through `executeList`.** See [`src/tools/list-executor.ts`](src/tools/list-executor.ts). It owns fetching, the empty-result branch, truncation to 25,000 characters, the pagination block and the format switch.

It also owns the page-size parameter, which is not the same for every endpoint — see [`src/tools/paging.ts`](src/tools/paging.ts). Most read `size`; `/v1/logs` reads `limit` and does not know what `size` means; three endpoints including `GET /v1/teams` take no paging parameters at all, and reporting `has_more` from a full-looking page there sends a caller round the same records forever. State the dialect for anything that is not `size` + `offset`.

This is not tidiness. Those five steps were once copy-pasted into each list handler, and two bugs lived in the copies: an empty result set returned `ok(text)` with no `structuredContent`, which the SDK rejects outright when an `outputSchema` is declared, so "no alerts matched" became `-32602`; and the pagination block was computed from the untruncated page, so `next_offset` skipped every record truncation had dropped. Both had to be fixed four times. If you find yourself hand-rolling a list handler, that is the bug re-entering.

Two rules follow from it: an empty page is an ordinary answer and must still ship a structured payload (use `emptyResult`), and `count`/`next_offset` describe what the response actually contains, never what the API returned.

**3. `inputSchema` takes a raw Zod shape, not a `z.object(...)`.** Tools define a plain object of Zod types, and [`defineTool`](src/tools/define.ts) infers the handler's `params` from it, so no tool needs to write `z.infer<z.ZodObject<typeof shape>>` by hand. Keep writing raw shapes — but the reason is inference, not a hard SDK requirement.

The wrapping happens once, in `registerTools`, which passes `z.strictObject(shape)` to the SDK. That is deliberate. Left as a raw shape, the SDK wraps it in a plain `z.object`, and under Zod 4 a plain object emits no `additionalProperties` — so nothing in the advertised schema tells a model that a key it invented is not a real parameter, and the key is silently dropped at runtime. `strictObject` restores `additionalProperties: false` and turns an unknown key into a visible `-32602` naming it.

Two older claims about this are no longer true, and are worth un-learning: SDK ≥ 1.30 *accepts* a pre-wrapped Zod schema (`getZodSchemaObject` returns it as-is), and unknown keys are now **rejected, not stripped**. Both held on SDK 1.12.

Related: `ToolResult` in `src/services/format.ts` is a **type alias, not an interface**. The SDK's `CallToolResult` carries an index signature, and TypeScript only grants an implicit one to type aliases. Making it an interface breaks every tool callback's typecheck.

**4. A toolset reaches a profile only after it has been seen to work.** Every tool a profile can load has returned a real success against a live Jira Service Management site. That is an invariant, and [`src/toolsets.test.ts`](src/toolsets.test.ts) enforces it.

A family you cannot verify still ships — the code is probably right, and someone on a different plan will want it — but it carries an `unverified` reason in `TOOLSET_INFO` saying what blocked it, and no profile includes it, `all` included. Users reach it by naming it: `JSM_TOOLSETS=all,heartbeats`. `jsm_list_capabilities` repeats the reason at runtime, so an assistant tells the user what the limit was instead of suggesting a config change that will hit the same 402.

Removing an `unverified` marker is how a family graduates. Do it in a commit that says which tool was run, against what, and what came back.

2.0.0 removed two families outright rather than quarantining them — alert policies and custom user roles, seventeen tools that answered `403 You are not authorized` under two separate credentials, one holding Jira `ADMINISTER`. Quarantine is for "we could not test this here"; deletion is for "no credential we can plausibly get will ever run this".

## Adding a tool

1. Add any request/response types to [`src/types.ts`](src/types.ts). Type fields optional unless the API always returns them — the list endpoint returns a thinner object than the get endpoint.
2. Reuse the shared Zod fragments from [`src/schemas/common.ts`](src/schemas/common.ts) (`limitField`, `offsetField`, `alertIdField`, `responseFormatField`, …) rather than redefining bounds.
3. Create one file per tool under the domain it belongs to — `tools/alerts/` (read), `tools/actions/` (write), `tools/oncall/` (schedules) — exporting a single `defineTool({ ... })`. `defineTool` infers your handler's `params` from `inputSchema`, so don't hand-annotate them.
4. Set `toolset` to the family it belongs to, from `TOOLSETS` in [`src/toolsets.ts`](src/toolsets.ts). It is required rather than optional: a tool with no toolset could not be selected at all, and a default one would land it in a set its author never considered — probably the one people load without asking. A new family means a new entry in `TOOLSETS` and `TOOLSET_INFO`, which is also what makes it visible to `jsm_list_capabilities`.
5. Declare `endpoint` — method, path, and the query and body names you send. `npm run check:endpoints` checks it against the vendored spec, so a wrong path or an invented parameter fails in CI rather than against somebody's tenant. It is the same value your handler builds the request from; keep it that way, because a manifest that can drift from the code is worth nothing.
6. Add it to that domain's `index.ts` array. `server.ts` picks it up from there.
7. Add rendering to [`src/services/format.ts`](src/services/format.ts). Don't build markdown inline in the tool.
8. Set `annotations` honestly — `readOnlyHint`, `destructiveHint`, `idempotentHint`. Clients use these to decide what to auto-approve, and `readOnlyHint` is also the filter `JSM_READ_ONLY` applies, so a dishonest one now hands a write tool to someone who asked for a read-only server.
9. Add tests, and drive them through `connectTools` from [`src/tools/test-support.ts`](src/tools/test-support.ts) rather than calling the handler directly. Calling handlers directly skips the SDK's output-schema validation — that is exactly how the empty-result bug above shipped with a green suite asserting it was fine.
10. Update the tool table in the README.

Adding a tool to an existing toolset does **not** change what existing installs see. The default selection is the `responder` profile, and `core` is a frozen list of names in `src/toolsets.ts` guarded by a snapshot test — an install pinned to `core` keeps exactly those names even when `core` is combined with another toolset, so its auto-approval surface cannot widen under it on a patch bump. Widening either default is a separate, deliberate change — edit the array and the snapshot together, and say so in the release notes.

### On tool descriptions

The descriptions in this repo are long on purpose. They are the only documentation the model reads, and they carry three API behaviours that silently break naive integrations: writes are asynchronous, `tinyId` is not an id, and the search window caps at 20,000. If you add a tool with a sharp edge, state it in the description — not just in a code comment.

## Not implemented yet

Alert creation and `DELETE /v1/alerts/{id}` were listed here for two releases; both shipped in 2.0.0 as `jsm_create_alert` and `jsm_delete_alert`. What is still absent, all of it present in the vendored spec:

- **Integrations** — `/v1/integrations` and the six paths below it: the integration list, its actions, and the outgoing alert filter.
- **Syncs** — the eight `/v1/syncs` paths, including sync actions and action groups.
- **JEC channels** — `/v1/jec/channels` and `/v1/jec/action`. Note the paging dialect: `size` with no position parameter, already described in `src/tools/paging.ts`.
- **Attachment upload** — `POST /v1/alerts/{alertId}/attachments`. Listing, downloading and deleting are implemented; upload needs multipart handling this server does not yet do, and the whole family is marked `unverified` because the test tenant's plan excludes it.

If you need one of these sooner, open an issue describing the workflow.

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
