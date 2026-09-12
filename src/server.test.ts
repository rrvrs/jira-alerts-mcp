/**
 * Tests for what the server puts on the wire.
 *
 * These assert the advertised JSON Schema, not the Zod behind it, because that
 * is exactly the gap the draft-07 bug lived in: 356 tests passed, every offline
 * check was green, and no client could call a single tool. A test that only
 * reads tool.name from tools/list cannot see a dialect, so this one looks at
 * the schema objects themselves.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { SCHEMA_DIALECT } from "./services/schema-dialect.js";
import { allTools, buildServer } from "./server.js";
import { resolveSelection } from "./toolsets.js";
import { stubClient } from "./tools/test-support.js";

/**
 * Lists tools the way a real client does.
 *
 * Must go through buildServer: connectTools() calls registerTools directly and
 * would bypass the dialect correction, certifying a server nobody can use.
 */
async function listAdvertisedTools(env: NodeJS.ProcessEnv = {}) {
  const selection = resolveSelection(allTools, { env });
  const server = buildServer(stubClient().client, selection);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);

  const { tools } = await mcpClient.listTools();
  await mcpClient.close();
  return tools;
}

/** Walks a schema, yielding every [key, value] pair at any depth. */
function* entries(node: unknown): Generator<[string, unknown]> {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) yield* entries(item);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    yield [key, value];
    yield* entries(value);
  }
}

describe("advertised tool schemas", () => {
  it("declares the 2020-12 dialect on every input and output schema", async () => {
    const tools = await listAdvertisedTools();

    // Guards against a vacuous pass if selection ever resolves to nothing.
    assert.ok(tools.length > 0, "no tools advertised");

    for (const tool of tools) {
      assert.equal(
        tool.inputSchema?.$schema,
        SCHEMA_DIALECT,
        `${tool.name} inputSchema declares ${String(tool.inputSchema?.$schema)}`,
      );
      assert.equal(
        tool.outputSchema?.$schema,
        SCHEMA_DIALECT,
        `${tool.name} outputSchema declares ${String(tool.outputSchema?.$schema)}`,
      );
    }
  });

  it("uses no construct the two dialects read differently", async () => {
    // Rewriting $schema is only sound while this holds. If a schema ever gains
    // a $ref, definitions, a boolean exclusiveMinimum or tuple-form items, the
    // rewrite starts lying and this test is the warning.
    const tools = await listAdvertisedTools();

    for (const tool of tools) {
      for (const schema of [tool.inputSchema, tool.outputSchema]) {
        for (const [key, value] of entries(schema)) {
          assert.notEqual(key, "$ref", `${tool.name} uses $ref`);
          assert.notEqual(key, "definitions", `${tool.name} uses definitions`);
          if (key === "exclusiveMinimum" || key === "exclusiveMaximum") {
            assert.notEqual(typeof value, "boolean", `${tool.name} uses draft-07 ${key}`);
          }
          if (key === "items") {
            assert.ok(!Array.isArray(value), `${tool.name} uses tuple-form items`);
          }
        }
      }
    }
  });

  it("corrects the dialect for a narrowed selection too", async () => {
    const tools = await listAdvertisedTools({ JSM_TOOLSETS: "oncall" } as NodeJS.ProcessEnv);

    assert.ok(tools.length > 0, "no tools advertised");
    for (const tool of tools) {
      assert.equal(tool.outputSchema?.$schema, SCHEMA_DIALECT, tool.name);
    }
  });
});
