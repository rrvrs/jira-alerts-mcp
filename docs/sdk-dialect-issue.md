# The draft-07 dialect bug: upstream status and our workaround

Why `src/services/schema-dialect.ts` exists, and what upstream is doing about it.

## Upstream status (checked 2026-09-12)

This is a known `@modelcontextprotocol/sdk` bug with **two open issues and two open
PRs**, the oldest from May 2026. Nothing has shipped.

| # | Kind | Opened | State | Title |
|---|---|---|---|---|
| [#2084](https://github.com/modelcontextprotocol/typescript-sdk/issues/2084) | issue | 2026-05-14 | open | `[SEP-1613 regression] tools/list still emits draft-07 in 1.29.0 — target option missing` |
| [#2085](https://github.com/modelcontextprotocol/typescript-sdk/pull/2085) | PR | 2026-05-14 | open, unmerged | `[v1.x] fix(server): emit JSON Schema 2020-12 in tools/list (SEP-1613)` |
| [#2653](https://github.com/modelcontextprotocol/typescript-sdk/pull/2653) | PR | 2026-08-12 | open, unmerged | `fix: default Zod v4 JSON Schema target to draft-2020-12` |
| [#2721](https://github.com/modelcontextprotocol/typescript-sdk/issues/2721) | issue | 2026-08-26 | open | `outputSchema always emitted as JSON Schema draft-07, breaking clients that only accept 2020-12` |

The latest release is **1.30.0** (published 2026-07-27) and it still emits draft-07 —
verified here, not assumed. There is no newer version to upgrade to.

[#2534](https://github.com/modelcontextprotocol/typescript-sdk/pull/2534) *was* merged
(2026-07-27), but it makes the **SDK's own client validator** tolerate draft-07. That
does not help us: the validator rejecting our tools belongs to the calling client, not
the SDK. Emission is still draft-07 either way.

**Do not file a new issue upstream** — #2721 already describes this exactly, with
confirmations against `@modelcontextprotocol/server-filesystem` and
`@perplexity-ai/mcp-server`.

## What the upstream thread has not covered

Worth adding as a comment on #2721. Both points are ours, and neither appears in the
thread as of 2026-09-12.

**1. A server author is not blocked.** The thread concludes the SDK fix is "the only
route". That holds for a server you merely consume, but an author who controls their
own server can correct the dialect on the wire today. `src/services/schema-dialect.ts`
wraps `transport.send` and rewrites `$schema` on outgoing `tools/list` results — about
20 lines, public SDK surface only, no patched dependency and no fork.

It is safe only while the schemas contain no construct the two dialects read
differently — no `$ref`, no `definitions`, no boolean `exclusiveMinimum`/`exclusiveMaximum`,
no tuple-form `items`. `src/server.test.ts` asserts that on every run, so the workaround
cannot quietly start lying as schemas grow. It also costs no validation: the SDK checks
tool output by parsing the Zod object in `validateToolOutput`, never the advertised
JSON Schema.

**2. Why this keeps shipping green.** The SDK's own client does not enforce a dialect,
so a server's test suite passes while no strict client can call a single tool. This
repository had 356 passing tests, clean typecheck, lint, manifest and endpoint checks —
and 28 of 28 tools were unusable. A test that reads `tool.name` out of `tools/list`
cannot see a dialect; the assertion has to be on the schema object itself.

## Reproduction (verified on a bare SDK server, no project code)

```js
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';

const server = new McpServer({ name: 'repro', version: '0' });
server.registerTool('echo',
  { inputSchema: { text: z.string() }, outputSchema: { text: z.string() } },
  async ({ text }) => ({ content: [{ type: 'text', text }], structuredContent: { text } }));

const [ct, st] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'c', version: '0' });
await Promise.all([server.connect(st), client.connect(ct)]);
const { tools } = await client.listTools();
console.log(tools[0].outputSchema.$schema);
// → http://json-schema.org/draft-07/schema#   (expected: 2020-12)
```

## Cause, for reference

`mapMiniTarget` in `server/zod-json-schema-compat.js` falls back to `'draft-7'` when no
`target` is given, and both `toJsonSchemaCompat` call sites in `server/mcp.js` omit it.
`toJsonSchemaCompat` accepts `target: 'draft-2020-12'`, but no `McpServer` or
`ServerOptions` field reaches it — which is why this needs a workaround rather than a
configuration change.

Remove `src/services/schema-dialect.ts` once #2085 or #2653 lands in a release.
