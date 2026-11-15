/**
 * Tool definition and registration.
 *
 * Each tool is a standalone module exporting one `defineTool(...)` value; a
 * domain's `index.ts` collects them into an array, and `registerTools` walks
 * that array. Keeping registration in one place is what lets a tool file stay
 * small enough to read in a sitting.
 */

import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { JsmClient } from "../services/client.js";
import type { ToolResult } from "../services/format.js";
import type { ToolGroup } from "../toolsets.js";
import type { CallContext } from "./code/context.js";
import type { PagingDialect } from "./paging.js";

/**
 * Behaviour hints clients use to decide what to auto-approve, so all four are
 * required rather than optional — an omitted `destructiveHint` reads as "not
 * destructive" and that should never be an accident.
 */
export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/**
 * What a tool actually calls, checked against the vendored OpenAPI spec by
 * scripts/check-endpoints.mjs.
 *
 * This is the same value the handler builds its request from, so it cannot
 * drift from the handler without the handler breaking — which is the only
 * reason a hand-written manifest is worth trusting.
 */
export interface EndpointDeclaration {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path below the cloud-id root, with the spec's parameter braces: "/v1/alerts/{id}/notes". */
  path: string;
  /** Query parameter names this tool sends. */
  query?: string[];
  /** Request body field names this tool sends, in the API's own casing. */
  body?: string[];
  /**
   * Query names to accept even though the spec does not declare them. Every
   * entry needs a comment saying why — an unexplained one is how a wrong
   * parameter becomes permanent.
   */
  allowUnknownQuery?: string[];
  /** Body fields to accept though the spec does not declare them. Same rule. */
  allowUnknownBody?: string[];
}

/**
 * One HTTP request, as data. The code API's unit of work.
 *
 * Deliberately not a `ToolResult`: no markdown, no CHARACTER_LIMIT, no
 * pagination prose. A script filtering two thousand alerts down to five wants
 * the two thousand, and list-executor.ts truncates its own structuredContent to
 * whatever fit a 25,000-character render — so reusing a handler's output as a
 * code-API value would cap the fetch at the model's reading budget, which is
 * the one thing code mode exists to escape.
 *
 * Deliberately data rather than a function, too. A plan can be compared against
 * `endpoint` by a catalogue sweep and against the handler's own recorded
 * request by a parity test; a closure could be neither, and an unverifiable
 * second way to build a request is exactly what check-endpoints.mjs exists to
 * prevent.
 */
export interface RequestPlan {
  method: EndpointDeclaration["method"];
  /** Path below the cloud-id root, ids already interpolated and encoded. */
  path: string;
  params?: Record<string, unknown> | undefined;
  body?: Record<string, unknown> | undefined;
  /**
   * How to read the response: `collection` goes through getCollection and can be
   * auto-paged, `object` through getOne, `empty` is a 204 with no body.
   */
  shape: "collection" | "object" | "empty";
  /** Envelope key for collections under neither `data` nor `values`. */
  itemsKey?: string | undefined;
  /** Lets the auto-pager know how — and whether — to ask for a later page. */
  paging?: PagingDialect | undefined;
}

/** A tool as its own module writes it, with the handler's params inferred. */
export interface ToolDefinition<Shape extends z.ZodRawShape> {
  name: string;
  title: string;
  /**
   * Which toolset this tool belongs to. Required, not optional: a tool with no
   * toolset could not be selected, and defaulting one would put it in a set its
   * author never considered — probably the one users load by default.
   */
  toolset: ToolGroup;
  /**
   * The API call(s) this tool makes, or omitted for a tool that makes none.
   * An array for a tool that reaches two endpoints, like jsm_get_alert.
   */
  endpoint?: EndpointDeclaration | EndpointDeclaration[];
  /**
   * The model's only documentation for this tool. State the sharp edges here,
   * not just in code comments — see CONTRIBUTING.md.
   */
  description: string;
  /**
   * A raw Zod shape, NOT a `z.object(...)`. `registerTools` wraps it in a
   * `z.strictObject` on the way to the SDK — see the note there for why.
   */
  inputSchema: Shape;
  outputSchema?: z.ZodRawShape;
  annotations: ToolAnnotations;
  handler: (params: z.infer<z.ZodObject<Shape>>, client: JsmClient) => Promise<ToolResult>;
  /**
   * The request this tool issues, as data rather than as a rendered result.
   *
   * Present means the operation is reachable from the code API; absent means it
   * is not, which is what lets the data layer be filled in without one commit
   * touching every tool. A catalogue sweep checks each plan against `endpoint`,
   * and check-endpoints.mjs checks `endpoint` against the vendored spec — so a
   * plan is transitively spec-checked with no second manifest to keep honest.
   *
   * Keep it building the same request the handler builds. The parity test drives
   * the classic tool and the dispatcher against the same stub and compares the
   * recorded calls, so the two cannot drift silently; the cheapest way to pass
   * it is to have the handler consume this plan rather than restate it.
   */
  plan?: (params: z.infer<z.ZodObject<Shape>>) => RequestPlan;
  /**
   * For the few operations that are not one request: raw data, directly.
   *
   * NOT checkable against `endpoint`, which is why it is the exception rather
   * than the rule, and why a test caps how many tools may use it. Three need it:
   * jsm_get_on_call, jsm_get_next_on_call and jsm_get_schedule_timeline each
   * issue several calls and merge them. Those three are also the best argument
   * for exposing them as single operations — they already encode the
   * TIMELINE_LOOKBACK_MS correction a model would not discover, so asking a
   * script to re-derive them would be a downgrade.
   *
   * Charge `ctx.budget` for every request made here, or a composite becomes a
   * way around the invocation's request budget.
   */
  fetch?: (
    params: z.infer<z.ZodObject<Shape>>,
    client: JsmClient,
    ctx: CallContext,
  ) => Promise<unknown>;
}

/**
 * A definition with its input shape erased, so tools with different shapes can
 * share an array. `defineTool` is the only place the erasure happens.
 */
export interface AnyToolDefinition
  extends Omit<ToolDefinition<z.ZodRawShape>, "handler" | "plan" | "fetch"> {
  handler: (params: unknown, client: JsmClient) => Promise<ToolResult>;
  /** Erased alongside the handler: the dispatcher validates before it calls. */
  plan?: (params: unknown) => RequestPlan;
  fetch?: (params: unknown, client: JsmClient, ctx: CallContext) => Promise<unknown>;
}

/**
 * Identity function that exists purely for inference: it pins `Shape` from the
 * `inputSchema` you pass, so the handler's `params` are fully typed without
 * anyone hand-writing `z.infer<z.ZodObject<typeof shape>>` per tool.
 */
export function defineTool<Shape extends z.ZodRawShape>(
  definition: ToolDefinition<Shape>,
): AnyToolDefinition {
  return definition as unknown as AnyToolDefinition;
}

/**
 * Registers a domain's tools against the server, binding each to the client.
 *
 * Returns the SDK's handles by tool name. Nothing uses them yet; they are the
 * seam for enabling or disabling a tool after registration, which is the only
 * way runtime toolset switching could ever be added without a rewrite.
 */
export function registerTools(
  server: McpServer,
  client: JsmClient,
  definitions: AnyToolDefinition[],
): Map<string, RegisteredTool> {
  const handles = new Map<string, RegisteredTool>();

  for (const tool of definitions) {
    const handle = server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        // Wrapped here rather than left as a raw shape: the SDK would wrap a
        // raw shape in a plain `z.object`, which under Zod 4 emits no
        // `additionalProperties`, so nothing tells a model that a key it
        // invented is not a real parameter. `strictObject` restores
        // `additionalProperties: false` and makes an unknown key a visible
        // error instead of a silently dropped one.
        inputSchema: z.strictObject(tool.inputSchema),
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
        annotations: tool.annotations,
      },
      (params: unknown) => tool.handler(params, client),
    );

    handles.set(tool.name, handle);
  }

  return handles;
}
