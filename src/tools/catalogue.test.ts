/**
 * Invariants that must hold for every tool in the catalogue, checked by
 * walking the catalogue rather than by naming tools one at a time.
 *
 * The motivation is a counted gap: at 111 tools, 40 of them appeared in no
 * test file at all. Hand-writing 40 near-identical cases would have closed the
 * count and not the risk — the next family would reopen it. A test that
 * enumerates allTools covers every tool that exists now and every tool added
 * later, and fails on the day one is added that breaks the house rules.
 *
 * These are structural checks, not behavioural ones. A family whose requests
 * need asserting still gets its own test file; this is the floor, not the
 * ceiling.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { allTools } from "../server.js";
import { TOOLSETS } from "../toolsets.js";
import { connectTools, stubClient } from "./test-support.js";

const tools = allTools;

describe("the tool catalogue", () => {
  it("is not empty, so a broken export cannot make every check below vacuous", () => {
    assert.ok(tools.length > 100, `expected the full catalogue, got ${tools.length}`);
  });

  it("gives every tool a unique jsm_-prefixed name", () => {
    const seen = new Set<string>();
    for (const tool of tools) {
      assert.match(tool.name, /^jsm_[a-z0-9_]+$/, `${tool.name}: not a valid tool name`);
      assert.ok(!seen.has(tool.name), `${tool.name} is registered twice`);
      seen.add(tool.name);
    }
  });

  it("puts every tool in a real toolset", () => {
    for (const tool of tools) {
      assert.ok(
        (TOOLSETS as readonly string[]).includes(tool.toolset),
        `${tool.name}: toolset '${tool.toolset}' is not in TOOLSETS`,
      );
    }
  });

  it("declares an endpoint for every tool, which is what the drift guard reads", () => {
    for (const tool of tools) {
      for (const endpoint of [tool.endpoint].flat()) {
        assert.ok(endpoint, `${tool.name}: no endpoint declared`);
        assert.match(
          endpoint.method,
          /^(GET|POST|PATCH|PUT|DELETE)$/,
          `${tool.name}: odd method ${endpoint.method}`,
        );
        assert.match(endpoint.path, /^\/v1\//, `${tool.name}: path should start /v1/`);
      }
    }
  });

  it("writes a description in the house style", () => {
    for (const tool of tools) {
      assert.ok(tool.description.length > 80, `${tool.name}: description is too thin to be useful`);
      assert.match(tool.description, /Args:/, `${tool.name}: no Args: block`);
      assert.match(tool.description, /Returns/, `${tool.name}: does not say what it returns`);
    }
  });

  it("keeps annotations honest about reading and writing", () => {
    for (const tool of tools) {
      const annotations = tool.annotations;
      assert.ok(annotations, `${tool.name}: no annotations`);
      assert.equal(typeof annotations.readOnlyHint, "boolean", `${tool.name}: no readOnlyHint`);

      if (annotations.readOnlyHint) {
        // A read-only tool that can write is the failure mode that matters:
        // clients auto-approve on this flag.
        assert.ok(
          !annotations.destructiveHint,
          `${tool.name}: claims readOnlyHint and destructiveHint at once`,
        );
        for (const endpoint of [tool.endpoint].flat()) {
          assert.equal(
            endpoint?.method,
            "GET",
            `${tool.name}: readOnlyHint but issues ${endpoint?.method}`,
          );
        }
      }
    }
  });

  it("declares an output schema on every tool, or the SDK rejects the result", () => {
    for (const tool of tools) {
      assert.ok(tool.outputSchema, `${tool.name}: no outputSchema`);
      assert.ok(
        Object.keys(tool.outputSchema).length > 0,
        `${tool.name}: outputSchema declares no fields`,
      );
    }
  });

  it("registers all of them over a real MCP connection", async () => {
    // The end-to-end half: every input and output shape goes through the
    // SDK's own JSON Schema conversion. A shape the SDK cannot convert fails
    // here rather than on the first live call.
    const { client } = stubClient({ items: [] });
    const mcp = await connectTools(tools, client);
    const listed = await mcp.listTools();

    assert.equal(listed.tools.length, tools.length);
    for (const tool of listed.tools) {
      assert.equal(tool.inputSchema.type, "object", `${tool.name}: input schema is not an object`);
      assert.ok(tool.outputSchema, `${tool.name}: no output schema survived registration`);
      assert.equal(
        (tool.inputSchema as { additionalProperties?: boolean }).additionalProperties,
        false,
        `${tool.name}: lost additionalProperties:false, so invented arguments pass silently`,
      );
    }
  });
});
