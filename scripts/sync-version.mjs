#!/usr/bin/env node
/**
 * Propagates package.json's version to every other file that records it.
 *
 * package.json is the single source of truth because npm requires the literal
 * there — it is the one place that cannot be a reference to somewhere else.
 * Everything below is derived from it, and `npm version <patch|minor|major>`
 * runs this automatically through the `version` lifecycle hook, so a release
 * bump is one command rather than five hand edits that have to agree.
 *
 * Derived places:
 *
 *   server.json          `version` and the npm entry's `packages[].version`
 *   src/constants.ts     SERVER_VERSION, reported over the MCP handshake
 *   package-lock.json    `version` and `packages[""].version`
 *
 * check-manifests.mjs still asserts all of them agree. This script stops the
 * drift happening; that check is what catches it if this script is bypassed or
 * a sixth place appears. Neither replaces the other — 2.0.0 shipped with a
 * lockfile still claiming 1.1.1 precisely because nothing was watching it.
 *
 * Every edit is anchored and counted. A target that cannot be found is a
 * failure, not a silent no-op: a renamed constant or a restructured manifest
 * must stop the release rather than quietly leave a stale version behind.
 */

import { readFileSync, writeFileSync } from "node:fs";

const url = (path) => new URL(`../${path}`, import.meta.url);
const readText = (path) => readFileSync(url(path), "utf8");
const readJson = (path) => JSON.parse(readText(path));

const version = readJson("package.json").version;
if (typeof version !== "string" || version.length === 0) {
  console.error("✗ package.json has no version to propagate");
  process.exit(1);
}

const failures = [];
const changes = [];

/**
 * Replaces every `"version": "..."` in a hand-formatted JSON file.
 *
 * Text rather than parse-and-stringify because server.json is written by hand
 * and keeps objects like `"transport": { "type": "stdio" }` on one line, which
 * JSON.stringify would expand — turning a one-line version bump into a
 * whole-file reformat.
 */
function syncHandFormattedJson(path, expectedCount) {
  const before = readText(path);
  const pattern = /^(\s*)"version": "[^"]*"/gm;
  const found = before.match(pattern)?.length ?? 0;

  if (found !== expectedCount) {
    failures.push(
      `${path}: expected ${expectedCount} "version" field(s), found ${found} — ` +
        "the manifest changed shape and this script no longer knows what to update",
    );
    return;
  }

  const after = before.replace(pattern, `$1"version": "${version}"`);
  if (after !== before) {
    writeFileSync(url(path), after);
    changes.push(path);
  }
}

/**
 * Sets the package's own version in the lockfile.
 *
 * Safe to parse and re-stringify: npm writes this file itself with two-space
 * indentation and no inline objects, so a round trip reproduces it byte for
 * byte. That is asserted below rather than assumed.
 */
function syncLockfile(path) {
  const before = readText(path);
  const lock = JSON.parse(before);

  if (`${JSON.stringify(lock, null, 2)}\n` !== before) {
    failures.push(
      `${path}: does not round-trip through JSON.stringify — refusing to rewrite it ` +
        "and reformat the whole file; run `npm install --package-lock-only` instead",
    );
    return;
  }

  const root = lock.packages?.[""];
  if (!root) {
    failures.push(`${path}: no packages[""] entry — cannot set the project's own version`);
    return;
  }

  lock.version = version;
  root.version = version;

  const after = `${JSON.stringify(lock, null, 2)}\n`;
  if (after !== before) {
    writeFileSync(url(path), after);
    changes.push(path);
  }
}

/** Sets a `export const NAME = "..."` string literal in a TypeScript source. */
function syncTsLiteral(path, name) {
  const before = readText(path);
  const pattern = new RegExp(`(export const ${name} = ")[^"]*(")`);

  if (!pattern.test(before)) {
    failures.push(`${path}: could not find \`export const ${name} = "..."\` to update`);
    return;
  }

  const after = before.replace(pattern, `$1${version}$2`);
  if (after !== before) {
    writeFileSync(url(path), after);
    changes.push(`${path} (${name})`);
  }
}

// server.json carries the version twice: the server's own, and the version of
// the npm package it points the registry at. They are required to agree.
syncHandFormattedJson("server.json", 2);
syncTsLiteral("src/constants.ts", "SERVER_VERSION");
syncLockfile("package-lock.json");

if (failures.length) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  process.exit(1);
}

if (changes.length === 0) {
  console.log(`✓ every version already reads ${version}`);
} else {
  console.log(`✓ propagated ${version} to:`);
  for (const change of changes) console.log(`    ${change}`);
}
