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
const ALLOWED_ORIGIN = "https://developer.atlassian.com";
/** The document is ~614 KB. Ten times that is generous and still bounded. */
const MAX_BYTES = 6 * 1024 * 1024;

const response = await fetch(SOURCE, { redirect: "follow" });
if (!response.ok) {
  console.error(`Failed to fetch the spec: HTTP ${response.status}`);
  process.exit(1);
}

// fetch follows redirects silently, so the origin that actually answered is
// not necessarily the one asked. Checking response.url is what stops a
// redirect off the vendor's domain from being vendored in and hashed as
// though it were the real document.
if (new URL(response.url).origin !== ALLOWED_ORIGIN) {
  console.error(
    `Refusing the response: it came from ${new URL(response.url).origin}, not ${ALLOWED_ORIGIN}`,
  );
  process.exit(1);
}

const declared = Number(response.headers.get("content-length") ?? 0);
if (declared > MAX_BYTES) {
  console.error(`Refusing the response: ${declared} bytes exceeds the ${MAX_BYTES} byte ceiling`);
  process.exit(1);
}

const raw = await response.text();
if (raw.length > MAX_BYTES) {
  console.error(`Refusing the response: ${raw.length} bytes exceeds the ${MAX_BYTES} byte ceiling`);
  process.exit(1);
}

// Parse before writing: a Cloudflare interstitial is a 200 with an HTML body,
// and overwriting a good spec with one would be worse than failing.
let parsed;
try {
  parsed = JSON.parse(raw);
  if (!parsed.paths || typeof parsed.paths !== "object") {
    throw new Error("no `paths` object — this is not the OpenAPI document");
  }
  if (!parsed.components?.schemas) throw new Error("no `components.schemas`");
} catch (error) {
  console.error(`The response was not the spec: ${error.message}`);
  process.exit(1);
}

// Serialised from the parsed object rather than written through from the
// socket, so the bytes on disk are JSON this script has already validated
// rather than whatever arrived. The hash below is taken from these same bytes,
// which is what check-endpoints verifies.
const text = JSON.stringify(parsed);

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
