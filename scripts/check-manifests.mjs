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

if (failures.length) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  process.exit(1);
}

console.log(`✓ package.json and server.json agree — ${server.name}@${server.version}`);
