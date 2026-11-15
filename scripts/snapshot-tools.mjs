#!/usr/bin/env node
/**
 * Writes the wire snapshot that guards refactors of the request path.
 *
 * Code mode rebuilds how every one of the ~94 tools issues its request (see the
 * `plan` field in src/tools/define.ts). That is a large change to a surface no
 * offline test watched as a whole: the suite asserted that individual tools
 * behave, and that the catalogue obeys house rules, but nothing pinned the bytes
 * a client actually receives. So a refactor could alter a description, drop an
 * `additionalProperties`, or re-order an enum, and the suite would stay green
 * while every existing install saw a different tool list.
 *
 * Two artifacts, each guarding one thing and neither duplicating the other:
 *
 *   tools-wire.json   every tool's registered entry, keyed by name. Guards what
 *                     one tool looks like on the wire.
 *   profiles.json     each profile's sorted tool names. Guards which tools a
 *                     selection resolves to — the thing toolsets.ts exists for.
 *
 * Regenerate deliberately, never to make a test pass: a diff here is a change to
 * what every client sees, and reviewing it is the point.
 */

import { writeFileSync } from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { allTools, buildServer } from "../src/server.ts";
import { JsmClient, loadConfig } from "../src/services/client.ts";
import { sandboxSupport } from "../src/tools/code/child-engine.ts";
import { PROFILE_NAMES, TOOLSETS, resolveSelection } from "../src/toolsets.ts";

/** Enough to construct a client. tools/list issues no request. */
const client = new JsmClient(loadConfig({ JSM_CLOUD_ID: "cloud-id", JSM_OAUTH_TOKEN: "bearer" }));

/**
 * Lists tools the way a client does — through buildServer, so the snapshot
 * includes the schema-dialect rewrite that withModernDialect applies on the way
 * out. Listing from the definitions instead would miss it, which is exactly the
 * kind of wire-only detail this file exists to pin.
 */
async function listTools(names) {
  const selection = resolveSelection(allTools, { env: { JSM_TOOLSETS: names } });
  const server = buildServer(client, selection);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "snapshot", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  try {
    return (await mcp.listTools()).tools;
  } finally {
    await mcp.close();
    await server.close();
  }
}

/** Every toolset by name, so all 94 tools appear exactly once. */
const everything = await listTools([...TOOLSETS].join(","));

// Code mode's dispatchers are built per process, so no toolset selection
// registers them — and for a while that meant the tools a code-mode install
// actually shows were the only ones this snapshot did not pin. Their
// descriptions carry the operation index and the budgets, which is exactly the
// kind of thing that changes without anyone meaning it to.
const seen = new Set(everything.map((tool) => tool.name));
for (const tool of await listTools("code")) {
  if (!seen.has(tool.name)) everything.push(tool);
}

if (!sandboxSupport().supported) {
  console.error(
    "Refusing to write the snapshot: this Node cannot register jsm_run, so the fixture " +
      "would silently lose it. Regenerate on Node 25 or later.",
  );
  process.exit(1);
}

const wire = {};
for (const tool of everything.sort((a, b) => a.name.localeCompare(b.name))) {
  wire[tool.name] = {
    title: tool.title ?? null,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema ?? null,
    annotations: tool.annotations ?? null,
  };
}

const profiles = {};
for (const name of PROFILE_NAMES) {
  profiles[name] = (await listTools(name)).map((tool) => tool.name).sort();
}

const write = (file, value) => {
  const path = new URL(`../fixtures/${file}`, import.meta.url);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  console.log(`wrote fixtures/${file}`);
};

write("tools-wire.json", wire);
write("profiles.json", profiles);

console.log(`${Object.keys(wire).length} tools, ${Object.keys(profiles).length} profiles`);
