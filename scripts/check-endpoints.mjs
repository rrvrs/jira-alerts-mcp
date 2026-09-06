#!/usr/bin/env node
/**
 * Checks every endpoint a tool declares against the vendored OpenAPI spec.
 *
 * The test suite is deliberately offline, so it cannot catch a wrong path, a
 * parameter the API does not read, or a required body field a tool forgot. Those
 * fail only against a live tenant, and one of them has already shipped: every
 * list tool sent `limit` as the page size for months, which is not a parameter,
 * so the API served its own default and callers asking for 100 records were told
 * 20 was all of them. Nothing in a green suite said otherwise.
 *
 * What this asserts, per declared endpoint:
 *   1. the path exists in the spec (its /api/{cloudId} prefix stripped, and
 *      parameter names normalised positionally — {id} and {alertId} are the
 *      same slot);
 *   2. the method exists on it;
 *   3. every query name is declared on that operation, or listed in
 *      allowUnknownQuery;
 *   4. every body field is a property of the request body, or listed in
 *      allowUnknownBody;
 *   5. every field the spec marks required is present in the declaration.
 *
 * Coverage in the other direction is reported, never gated. Failing on
 * endpoints we have not implemented would break an unrelated PR every time
 * Atlassian adds one.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { allTools } from "../src/server.ts";

const read = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

const meta = read("spec/jsm-ops.meta.json");
const specText = readFileSync(new URL("../spec/jsm-ops.v3.json", import.meta.url), "utf8");
const spec = JSON.parse(specText);

const failures = [];
const expect = (condition, message) => {
  if (!condition) failures.push(message);
};

// A hand-edited spec could make any failure below disappear, so the file has to
// be the one the recorded URL served.
const actualHash = createHash("sha256").update(specText).digest("hex");
expect(
  actualHash === meta.sha256,
  `spec/jsm-ops.v3.json does not match the recorded sha256.\n` +
    `  recorded: ${meta.sha256}\n  actual:   ${actualHash}\n` +
    `  Re-run 'npm run spec:refresh', which rewrites both.`,
);

/** "/api/{cloudId}/v1/alerts/{id}" -> "/v1/alerts/{}" */
const normalise = (path) => path.replace(/^\/api\/\{cloudId\}/, "").replace(/\{[^}]+\}/g, "{}");

/** Every operation in the spec, keyed by normalised path then method. */
const operations = new Map();
for (const [path, methods] of Object.entries(spec.paths)) {
  const key = normalise(path);
  for (const [method, operation] of Object.entries(methods)) {
    if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
    if (!operations.has(key)) operations.set(key, new Map());
    operations.get(key).set(method.toUpperCase(), { operation, specPath: path });
  }
}

/** Resolves a $ref one level, which is as deep as request bodies go here. */
const deref = (schema) =>
  schema?.$ref ? spec.components.schemas[schema.$ref.split("/").pop()] : schema;

function requestBodySchema(operation) {
  const content = operation.requestBody?.content;
  if (!content) return undefined;
  return deref(Object.values(content)[0]?.schema);
}

const declared = [];
for (const tool of allTools) {
  if (!tool.endpoint) continue;
  for (const endpoint of [tool.endpoint].flat()) declared.push({ tool: tool.name, endpoint });
}

for (const { tool, endpoint } of declared) {
  const key = normalise(endpoint.path);
  const byMethod = operations.get(key);

  if (!byMethod) {
    expect(false, `${tool}: no such path in the spec — ${endpoint.path}`);
    continue;
  }

  const entry = byMethod.get(endpoint.method);
  if (!entry) {
    expect(
      false,
      `${tool}: ${endpoint.method} is not defined on ${endpoint.path} ` +
        `(the spec has ${[...byMethod.keys()].join(", ")})`,
    );
    continue;
  }

  const { operation } = entry;

  const specQuery = new Set(
    (operation.parameters ?? [])
      .map((parameter) =>
        parameter.$ref ? spec.components?.parameters?.[parameter.$ref.split("/").pop()] : parameter,
      )
      .filter((parameter) => parameter?.in === "query")
      .map((parameter) => parameter.name),
  );
  const allowedQuery = new Set(endpoint.allowUnknownQuery ?? []);

  for (const name of endpoint.query ?? []) {
    expect(
      specQuery.has(name) || allowedQuery.has(name),
      `${tool}: query parameter '${name}' is not declared on ${endpoint.method} ${endpoint.path}. ` +
        `The spec declares: ${[...specQuery].join(", ") || "(none)"}. ` +
        `Either it is wrong, or add it to allowUnknownQuery with a comment saying why.`,
    );
  }

  // An allowance that is no longer needed is a stale claim about the API, so
  // it fails too — otherwise these accumulate and stop meaning anything.
  for (const name of allowedQuery) {
    expect(
      !specQuery.has(name),
      `${tool}: allowUnknownQuery lists '${name}', but the spec declares it now. Drop the allowance.`,
    );
  }

  const bodySchema = requestBodySchema(operation);
  const specBody = new Set(Object.keys(bodySchema?.properties ?? {}));
  const allowedBody = new Set(endpoint.allowUnknownBody ?? []);

  for (const name of endpoint.body ?? []) {
    expect(
      specBody.has(name) || allowedBody.has(name),
      `${tool}: body field '${name}' is not declared on ${endpoint.method} ${endpoint.path}. ` +
        `The spec declares: ${[...specBody].join(", ") || "(no request body)"}. ` +
        `Either it is wrong, or add it to allowUnknownBody with a comment saying why.`,
    );
  }

  for (const name of allowedBody) {
    expect(
      !specBody.has(name),
      `${tool}: allowUnknownBody lists '${name}', but the spec declares it now. Drop the allowance.`,
    );
  }

  // The assertion that catches shipping a create tool without its one required
  // field — the failure that would only ever surface as a 422 on a live tenant.
  const sent = new Set(endpoint.body ?? []);
  for (const name of bodySchema?.required ?? []) {
    expect(
      sent.has(name),
      `${tool}: ${endpoint.method} ${endpoint.path} requires body field '${name}', ` +
        `which this tool does not send.`,
    );
  }
}

// --- Coverage report, never a gate -----------------------------------------

const implemented = new Set(
  declared.map(({ endpoint }) => `${endpoint.method} ${normalise(endpoint.path)}`),
);
const byTag = new Map();
for (const [path, methods] of Object.entries(spec.paths)) {
  for (const [method, operation] of Object.entries(methods)) {
    if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
    const tag = operation.tags?.[0] ?? "(untagged)";
    const stats = byTag.get(tag) ?? { total: 0, done: 0 };
    stats.total += 1;
    if (implemented.has(`${method.toUpperCase()} ${normalise(path)}`)) stats.done += 1;
    byTag.set(tag, stats);
  }
}

const totals = [...byTag.values()].reduce(
  (accumulator, stats) => ({
    total: accumulator.total + stats.total,
    done: accumulator.done + stats.done,
  }),
  { total: 0, done: 0 },
);

if (failures.length) {
  console.error("✗ endpoint check failed:\n");
  for (const failure of failures) console.error(`  - ${failure}\n`);
  process.exit(1);
}

console.log(`✓ ${declared.length} declared endpoints match the spec (fetched ${meta.fetchedAt})`);
console.log(`  coverage: ${totals.done}/${totals.total} operations`);
for (const [tag, stats] of [...byTag.entries()].sort((a, b) => b[1].done - a[1].done)) {
  if (!stats.done) continue;
  console.log(`    ${tag}: ${stats.done}/${stats.total}`);
}
