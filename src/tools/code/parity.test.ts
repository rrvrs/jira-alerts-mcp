/**
 * Every tool's `plan` describes a request that tool actually makes.
 *
 * This is the test that buys the right to trust `plan` at all. A plan is a
 * second description of a request, and this repo's hardest-won lesson is that a
 * second description which can drift from the code is worth nothing — it is the
 * argument `define.ts` makes for the `endpoint` manifest, and the reason
 * check-endpoints.mjs exists. A plan that says `GET /v1/alerts` while its
 * handler sends `GET /v1/alerts/` would be invisible offline and wrong against
 * a tenant.
 *
 * So rather than reviewing ninety-four pairs by eye: drive the classic tool
 * through a recording client, compute the plan from the same arguments, and
 * assert the handler issued the request the plan describes. One test, every
 * tool, and every tool added later.
 *
 * For the fifty-six family-generated tools the handler consumes its own plan,
 * so this currently holds by construction. That is the point — it holds, and it
 * keeps holding if someone splits them apart again. For the hand-written tools
 * the plan is written separately, and this is the only thing standing between a
 * copy-paste and a wrong path in production.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { allTools } from "../../server.js";
import type { AnyToolDefinition, RequestPlan } from "../define.js";
import { callTool, connectTools, stubClient, type StubClient } from "../test-support.js";
import { ARG_OVERRIDES, minimalArgs } from "./test-support.js";

/** A recorded call, reduced to the four fields a plan describes. */
interface Observed {
  method: string;
  path: string;
  params: Record<string, unknown>;
  body: unknown;
}

/**
 * Drops undefined-valued keys.
 *
 * axios drops them on the wire, and exactOptionalPropertyTypes means both sides
 * may carry them, so comparing them would fail on a difference no server ever
 * sees.
 */
function defined(params: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function observe(stub: StubClient): Observed[] {
  return stub.calls.map((call) => ({
    // getCollection and getOne record no method because they are always GETs.
    method: call.method ?? "GET",
    path: call.path,
    params: defined(call.params),
    body: call.body,
  }));
}

function describePlan(plan: RequestPlan): Observed {
  return {
    method: plan.method,
    path: plan.path,
    params: defined(plan.params),
    body: plan.body,
  };
}

/** Runs the classic tool the way a client does, and returns what it requested. */
async function requestsMadeBy(
  tool: AnyToolDefinition,
  args: Record<string, unknown>,
): Promise<Observed[]> {
  // A single empty page is enough: this asserts what was requested, not what
  // came back. A handler that throws on an empty response has still recorded
  // its call by then, which is why the call is tolerated below.
  const stub = stubClient({ items: [] }, { write: {} });
  const mcp = await connectTools([tool], stub.client);
  try {
    await callTool(mcp, tool.name, args);
  } catch {
    // An output-validation rejection against stub data is not this test's
    // subject. The recorded calls are.
  } finally {
    await mcp.close();
  }
  return observe(stub);
}

const planned = allTools.filter((tool) => tool.plan);

describe("a tool's plan and its handler", () => {
  it("covers a meaningful share of the catalogue, or this sweep proves little", () => {
    // A guard on the guard: if `plan` were dropped from the factory, every
    // assertion below would vacuously pass over an empty list.
    assert.ok(
      planned.length >= 56,
      `only ${planned.length} of ${allTools.length} tools declare a plan`,
    );
  });

  for (const tool of planned) {
    it(`agree for ${tool.name}`, async () => {
      const args = minimalArgs(tool.inputSchema, ARG_OVERRIDES[tool.name] ?? {});
      const result = await check(tool, args);
      assert.equal(result.ok, true, result.detail);
    });
  }
});

/** Why a tool's plan could not be matched against a request it made. */
interface CheckResult {
  ok: boolean;
  detail: string;
}

/**
 * Drives the tool and reports whether its plan describes a request it issued.
 *
 * Returns a verdict rather than asserting, so the override check below can ask
 * the same question of the same tool without the override and compare answers.
 */
async function check(tool: AnyToolDefinition, args: Record<string, unknown>): Promise<CheckResult> {
  // Parsed, not raw: the handler is given parsed params with defaults applied,
  // and so is `plan`. Comparing against raw args would compare a request nobody
  // makes.
  const parsedResult = z.strictObject(tool.inputSchema).safeParse(args);
  if (!parsedResult.success) {
    return {
      ok: false,
      detail: `${tool.name}: synthesised arguments fail its own schema — ${parsedResult.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    };
  }

  const expected = describePlan(tool.plan!(parsedResult.data as Record<string, unknown>));
  const observed = await requestsMadeBy(tool, args);

  if (observed.length === 0) {
    return {
      ok: false,
      detail: `${tool.name}: its handler issued no request, so the plan describes nothing`,
    };
  }

  // Matched by path rather than by position: a list tool with `prepare` resolves
  // team names first, and jsm_get_alert reaches two endpoints.
  const matching = observed.filter((call) => call.path === expected.path);
  if (matching.length === 0) {
    return {
      ok: false,
      detail:
        `${tool.name}: the plan says ${expected.method} ${expected.path}, but the handler ` +
        `requested ${observed.map((call) => `${call.method} ${call.path}`).join(", ")}`,
    };
  }

  const agreed = matching.some((call) => {
    try {
      assert.deepEqual(call, expected);
      return true;
    } catch {
      return false;
    }
  });

  return {
    ok: agreed,
    detail: agreed
      ? "matched"
      : `${tool.name}: the plan and the request differ.\n  plan:      ${JSON.stringify(expected)}\n  requested: ${matching.map((call) => JSON.stringify(call)).join("\n             ")}`,
  };
}

describe("the argument overrides", () => {
  for (const [name, overrides] of Object.entries(ARG_OVERRIDES)) {
    it(`${name} still needs one`, async () => {
      // An override that is no longer necessary is a fact stated twice, and the
      // copy in the test file is the one that goes stale — the rule the endpoint
      // manifest applies to allowUnknownQuery, applied to fixtures.
      //
      // "Needed" is asked as the question that matters rather than as "does the
      // schema reject it": jsm_update_alert_field's override exists because the
      // *handler* refuses a non-priority value locally, which the schema cannot
      // express and so cannot reject. Asking whether the sweep can verify the
      // tool without the override covers both causes and invents neither.
      const tool = allTools.find((candidate) => candidate.name === name);
      assert.ok(tool, `ARG_OVERRIDES names '${name}', which is not a tool any more`);
      assert.ok(tool.plan, `ARG_OVERRIDES names '${name}', which has no plan to verify`);

      const withoutOverride = await check(tool, minimalArgs(tool.inputSchema));
      assert.equal(
        withoutOverride.ok,
        false,
        `ARG_OVERRIDES['${name}'] is no longer needed: the sweep verifies this tool without ` +
          `it. Remove it. (overrode: ${Object.keys(overrides).join(", ")})`,
      );
    });
  }
});
