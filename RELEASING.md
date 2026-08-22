# Releasing

Two artifacts go out, in this order: the npm package, then the MCP Registry
listing. The registry hosts **metadata only** — it points at the npm package
and verifies that the package really is the server it claims to be. So the
npm publish has to land first; there is nothing for the registry to check
until it does.

Neither publish can be undone. The npm half now runs in CI off a version tag,
so the credential that used to live on a maintainer's machine is gone; the
registry half is still a maintainer running a command.

## 1. Bump the version

Four places, and they must agree:

| File | Field |
|---|---|
| `package.json` | `version` |
| `server.json` | `version` |
| `server.json` | `packages[0].version` |
| `src/constants.ts` | `SERVER_VERSION` |

The last one is the one that used to get missed. It is what the server reports
over the MCP handshake, so a stale value misreports the version to every
connected client — and until `check:manifests` started asserting it, every other
check still passed while it was wrong.

```bash
npm run check:manifests
```

This also asserts `package.json` `mcpName` equals `server.json` `name`, and
that the name is in the `io.github.<owner>/<server>` form GitHub authentication
grants. CI runs it on every push. A mismatch caught here is a minor edit; the
same mismatch caught at publish time arrives as `Registry validation failed for
package`, after the npm release has already gone out.

## 2. Check the build locally

```bash
npm ci && npm run lint && npm run typecheck && npm test && npm run build
```

Then confirm the tarball contains what you expect and nothing more:

```bash
npm pack --dry-run
```

`files` is `["dist"]`, so tests, sources and `.env.example` stay out. `dist/`
must contain no `*.test.js` and no `test-support.*` — CI checks this too.

## 3. Tag, and let CI publish

```bash
git tag -a v1.0.0 -m "v1.0.0" && git push origin v1.0.0
```

That is the whole npm release. `.github/workflows/release.yml` fires on the tag,
re-runs lint, typecheck, test, build and `check:manifests` on a clean checkout,
verifies the tag matches `package.json` `version`, and publishes.

Two things this buys over the old local `npm publish`. What ships is exactly the
tagged commit, rather than whatever happened to be in a working directory. And
the package carries a **provenance attestation** linking it to this repository
and that workflow run, which a local publish cannot produce.

Publishing uses npm **trusted publishing** over OIDC, so there is no `NPM_TOKEN`
secret to leak or rotate. It has to be enabled once, on npmjs.com, for the
`jira-alerts-mcp` package: point it at this repository and
`.github/workflows/release.yml`. Until that is configured the publish step will
fail — that is the expected first-release stumble, and it is a settings change,
not a code change.

Verify at `https://www.npmjs.com/package/jira-alerts-mcp`, which should now show
a "Provenance" panel.

## 4. Publish to the MCP Registry

Still manual, and deliberately so: `mcp-publisher` authenticates with a GitHub
device-code flow that cannot run unattended.

```bash
brew install mcp-publisher
mcp-publisher login github
mcp-publisher publish
```

The GitHub account must own the `rrvrs` namespace — that is what entitles this
server to the `io.github.rrvrs/` prefix. `mcp-publisher` reads `server.json`
from the working directory.

## 5. Verify the listing

```bash
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=jira-alerts-mcp"
```

## After the first successful npm publish

`npx jira-alerts-mcp` starts working at that moment and not before. Documenting
it in the README earlier would ship an install instruction that fails, so the
README change belongs in the same commit as the version bump that follows the
first release — not ahead of it.

## Caveats

- **The MCP Registry is in preview.** Its maintainers warn of breaking changes
  and data resets before general availability. Treat a listing as best-effort;
  the npm package and this repository are the durable artifacts.
- **npm publishes are effectively permanent.** Unpublishing is restricted to a
  72-hour window and blocked entirely once anything depends on the package.
  Prefer a patch release over an unpublish.
