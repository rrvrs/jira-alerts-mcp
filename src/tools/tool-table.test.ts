/**
 * TOOLS.md has to list every tool this server registers.
 *
 * There was already a test asserting the alert read tools by name, which is the
 * same idea done narrowly: it caught the attachment tools, but it would not have
 * caught a new write tool, and it went stale as a list of names in a second
 * place. This checks the actual document instead, so the table cannot quietly
 * fall behind the catalogue.
 *
 * The two halves read different files on purpose. Completeness is TOOLS.md's
 * job alone — a name that appears only in README prose must not satisfy it, or
 * moving the table out of the README would have left this passing against a
 * document with no table in it. Staleness is both files' problem: the README
 * still names a dozen tools in passing, and those references should break loudly
 * too when a tool is removed.
 *
 * Both halves read the COMPOSED list rather than `allTools`, because some tools
 * are built per process and so are not in the catalogue: jsm_list_capabilities
 * and code mode's four dispatchers all have descriptions that report what this
 * install can reach. The staleness half used to allow jsm_list_capabilities by
 * name, which worked while it was the only one — and would have rejected
 * jsm_call as "a tool this server does not register" the moment it was
 * documented.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { JsmClient, loadConfig } from "../services/client.js";
import { allTools, composeTools } from "../server.js";
import { CODE_TOOL_NAMES } from "./code/index.js";
import { resolveSelection } from "../toolsets.js";

const read = (name: string): string =>
  readFileSync(new URL(`../../${name}`, import.meta.url), "utf8");

const tools = read("TOOLS.md");
const prose = `${tools}\n${read("README.md")}`;

/**
 * Every name this server can register, under any selection.
 *
 * `code` is the widest: it composes the four dispatchers and the capabilities
 * tool on top of the catalogue, and no selection registers a name outside this
 * union.
 */
const registrable = (): string[] => {
  const client = new JsmClient(
    loadConfig({ JSM_CLOUD_ID: "cloud-id", JSM_OAUTH_TOKEN: "bearer" } as NodeJS.ProcessEnv),
  );
  const composed = composeTools(
    client,
    resolveSelection(allTools, { env: { JSM_TOOLSETS: "code" } }),
  );
  // CODE_TOOL_NAMES is unioned in because what composeTools registers depends
  // on the runtime: jsm_run is absent on Node 24, and the docs still describe
  // it, correctly. Without this the Node 24 leg of CI would call TOOLS.md stale
  // for documenting a tool that exists.
  return [...new Set([...[...allTools, ...composed].map((tool) => tool.name), ...CODE_TOOL_NAMES])];
};

describe("the tool table", () => {
  it("lists every registered tool", () => {
    const missing = registrable().filter((name) => !tools.includes(`\`${name}\``));

    assert.deepEqual(missing, [], "these tools are registered but absent from TOOLS.md");
  });

  it("does not name tools that no longer exist", () => {
    const known = new Set(registrable());
    const mentioned = [...prose.matchAll(/`(jsm_[a-z_]+)`/g)].map((match) => match[1] as string);
    const unknown = [...new Set(mentioned)].filter((name) => !known.has(name));

    assert.deepEqual(unknown, [], "the docs name tools this server does not register");
  });
});
