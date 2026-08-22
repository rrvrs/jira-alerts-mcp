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
git tag -a v1.0.1 -m "v1.0.1" && git push origin v1.0.1
```

That is the whole npm release. `.github/workflows/release.yml` fires on the tag,
re-runs lint, typecheck, test, build and `check:manifests` on a clean checkout,
verifies the tag matches `package.json` `version`, publishes, and creates the
GitHub Release with notes grouped by PR label per `.github/release.yml`.

Three things this buys over the old local `npm publish`. What ships is exactly
the tagged commit, rather than whatever happened to be in a working directory.
The package carries a **provenance attestation** linking it to this repository
and that workflow run, which a local publish cannot produce. And the two
artifacts can no longer drift apart, because one push makes both.

The publish step is **idempotent**: if the version is already on the registry it
logs a notice and skips. Publishes cannot be undone, so a release that fails
after the publish has to be safe to re-run. The tag-vs-`package.json` check
still catches the mistake this would otherwise have caught — forgetting to bump.

Publishing uses npm **trusted publishing** over OIDC, so there is no `NPM_TOKEN`
secret to leak or rotate. Two things it quietly depends on:

- **The job pins Node 24, and not the `engines` floor.** Trusted publishing
  needs npm ≥ 11.5.1, and each Node major bundles the npm of its era — Node 22
  ships npm 10.9.8, which predates the OIDC handshake. An npm that cannot do the
  handshake is treated as an anonymous user, and anonymous users cannot `PUT`,
  so it surfaces as a bare `404`/`ENEEDAUTH` pointing nowhere near the cause.
  A guard step asserts the version and says so plainly.
- **The trusted publisher must be configured on npmjs.com** for the
  `jira-alerts-mcp` package, pointing at this repository and `release.yml`.
  Every field is case-sensitive, filename extension included, and npm also
  checks `package.json` `repository.url` against the repo. Inspect it with
  `npm trust list jira-alerts-mcp`.

Verify at `https://www.npmjs.com/package/jira-alerts-mcp`, which should show a
"Provenance" panel for the new version.

### The GitHub Packages mirror

A successful publish is followed by a second one, pushing
`@rrvrs/jira-alerts-mcp` to `npm.pkg.github.com`. It exists for one reason: the
repository's Packages panel reflects GitHub Packages, not npmjs, so without it
the page reads "No packages published" no matter how many npm releases go out.

Three things about it are deliberate and should not be "fixed":

- **The name is scoped.** GitHub Packages requires the scope to match the repo
  owner, so the mirror cannot carry the npmjs name. The workflow rewrites
  `package.json` `name` immediately before that publish. This is safe only
  because the npmjs publish has already happened by then — do not move the step
  earlier.
- **It carries no provenance.** Attestations are an npmjs feature. The npmjs
  copy is the one with the Sigstore statement; the mirror having none is not a
  regression.
- **It is not an install route.** GitHub Packages requires a personal access
  token even for public packages. `README.md` says so, in the section a visitor
  arriving from the Packages panel will read first.

Failure of this step leaves the npm release intact and the GitHub Release
uncreated. Fix the step and re-run the workflow: the npm publish skips, and only
the mirror retries.

### First release only — how the package got created

Trusted publishing is a **per-package** setting, so it cannot be configured for
a package that does not exist yet, and npm has no "pending publisher" flow the
way PyPI does. The package must exist to configure OIDC, and OIDC must be
configured to publish.

1.0.0 broke that circle by hand: a single local `npm publish --no-provenance`
claimed the name, then

```bash
npm trust github jira-alerts-mcp --file release.yml --repo rrvrs/jira-alerts-mcp --allow-publish
```

configured the publisher for everything after it. That is why **1.0.0 is the one
version with no provenance attestation**, and why it is the only version ever
published from a laptop. Nothing here needs repeating; it is recorded so the
gap in 1.0.0 is not later mistaken for a fault.

Two things that bootstrap trips over, worth knowing before repeating it for a
second package:

- **npm requires 2FA to publish at all.** With it off, the publish dies on a
  `403` naming 2FA — after the tarball has been built and uploaded, so it looks
  like a permissions problem rather than an account setting. Enable it first.
  Once on at `auth-and-writes`, every write *including* `npm trust list` prompts
  for a one-time password, so the bootstrap has to be run by a human at a
  terminal. Trusted publishing is exempt: OIDC replaces the credential, which is
  the point.
- **`publishConfig.provenance` is overridden by `--no-provenance` on the CLI**,
  which is what makes a local bootstrap possible at all. `--dry-run` does not
  prove this either way, because npm skips provenance generation in a dry run.

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
