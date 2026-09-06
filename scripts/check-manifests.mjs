#!/usr/bin/env node
/**
 * Keeps package.json and server.json in agreement.
 *
 * The MCP Registry cross-checks the two: `mcpName` in package.json must equal
 * `name` in server.json, and the version in server.json must match the version
 * of the npm package it points at. A mismatch is rejected at publish time with
 * "Registry validation failed for package" — after `npm publish` has already
 * gone out and can't be taken back. Catching it in CI is the whole point.
 */

import { readdirSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

const read = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

const pkg = read("package.json");
const server = read("server.json");
const npmPackage = server.packages?.find((entry) => entry.registryType === "npm");

const failures = [];
const expect = (condition, message) => {
  if (!condition) failures.push(message);
};

expect(npmPackage, "server.json has no npm entry in `packages`");

expect(
  pkg.mcpName === server.name,
  `package.json mcpName (${pkg.mcpName}) !== server.json name (${server.name})`,
);
expect(
  pkg.version === server.version,
  `package.json version (${pkg.version}) !== server.json version (${server.version})`,
);
expect(
  npmPackage?.version === server.version,
  `server.json packages[].version (${npmPackage?.version}) !== server.json version (${server.version})`,
);
expect(
  npmPackage?.identifier === pkg.name,
  `server.json packages[].identifier (${npmPackage?.identifier}) !== package.json name (${pkg.name})`,
);

// GitHub auth only grants the io.github.<owner>/ namespace. Publishing under
// anything else fails with "You do not have permission to publish this server".
expect(
  /^io\.github\.[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(server.name ?? ""),
  `server.json name (${server.name}) is not in the io.github.<owner>/<server> form GitHub auth requires`,
);

// The registry schema caps this at 100 and rejects longer values.
expect(
  (server.description?.length ?? 0) <= 100,
  `server.json description is ${server.description?.length} characters; the schema allows 100`,
);

// --- Ruleset status checks vs the jobs that actually report ----------------
//
// The `main` ruleset requires status checks by name. Require a name nothing
// produces and every PR blocks forever, with nothing in the diff to explain it.
// Conversely, add a CI matrix leg without gating it and the new leg is free to
// fail. Both are checked below.
//
// Only workflows that trigger on `pull_request` can satisfy a ruleset that
// gates pull requests — release.yml runs on tags, so its job is not a candidate
// no matter how it is named.

const text = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/** Job names a workflow reports on a pull request, expanded over its node matrix. */
const jobNamesOf = (path) => {
  const doc = parseYaml(text(path));

  // GitHub's `on:` is a YAML 1.1 boolean. This parser is 1.2, where it stays the
  // string "on" — but read both. If a schema change ever made every workflow
  // look triggerless, this check would pass while gating nothing.
  const triggers = doc?.on ?? doc?.[true];
  if (!triggers || !("pull_request" in triggers)) return [];

  return Object.entries(doc.jobs ?? {}).flatMap(([key, job]) => {
    // GitHub falls back to the job key when a job declares no `name`.
    const name = job?.name ?? key;
    if (!String(name).includes("${{")) return [name];

    const matrix = job?.strategy?.matrix?.node;
    if (!Array.isArray(matrix)) {
      failures.push(`${path}: job name "${name}" interpolates a matrix that could not be read`);
      return [];
    }
    return matrix.map((value) =>
      String(name).replaceAll(/\$\{\{\s*matrix\.node\s*\}\}/g, String(value)),
    );
  });
};

const ciJobs = jobNamesOf(".github/workflows/ci.yml");

const produced = new Set(
  readdirSync(new URL("../.github/workflows", import.meta.url))
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .flatMap((file) => jobNamesOf(`.github/workflows/${file}`)),
);

const ruleset = read(".github/rulesets/main.json");
const required = (
  ruleset.rules?.find((rule) => rule.type === "required_status_checks")?.parameters
    ?.required_status_checks ?? []
).map((check) => check.context);

expect(ciJobs.length > 0, "could not read any job name from .github/workflows/ci.yml");

for (const context of required) {
  expect(
    produced.has(context),
    `ruleset requires "${context}" but no pull_request workflow produces it — ` +
      "a PR gated on a check that never reports can never merge",
  );
}

for (const job of ciJobs) {
  expect(
    required.includes(job),
    `CI produces "${job}" but the ruleset does not require it — that leg is free to fail a PR`,
  );
}

// --- Server identity in source vs the manifests ----------------------------
//
// SERVER_VERSION is what the server reports over the MCP handshake, so a stale
// value misreports the version to every connected client while every manifest
// check still passes. RELEASING.md used to call this "three places"; it is four,
// and this is the one nothing was watching.

const constants = text("src/constants.ts");
const literal = (name) => new RegExp(`export const ${name} = "([^"]+)"`).exec(constants)?.[1];

const serverName = literal("SERVER_NAME");
const serverVersion = literal("SERVER_VERSION");

expect(
  serverName !== undefined && serverVersion !== undefined,
  "could not read SERVER_NAME / SERVER_VERSION from src/constants.ts",
);
expect(
  serverVersion === undefined || serverVersion === pkg.version,
  `src/constants.ts SERVER_VERSION (${serverVersion}) !== package.json version (${pkg.version}) — ` +
    "the handshake would report a version nothing else agrees with",
);
expect(
  serverName === undefined || serverName === pkg.name,
  `src/constants.ts SERVER_NAME (${serverName}) !== package.json name (${pkg.name})`,
);

// --- The vendored spec must not ship to npm --------------------------------

// 614 KB of OpenAPI document is a CI input, not something every install should
// download. `files` is an allowlist so this holds today; asserting it means a
// later edit that adds "spec" — or drops the allowlist for an ignore file —
// fails here instead of in a published tarball.
expect(
  Array.isArray(pkg.files) &&
    !pkg.files.some((entry) => entry.replace(/^\.\//, "").startsWith("spec")),
  "package.json `files` would publish spec/ — the vendored OpenAPI document is a CI input, not a runtime dependency",
);

// --- Declared floors vs installed versions ---------------------------------
//
// `npm outdated` compares installed against *latest*, so it stays silent while
// a declared floor rots far below what the project actually runs. That is how
// `@modelcontextprotocol/sdk` sat at `^1.12.0` while 1.30.0 was installed:
// eighteen minors of behaviour drift that no tool reported, because ^1.12.0
// still resolves to 1.30.0. The floor is what a fresh install without this
// lockfile is allowed to pick, so it has to mean something.

/** The lowest version a range admits, or null if the range is too complex to reason about. */
const floorOf = (range) => {
  const match = /^\s*(?:\^|~|>=)?\s*v?(\d+(?:\.\d+){0,2})\s*$/.exec(range);
  return match ? match[1] : null;
};

const compareVersions = (a, b) => {
  const parts = (v) =>
    v
      .split("-")[0]
      .split(".")
      .map((n) => Number(n) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i += 1) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1;
  }
  return 0;
};

const declared = { ...pkg.dependencies, ...pkg.devDependencies };
let checked = 0;

for (const [name, range] of Object.entries(declared)) {
  let installed;
  try {
    installed = read(`node_modules/${name}/package.json`).version;
  } catch {
    continue; // Not installed here; `npm ci` in CI guarantees it is.
  }

  const floor = floorOf(range);
  if (!floor) continue; // Compound ranges like "^3.25 || ^4.0" are not ours to judge.

  checked += 1;
  expect(
    compareVersions(floor, installed) >= 0,
    `${name} declares ${range} but ${installed} is installed — raise the floor to ^${installed}, ` +
      "or a fresh install may resolve a version this project has never been tested against",
  );
}

if (failures.length) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  process.exit(1);
}

console.log(`✓ package.json and server.json agree — ${server.name}@${server.version}`);
console.log(`✓ src/constants.ts reports ${serverName}@${serverVersion}`);
console.log(
  `✓ ruleset requires ${required.length} check(s), all produced on PRs; every CI leg is gated`,
);
console.log(`✓ ${checked} dependency floors match their installed versions`);
