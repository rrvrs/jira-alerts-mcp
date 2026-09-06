/**
 * The README's tool table has to list every tool this server registers.
 *
 * There was already a test asserting the alert read tools by name, which is the
 * same idea done narrowly: it caught the attachment tools, but it would not have
 * caught a new write tool, and it went stale as a list of names in a second
 * place. This checks the actual document instead, so the table cannot quietly
 * fall behind the catalogue.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { allTools } from "../server.js";

const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");

describe("the README tool table", () => {
  it("lists every registered tool", () => {
    const missing = allTools
      .map((tool) => tool.name)
      .filter((name) => !readme.includes(`\`${name}\``));

    assert.deepEqual(missing, [], "these tools are registered but absent from the README");
  });

  it("does not list tools that no longer exist", () => {
    const known = new Set([...allTools.map((tool) => tool.name), "jsm_list_capabilities"]);
    const mentioned = [...readme.matchAll(/`(jsm_[a-z_]+)`/g)].map((match) => match[1] as string);
    const unknown = [...new Set(mentioned)].filter((name) => !known.has(name));

    assert.deepEqual(unknown, [], "the README names tools this server does not register");
  });
});
