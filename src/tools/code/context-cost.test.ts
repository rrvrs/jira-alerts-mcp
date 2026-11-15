/**
 * The claim code mode is built on, measured rather than asserted.
 *
 * TOOLS.md and the README quote characters, and a number in prose is a number
 * that goes stale — this repo has the scars: the quickstart said "82 tools
 * rather than the 28" while the table beside it said 81 and 27.
 *
 * So the figures stay in the docs for persuasion, and the *claim* is pinned
 * here with room to move. A description growing by a few hundred characters
 * should not fail a build; code mode ceasing to be dramatically cheaper than
 * the tool list it replaces should.
 *
 * Run `npm run measure:context` for the current numbers.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { allTools, buildServer } from "../../server.js";
import { JsmClient, loadConfig } from "../../services/client.js";
import { resolveSelection, TOOLSETS } from "../../toolsets.js";
import { sandboxSupport } from "./child-engine.js";
import { createRegistry } from "./registry.js";

const client = new JsmClient(
  loadConfig({ JSM_CLOUD_ID: "cloud-id", JSM_OAUTH_TOKEN: "bearer" } as NodeJS.ProcessEnv),
);

async function cost(names: string): Promise<{ tools: number; chars: number }> {
  const selection = resolveSelection(allTools, { env: { JSM_TOOLSETS: names } });
  const server = buildServer(client, selection);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "cost", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  try {
    const listed = await mcp.listTools();
    return { tools: listed.tools.length, chars: JSON.stringify(listed.tools).length };
  } finally {
    await mcp.close();
    await server.close();
  }
}

describe("what code mode costs a client", () => {
  it("registers the dispatchers and jsm_list_capabilities", async () => {
    // Six where scripts can run, five where they cannot: jsm_run is withheld on
    // a Node whose permission model does not gate the network.
    const { tools } = await cost("code");
    assert.equal(tools, sandboxSupport().supported ? 6 : 5);
  });

  it("is at least 60% cheaper than the default tool list", async () => {
    const code = await cost("code");
    const responder = await cost("responder");
    const saving = 1 - code.chars / responder.chars;
    assert.ok(
      saving >= 0.6,
      `code mode is ${code.chars} chars against responder's ${responder.chars} — a ` +
        `${Math.round(saving * 100)}% cut. The documented claim is ~71%. If the dispatcher ` +
        `descriptions have grown this much, re-measure with 'npm run measure:context' and ` +
        `update TOOLS.md, or trim them.`,
    );
  });

  it("is at least 85% cheaper than every toolset named explicitly", async () => {
    const code = await cost("code");
    const everything = await cost([...TOOLSETS].join(","));
    const saving = 1 - code.chars / everything.chars;
    assert.ok(saving >= 0.85, `only a ${Math.round(saving * 100)}% cut against the full catalogue`);
  });

  it("reaches more operations than the default registers tools", async () => {
    // The point that makes the saving worth having: it is not a smaller surface
    // bought with a smaller capability. Code mode reaches every verified family
    // while the default loads three of them.
    const selection = resolveSelection(allTools, { env: { JSM_TOOLSETS: "code" } });
    const reachable = createRegistry(
      allTools,
      new Set(
        allTools
          .filter((tool) => (selection.codeToolsets as readonly string[]).includes(tool.toolset))
          .map((tool) => tool.name),
      ),
    ).reachable();

    const responder = resolveSelection(allTools, { env: { JSM_TOOLSETS: "responder" } });
    assert.ok(
      reachable.length > responder.tools.length * 2,
      `code mode reaches ${reachable.length} operations, responder registers ${responder.tools.length} tools`,
    );
  });

  it("does not reach a family that could not be verified", async () => {
    // `code` expands to the verified toolsets, exactly as `all` does. A mode
    // that quietly widened to everything would undo the rule toolsets.ts spends
    // its `unverified` mechanism enforcing.
    const selection = resolveSelection(allTools, { env: { JSM_TOOLSETS: "code" } });
    for (const quarantined of ["heartbeats", "attachments", "forwarding"]) {
      assert.ok(
        !(selection.codeToolsets as readonly string[]).includes(quarantined),
        `code mode reaches '${quarantined}', which no profile should`,
      );
    }
  });
});
