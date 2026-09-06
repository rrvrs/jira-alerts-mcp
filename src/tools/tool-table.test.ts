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
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { allTools } from "../server.js";

const read = (name: string): string =>
  readFileSync(new URL(`../../${name}`, import.meta.url), "utf8");

const tools = read("TOOLS.md");
const prose = `${tools}\n${read("README.md")}`;

describe("the tool table", () => {
  it("lists every registered tool", () => {
    const missing = allTools
      .map((tool) => tool.name)
      .filter((name) => !tools.includes(`\`${name}\``));

    assert.deepEqual(missing, [], "these tools are registered but absent from TOOLS.md");
  });

  it("does not name tools that no longer exist", () => {
    const known = new Set([...allTools.map((tool) => tool.name), "jsm_list_capabilities"]);
    const mentioned = [...prose.matchAll(/`(jsm_[a-z_]+)`/g)].map((match) => match[1] as string);
    const unknown = [...new Set(mentioned)].filter((name) => !known.has(name));

    assert.deepEqual(unknown, [], "the docs name tools this server does not register");
  });
});
