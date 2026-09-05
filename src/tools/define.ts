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
}

/**
 * A definition with its input shape erased, so tools with different shapes can
 * share an array. `defineTool` is the only place the erasure happens.
 */
export interface AnyToolDefinition extends Omit<ToolDefinition<z.ZodRawShape>, "handler"> {
  handler: (params: unknown, client: JsmClient) => Promise<ToolResult>;
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
