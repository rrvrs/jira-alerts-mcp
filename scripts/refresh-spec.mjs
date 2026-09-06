#!/usr/bin/env node
/**
 * Re-downloads the vendored OpenAPI spec and rewrites its metadata.
 *
 * Kept as a script rather than a curl in the README so the hash in
 * jsm-ops.meta.json is always written from the bytes that were actually
 * fetched. check-endpoints verifies that hash, which is what stops a
 * hand-edited spec from being used to make a failing check pass.
 */

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

const SOURCE = "https://developer.atlassian.com/cloud/jira/service-desk-ops/swagger.v3.json";

const response = await fetch(SOURCE);
if (!response.ok) {
  console.error(`Failed to fetch the spec: HTTP ${response.status}`);
  process.exit(1);
}

const text = await response.text();
// Parse before writing: a Cloudflare interstitial is a 200 with an HTML body,
// and overwriting a good spec with one would be worse than failing.
try {
  const parsed = JSON.parse(text);
  if (!parsed.paths) throw new Error("no `paths` — this is not the OpenAPI document");
} catch (error) {
  console.error(`The response was not the spec: ${error.message}`);
  process.exit(1);
}

writeFileSync(new URL("../spec/jsm-ops.v3.json", import.meta.url), text);
writeFileSync(
  new URL("../spec/jsm-ops.meta.json", import.meta.url),
  `${JSON.stringify(
    {
      source: SOURCE,
      fetchedAt: new Date().toISOString().slice(0, 10),
      sha256: createHash("sha256").update(text).digest("hex"),
      note:
        "Refresh with 'npm run spec:refresh'. The hash is verified by check-endpoints " +
        "so a hand-edited spec cannot make a failing check pass.",
    },
    null,
    2,
  )}\n`,
);

console.log(`✓ spec refreshed from ${SOURCE}`);
