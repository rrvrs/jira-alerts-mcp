/**
 * The wire snapshot: what a client actually receives, pinned.
 *
 * Every other test in this suite watches one tool, or asserts a house rule
 * across the catalogue. None of them watched the whole registered surface, so a
 * refactor of the request path could change a description, drop an
 * `additionalProperties`, re-order an enum or lose the schema-dialect rewrite,
 * and the suite would stay green while every existing install saw a different
 * tool list.
 *
 * That gap matters now because code mode rebuilds how all ~94 tools issue their
 * requests (the `plan` field in tools/define.ts). This file is the guard that
 * makes that refactor reviewable: a diff in fixtures/ is a diff in what clients
 * see, and it has to be deliberate.
 *
 * Regenerating is a decision, not a fix:
 *   node --import tsx scripts/snapshot-tools.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { allTools, buildServer } from "./server.js";
import { JsmClient, loadConfig } from "./services/client.js";
import { sandboxSupport } from "./tools/code/child-engine.js";
import { CODE_TOOL_NAMES } from "./tools/code/index.js";
import { PROFILE_NAMES, TOOLSETS, resolveSelection } from "./toolsets.js";

const REGENERATE = "node --import tsx scripts/snapshot-tools.mjs";

interface WireEntry {
  title: string | null;
  description: string;
  inputSchema: unknown;
  outputSchema: unknown;
  annotations: unknown;
}

function fixture<T>(name: string): T {
  const path = new URL(`../fixtures/${name}`, import.meta.url);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/**
 * jsm_run is registered only where its sandbox can be trusted, which is Node 25
 * and later. The fixture is written on such a runtime; on Node 24 the server
 * correctly does not register the tool, and the expectation has to say so or
 * this suite would fail for doing the right thing.
 */
const RUNS_SCRIPTS = sandboxSupport().supported;
const present = (name: string) => RUNS_SCRIPTS || name !== "jsm_run";

const expectedWire = Object.fromEntries(
  Object.entries(fixture<Record<string, WireEntry>>("tools-wire.json")).filter(([name]) =>
    present(name),
  ),
);
const expectedProfiles = Object.fromEntries(
  Object.entries(fixture<Record<string, string[]>>("profiles.json")).map(([profile, names]) => [
    profile,
    names.filter(present),
  ]),
);

const client = new JsmClient(
  loadConfig({ JSM_CLOUD_ID: "cloud-id", JSM_OAUTH_TOKEN: "bearer" } as NodeJS.ProcessEnv),
);

/**
 * Goes through buildServer rather than registerTools, so the listing carries
 * the schema-dialect rewrite withModernDialect applies on the way out — a
 * wire-only detail that a definition-level listing would miss, and the one a
 * strict client rejects the whole server over.
 */
async function listTools(names: string): Promise<Array<Record<string, unknown>>> {
  const selection = resolveSelection(allTools, { env: { JSM_TOOLSETS: names } });
  const server = buildServer(client, selection);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "compat", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  try {
    return (await mcp.listTools()).tools as unknown as Array<Record<string, unknown>>;
  } finally {
    await mcp.close();
    await server.close();
  }
}

describe("the registered wire surface", () => {
  it("matches the snapshot, tool by tool", async () => {
    const listed = await listTools([...TOOLSETS].join(","));
    // Plus code mode's dispatchers, which no toolset selection registers.
    const names = new Set(listed.map((tool) => tool.name));
    for (const tool of await listTools("code")) {
      if (!names.has(tool.name as string)) listed.push(tool);
    }

    const actual: Record<string, WireEntry> = {};
    for (const tool of listed) {
      actual[tool.name as string] = {
        title: (tool.title as string | undefined) ?? null,
        description: tool.description as string,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema ?? null,
        annotations: tool.annotations ?? null,
      };
    }

    // Compared per tool rather than as one object: a whole-object deepEqual on
    // 270KB of schemas reports "objects are not equal" and leaves you bisecting
    // by hand. The failure should name the tool.
    const added = Object.keys(actual).filter((name) => !(name in expectedWire));
    const removed = Object.keys(expectedWire).filter((name) => !(name in actual));
    assert.deepEqual(added, [], `tools not in the snapshot — if intended, run: ${REGENERATE}`);
    assert.deepEqual(
      removed,
      [],
      `tools missing from the server — if intended, run: ${REGENERATE}`,
    );

    for (const [name, expected] of Object.entries(expectedWire)) {
      assert.deepEqual(
        actual[name],
        expected,
        `${name}: its registered entry changed. Clients see this. If intended, run: ${REGENERATE}`,
      );
    }
  });

  it("resolves each profile to the same tools as the snapshot", async () => {
    for (const profile of PROFILE_NAMES) {
      const names = (await listTools(profile)).map((tool) => tool.name as string).sort();
      assert.deepEqual(
        names,
        expectedProfiles[profile],
        `profile '${profile}' resolves differently. If intended, run: ${REGENERATE}`,
      );
    }
  });

  it("covers every tool in the catalogue, or it is not a guard", () => {
    // A snapshot that silently stopped covering a family would pass forever.
    for (const tool of allTools) {
      assert.ok(tool.name in expectedWire, `${tool.name}: not in the snapshot. Run: ${REGENERATE}`);
    }
    for (const name of CODE_TOOL_NAMES.filter(present)) {
      assert.ok(name in expectedWire, `${name}: not in the snapshot. Run: ${REGENERATE}`);
    }
    assert.equal(
      Object.keys(expectedWire).length,
      allTools.length + 1 + CODE_TOOL_NAMES.filter(present).length,
      "expected the catalogue, jsm_list_capabilities and the code-mode dispatchers",
    );
  });
});
