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

import { readFileSync } from "node:fs";

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

// --- Ruleset status checks vs the CI job matrix -----------------------------
//
// The `main` ruleset requires status checks by name, and those names come from
// the CI job's `name:` expanded over its matrix. Rename the job and the ruleset
// keeps waiting for checks that will never report — every PR blocks forever,
// with nothing in the diff to explain it.

const text = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const ci = text(".github/workflows/ci.yml");
const ruleset = read(".github/rulesets/main.json");

const nameTemplate = ci.match(/^\s{4}name:\s*(.+)$/m)?.[1]?.trim();
const matrixValues = ci
  .match(/^\s*node:\s*\[([^\]]+)\]/m)?.[1]
  .split(",")
  .map((value) => value.trim().replace(/^['"]|['"]$/g, ""));

if (!nameTemplate || !matrixValues) {
  failures.push("could not read the CI job name or its node matrix from .github/workflows/ci.yml");
} else {
  const expected = matrixValues
    .map((value) => nameTemplate.replace(/\$\{\{\s*matrix\.node\s*\}\}/, value))
    .sort();

  const required = (
    ruleset.rules?.find((rule) => rule.type === "required_status_checks")?.parameters
      ?.required_status_checks ?? []
  )
    .map((check) => check.context)
    .sort();

  expect(
    JSON.stringify(expected) === JSON.stringify(required),
    `ruleset required checks [${required.join(", ")}] do not match the CI jobs [${expected.join(", ")}] — ` +
      "a PR gated on a check that never reports can never merge",
  );
}

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
  const parts = (v) => v.split("-")[0].split(".").map((n) => Number(n) || 0);
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
console.log(`✓ ruleset requires exactly the checks CI produces`);
console.log(`✓ ${checked} dependency floors match their installed versions`);
