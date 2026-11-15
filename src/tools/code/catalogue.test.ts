/**
 * House rules for the data layer, checked by walking the catalogue.
 *
 * Deliberately separate from tools/catalogue.test.ts: that file's subject is
 * what a tool advertises to a client, this one's is the request it issues. The
 * two go stale for different reasons and a reader looking for one should not
 * have to skim the other.
 *
 * The load-bearing check is the first: a plan's method and path have to match
 * an endpoint the tool declares. `endpoint` is already checked against the
 * vendored OpenAPI spec by scripts/check-endpoints.mjs, so matching plans to it
 * makes every plan transitively spec-checked — a wrong path fails in CI rather
 * than against somebody's tenant — with no second manifest to keep honest.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { allTools } from "../../server.js";
import type { EndpointDeclaration, RequestPlan } from "../define.js";
import { DEFAULT_DIALECT, pagingQueryNames } from "../paging.js";
import { ARG_OVERRIDES, minimalArgs } from "./test-support.js";

/**
 * Whether a real path fits a declared template.
 *
 * Segment by segment rather than by regex, so `/v1/alerts/alias` — a literal
 * segment where a sibling endpoint has `{id}` — cannot be satisfied by an id.
 * That pair is real: jsm_get_alert declares both.
 */
function fitsTemplate(actual: string, template: string): boolean {
  const actualSegments = actual.split("/");
  const templateSegments = template.split("/");
  if (actualSegments.length !== templateSegments.length) return false;

  return templateSegments.every((segment, index) => {
    const value = actualSegments[index];
    return segment.startsWith("{") && segment.endsWith("}")
      ? (value?.length ?? 0) > 0
      : segment === value;
  });
}

function declarations(tool: { endpoint?: EndpointDeclaration | EndpointDeclaration[] }) {
  return [tool.endpoint].flat().filter((entry): entry is EndpointDeclaration => Boolean(entry));
}

/** The declaration a plan claims to implement, or undefined when none fits. */
function declarationFor(
  plan: RequestPlan,
  endpoints: EndpointDeclaration[],
): EndpointDeclaration | undefined {
  return endpoints.find(
    (endpoint) => endpoint.method === plan.method && fitsTemplate(plan.path, endpoint.path),
  );
}

function planOf(tool: (typeof allTools)[number]): RequestPlan {
  const args = minimalArgs(tool.inputSchema, ARG_OVERRIDES[tool.name] ?? {});
  const parsed = z.strictObject(tool.inputSchema).parse(args) as Record<string, unknown>;
  return tool.plan!(parsed);
}

const planned = allTools.filter((tool) => tool.plan);
const composite = allTools.filter((tool) => tool.fetch);

describe("the data layer", () => {
  it("covers every tool in the catalogue", () => {
    // Code mode dispatches over this. An operation with neither a plan nor a
    // fetch is one the code API cannot reach at all, which in code mode reads
    // as a capability this server does not have.
    const uncovered = allTools.filter((tool) => !tool.plan && !tool.fetch).map((t) => t.name);
    assert.deepEqual(uncovered, [], `${uncovered.length} tools have no data layer`);
  });

  it("never gives one tool both a plan and a fetch", () => {
    // They answer the same question, and two answers means one of them is the
    // one nobody maintains.
    const both = allTools.filter((tool) => tool.plan && tool.fetch).map((t) => t.name);
    assert.deepEqual(both, []);
  });

  it("keeps the fetch escape hatch to at most three tools", () => {
    // A fetch is not checkable against `endpoint`, so each one is a request
    // this suite cannot verify. Three is the number the API actually forces:
    // the two on-call lookups and the timeline. A fourth should have to argue
    // for itself in review rather than arrive quietly.
    assert.ok(
      composite.length <= 3,
      `${composite.length} tools use fetch: ${composite.map((t) => t.name).join(", ")}. ` +
        `Each is a request no test can check against the spec — prefer a plan.`,
    );
  });

  for (const tool of planned) {
    describe(tool.name, () => {
      const plan = planOf(tool);
      const endpoints = declarations(tool);

      it("plans a request it declares an endpoint for", () => {
        assert.ok(
          declarationFor(plan, endpoints),
          `plans ${plan.method} ${plan.path}, but declares only ` +
            `${endpoints.map((e) => `${e.method} ${e.path}`).join(", ")}. ` +
            `check:endpoints validates the declaration against the spec, so a plan that ` +
            `does not match one is a request nothing has checked.`,
        );
      });

      it("sends only query parameters its endpoint declares", () => {
        const endpoint = declarationFor(plan, endpoints);
        if (!endpoint) return; // reported by the test above

        const allowed = new Set([
          ...(endpoint.query ?? []),
          ...(endpoint.allowUnknownQuery ?? []),
          ...pagingQueryNames(plan.paging ?? DEFAULT_DIALECT),
        ]);
        const undeclared = Object.keys(plan.params ?? {}).filter((name) => !allowed.has(name));
        assert.deepEqual(
          undeclared,
          [],
          `sends ${undeclared.join(", ")}, which ${endpoint.method} ${endpoint.path} does not ` +
            `declare. Add them to the endpoint's 'query' so check:endpoints can check them ` +
            `against the spec.`,
        );
      });

      it("sends only body fields its endpoint declares", () => {
        const endpoint = declarationFor(plan, endpoints);
        if (!endpoint) return;

        const allowed = new Set([...(endpoint.body ?? []), ...(endpoint.allowUnknownBody ?? [])]);
        const undeclared = Object.keys(plan.body ?? {}).filter((name) => !allowed.has(name));
        assert.deepEqual(
          undeclared,
          [],
          `sends body fields ${undeclared.join(", ")}, which ${endpoint.method} ` +
            `${endpoint.path} does not declare.`,
        );
      });

      it("states a response shape consistent with its method", () => {
        // A GET that reports "empty" would make the dispatcher discard a body,
        // and a DELETE that reports "collection" would make it page a 204.
        if (plan.method === "GET") {
          assert.notEqual(plan.shape, "empty", "a GET returns something");
        }
        if (plan.shape === "collection") {
          assert.equal(plan.method, "GET", "only a GET is pageable");
        }
      });

      it("only claims a paging dialect on a collection", () => {
        if (plan.paging) {
          assert.equal(
            plan.shape,
            "collection",
            "a paging dialect on a non-collection would tell the auto-pager to page an object",
          );
        }
      });
    });
  }
});
