import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { allTools } from "../../server.js";
import { createRegistry, toCodeName } from "./registry.js";

const everything = () => createRegistry(allTools, new Set(allTools.map((tool) => tool.name)));

describe("toCodeName", () => {
  it("strips the prefix and camelCases the rest", () => {
    assert.equal(toCodeName("jsm_list_alerts"), "listAlerts");
    assert.equal(toCodeName("jsm_get_next_on_call"), "getNextOnCall");
    assert.equal(toCodeName("jsm_add_alert_extra_properties"), "addAlertExtraProperties");
  });

  it("is mechanical, so code names inherit tool names' stability", () => {
    // Nothing hand-maintained means nothing to drift. A rename of a tool is a
    // rename of its code name, and both are breaking.
    for (const tool of allTools) {
      assert.equal(toCodeName(tool.name), toCodeName(tool.name));
      assert.match(toCodeName(tool.name), /^[a-z][A-Za-z0-9]*$/, `${tool.name}: odd code name`);
    }
  });
});

describe("createRegistry", () => {
  it("gives every tool exactly one operation, with a unique code name", () => {
    // A collision would make one of the two unreachable, silently.
    const registry = everything();
    assert.equal(registry.all().length, allTools.length);
    const names = registry.all().map((operation) => operation.codeName);
    assert.equal(new Set(names).size, names.length, "two tools share a code name");
  });

  it("resolves an operation by either name", () => {
    const registry = everything();
    assert.equal(registry.find("listAlerts")?.toolName, "jsm_list_alerts");
    assert.equal(registry.find("jsm_list_alerts")?.codeName, "listAlerts");
    assert.equal(registry.find("nope"), undefined);
  });

  it("classifies read, write and destructive from the annotations", () => {
    const registry = everything();
    assert.equal(registry.find("listAlerts")?.kind, "read");
    assert.equal(registry.find("acknowledgeAlert")?.kind, "write");
    assert.equal(registry.find("deleteAlert")?.kind, "destructive");
  });

  it("holds the whole catalogue but marks what this process cannot dispatch", () => {
    // The split exists because a model that cannot find an operation tells the
    // user the server cannot do it. Searching wider than we dispatch, and
    // saying which is which, is what prevents that.
    const registry = createRegistry(allTools, new Set(["jsm_list_alerts"]));
    assert.equal(registry.all().length, allTools.length);
    assert.deepEqual(
      registry.reachable().map((operation) => operation.codeName),
      ["listAlerts"],
    );

    const hidden = registry.find("listSchedules");
    assert.equal(hidden?.available, false);
    // The same wording jsm_list_capabilities uses, so the two never disagree
    // about how to turn a family on.
    assert.match(hidden?.unavailableReason ?? "", /adding 'oncall' to the JSM_TOOLSETS/);
    assert.match(hidden?.unavailableReason ?? "", /restarting it/);
  });

  it("marks as pageable exactly the collections that can serve a later page", () => {
    const registry = everything();
    // GET /v1/teams and GET /v1/teams/{id}/roles accept no paging parameters at
    // all, so advertising a listAll* form for them would loop forever on a
    // full-looking first page — the reason paging.ts has a `none` dialect.
    assert.equal(registry.find("listAlerts")?.pageable, true);
    assert.equal(registry.find("listTeams")?.pageable, false);
    assert.equal(registry.find("listTeamRoles")?.pageable, false);
    assert.equal(registry.find("acknowledgeAlert")?.pageable, false);
    // A composite has no plan, so nothing can page it.
    assert.equal(registry.find("getScheduleTimeline")?.pageable, false);
  });

  it("takes each summary from the description's first line, verbatim", () => {
    const registry = everything();
    for (const operation of registry.all()) {
      const firstLine = operation.tool.description.split("\n", 1)[0]?.trim();
      assert.equal(operation.summary, firstLine, `${operation.codeName}: summary was rewritten`);
      assert.ok(operation.summary.length > 0);
    }
  });

  it("builds a declaration lazily and only once", () => {
    const registry = everything();
    const operation = registry.find("listAlerts");
    assert.ok(operation);
    const first = operation.declaration();
    assert.equal(operation.declaration(), first, "declaration should be memoised");
    assert.match(first, /query\?: string;/);
  });

  it("keeps the reachable index small enough to embed in a description", () => {
    // It rides in jsm_call's description so the common case needs no discovery
    // round trip. The threshold to move it out is about 8,000 characters.
    const index = everything().index();
    assert.equal(index.length, allTools.length);
    assert.deepEqual([...index].sort(), index, "the index must be sorted");
    assert.ok(index.join(", ").length < 8_000, `index is ${index.join(", ").length} chars`);
  });
});

describe("registry search", () => {
  const registry = everything();
  const names = (query: string, limit = 4) =>
    registry.search({ query, limit }).map((operation) => operation.codeName);

  it("ranks an exact and prefix name match above a description mention", () => {
    assert.equal(names("listAlerts")[0], "listAlerts");
    assert.ok(names("rout").every((name) => name.toLowerCase().includes("rout")));
  });

  it("matches a multi-word query against a camelCase name", () => {
    // A code name has no separators, so "on call" found nothing in `getoncall`
    // and the results came back ranked by whichever descriptions mentioned the
    // phrase — createOverride and assignAlert ahead of getOnCall.
    const hits = names("on call");
    assert.ok(hits.includes("getOnCall"), `got ${hits.join(", ")}`);
    assert.ok(hits.indexOf("getOnCall") < 2, `getOnCall ranked ${hits.indexOf("getOnCall")}`);
  });

  it("searches titles, which are sometimes the only plain statement of the job", () => {
    assert.equal(names("reorder")[0], "changeRoutingRuleOrder");
  });

  it("narrows on a second term rather than widening", () => {
    // Both terms must appear, so "routing rule" cannot match everything that
    // matches "rule". Tools whose long descriptions happen to mention both are
    // still hits — correctly, since they do — but they rank below the ones
    // named for it, which is what the tiers are for.
    const rules = names("routing rule", 10);
    const named = rules.filter((name) => name.includes("Routing"));
    assert.equal(named.length, 6, `expected the six routing-rule tools, got ${rules.join(", ")}`);
    assert.deepEqual(rules.slice(0, 6), named, "the named ones must rank first");
  });

  it("falls back to any-term matching when every-term finds nothing", () => {
    // A model may type a question. "who gets notified" contains a word no
    // operation has, and strict matching returned an empty list.
    assert.ok(names("who gets notified").length > 0);
  });

  it("filters by toolset and by kind", () => {
    const reads = registry.search({ toolset: "alert-actions", kind: "read" });
    assert.deepEqual(reads, [], "every alert action writes");

    const writes = registry.search({ toolset: "alert-actions", kind: "write" });
    assert.ok(writes.length > 0);
    assert.ok(writes.every((operation) => operation.kind !== "read"));
  });

  it("returns everything, sorted, for an empty query", () => {
    const all = registry.search({});
    assert.equal(all.length, allTools.length);
    assert.deepEqual(
      all.map((operation) => operation.codeName),
      [...all.map((operation) => operation.codeName)].sort(),
    );
  });

  it("honours the limit", () => {
    assert.equal(registry.search({ limit: 3 }).length, 3);
  });
});
