# Contributing

Thanks for taking an interest. This is a small, focused MCP server — the bar for a change is that it makes the server more useful to an agent working real alerts, not that it covers more of the API surface.

## Before you open an issue or PR

**Never include tenant data.** No cloud ids, no API tokens, no OAuth bearers, no real alert ids, messages, or on-call names. Redact them. An alert message from a production incident is somebody's outage; an API token in a public issue is a credential leak that needs rotating.

## Getting set up

Requires **Node ≥ 22**.

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
| `npm run typecheck` | `tsc --noEmit` — must pass, `strict` is on |
| `npm test` | The offline test suite (`node:test`, no network, no tenant) |
| `npm run build` | Compiles to `dist/` |
| `npm run inspect` | MCP Inspector against `dist/index.js` — needs credentials |

CI runs typecheck, test, and build on Node 22 and 24. All three must pass.

## Verifying against a real tenant

The test suite is deliberately offline, so it cannot catch a wrong endpoint path or a changed response envelope. For anything touching the API, also check it by hand:

```bash
npm run build
npm run inspect
```

Start with `jsm_list_schedules`. It needs no ids and confirms auth, scopes, and team visibility in one call. If it returns an empty list rather than an error, the credentials are valid but the account can't see the team's Operations page.

## Conventions worth preserving

Three things in this codebase are load-bearing. Changing them by accident is the most likely way to break the server subtly.

**1. Every write goes through `executeAction`.** All four mutating tools in [`src/tools/alert-actions.ts`](src/tools/alert-actions.ts) share one helper. JSM applies alert actions asynchronously and returns a receipt rather than the updated alert, and `executeAction` is what guarantees every write tool reports that receipt the same way and points at `jsm_get_request_status`. A new write tool that renders its own response will teach the model an inconsistent contract, and it will start believing writes have landed when they haven't.

**2. Every list tool wraps its output in `withCharacterLimit`.** See [`src/services/format.ts`](src/services/format.ts). It halves the result set until the rendered text fits 25,000 characters and appends a note telling the model how to get the rest. Without it, one broad query can consume the entire context window.

**3. `inputSchema` takes a raw Zod shape, not a `z.object(...)`.** The MCP TypeScript SDK's `registerTool` wraps the shape itself. Passing a `z.object` — as some examples online show — fails. Tools here define a plain object of Zod types and derive the input type with `z.infer<z.ZodObject<typeof shape>>`. One consequence: `.strict()` cannot be applied to a raw shape, so unknown keys are stripped rather than rejected.

Related: `ToolResult` in `src/services/format.ts` is a **type alias, not an interface**. The SDK's `CallToolResult` carries an index signature, and TypeScript only grants an implicit one to type aliases. Making it an interface breaks every tool callback's typecheck.

## Adding a tool

1. Add any request/response types to [`src/types.ts`](src/types.ts). Type fields optional unless the API always returns them — the list endpoint returns a thinner object than the get endpoint.
2. Reuse the shared Zod fragments from [`src/schemas/common.ts`](src/schemas/common.ts) (`limitField`, `offsetField`, `alertIdField`, `responseFormatField`, …) rather than redefining bounds.
3. Register in the file matching the tool's nature: `alerts.ts` (read), `alert-actions.ts` (write), `oncall.ts` (schedules).
4. Add rendering to [`src/services/format.ts`](src/services/format.ts). Don't build markdown inline in the tool.
5. Set `annotations` honestly — `readOnlyHint`, `destructiveHint`, `idempotentHint`. Clients use these to decide what to auto-approve.
6. Add tests. Rendering and guard logic are testable offline; that is where the coverage should go.
7. Update the tool table in the README.

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
