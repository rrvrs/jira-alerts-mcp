/**
 * jsm_read_api — the full documentation for named operations.
 *
 * Progressive disclosure's second half. jsm_call carries the operation names,
 * which is enough to call most of them; this is what you read when you need the
 * exact arguments, or the caveats.
 *
 * It returns each operation's `description` VERBATIM. That is the point, not an
 * economy: family.ts's header makes the case that the descriptions are the
 * product — they carry what the OpenAPI spec does not say, learned against a
 * live tenant, and generating or algorithmically shortening prose is how that
 * knowledge quietly stops being written. Progressive disclosure means the long
 * description is paid for only when asked for, not rewritten.
 */

import { z } from "zod";

import { ok, withCharacterLimit, type ToolResult } from "../../services/format.js";
import { ALWAYS } from "../../toolsets.js";
import { type AnyToolDefinition, defineTool } from "../define.js";
import type { Operation, OperationRegistry } from "./registry.js";

const MAX_OPERATIONS = 10;

function render(operation: Operation): string {
  const endpoints = [operation.tool.endpoint]
    .flat()
    .map((endpoint) => (endpoint ? `${endpoint.method} ${endpoint.path}` : ""))
    .filter(Boolean);

  return [
    `## ${operation.codeName}`,
    "",
    `- Classic tool: \`${operation.toolName}\``,
    `- Toolset: \`${operation.toolset}\``,
    `- Kind: **${operation.kind}**`,
    `- Endpoint: ${endpoints.map((entry) => `\`${entry}\``).join(" or ") || "— none"}`,
    `- Pageable: ${operation.pageable ? "yes — jsm_call accepts all_pages" : "no"}`,
    ...(operation.available ? [] : ["", `**NOT AVAILABLE HERE.** ${operation.unavailableReason}`]),
    "",
    "```ts",
    `${operation.codeName}(args: ${operation.declaration()})`,
    "```",
    "",
    operation.tool.description,
  ].join("\n");
}

export function createReadTool(registry: OperationRegistry): AnyToolDefinition {
  return defineTool({
    name: "jsm_read_api",
    toolset: ALWAYS,
    title: "Read the full documentation for JSM API operations",
    description: `Return the complete documentation for up to ${MAX_OPERATIONS} named Jira Service Management Operations API operations: their TypeScript argument types, the endpoints behind them, and the operation's own full description.

Call this before passing arguments you are unsure of to jsm_call. The argument types here are generated from the schema the server actually validates against, so a call built from them is a call that will not be rejected for a misnamed field. The prose is the operation's own documentation — it states the sharp edges, which fields are mutually dependent, and what the response really contains.

Args:
  - operations (string[]): 1 to ${MAX_OPERATIONS} names. Code names ('listAlerts') and tool names ('jsm_list_alerts') are both accepted, so you can paste either.
  - response_format ('markdown' | 'json'): default 'markdown'.

Returns (json format):
  {
    "operations": [
      {
        "operation": string,
        "tool": string,
        "toolset": string,
        "kind": "read" | "write" | "destructive",
        "available": boolean,
        "reason": string,        // present when available is false
        "pageable": boolean,     // whether jsm_call's all_pages works on it
        "endpoints": string[],
        "arguments": string,     // the TypeScript argument type
        "documentation": string  // the operation's full description, verbatim
      }
    ],
    "unknown": string[]          // names that matched nothing
  }

A name that matches nothing is reported under 'unknown' rather than failing the whole call, so asking about five operations and misspelling one still answers for the other four. jsm_search_api will find the one you meant.

Examples:
  - "What arguments does createAlert take?" -> operations=["createAlert"]
  - "Compare the two on-call lookups" -> operations=["getOnCall","getNextOnCall"]
  - "I got a validation error from listAlerts" -> operations=["listAlerts"]`,
    inputSchema: {
      operations: z
        .array(z.string().min(1))
        .min(1)
        .max(MAX_OPERATIONS)
        .describe("Operation names, as code names or tool names. Both are accepted."),
      response_format: z.enum(["markdown", "json"]).default("markdown"),
    },
    outputSchema: {
      operations: z.array(z.object({ operation: z.string() }).passthrough()),
      unknown: z.array(z.string()),
      not_shown: z.array(z.string()).optional(),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: async (params): Promise<ToolResult> => {
      const found: Operation[] = [];
      const unknown: string[] = [];

      for (const name of params.operations) {
        const operation = registry.find(name);
        if (operation) found.push(operation);
        else unknown.push(name);
      }

      const document = (operation: Operation) => ({
        operation: operation.codeName,
        tool: operation.toolName,
        toolset: operation.toolset,
        kind: operation.kind,
        available: operation.available,
        ...(operation.unavailableReason ? { reason: operation.unavailableReason } : {}),
        pageable: operation.pageable,
        endpoints: [operation.tool.endpoint]
          .flat()
          .map((endpoint) => (endpoint ? `${endpoint.method} ${endpoint.path}` : ""))
          .filter(Boolean),
        arguments: operation.declaration(),
        documentation: operation.tool.description,
      });

      // Ten long descriptions run past the response limit, so the answer is
      // fitted like every other tool's. The descriptions themselves are never
      // shortened — whole operations are dropped from the end instead, and the
      // note names them so they can be asked for again.
      const hint = "Ask for the rest in a second call.";
      const asText = withCharacterLimit(
        found,
        (kept) => kept.map(render).join("\n\n---\n\n"),
        hint,
      );
      const asData = withCharacterLimit(
        found,
        (kept) => JSON.stringify(kept.map(document), null, 2),
        hint,
      );
      const shown = found.slice(0, Math.min(asText.kept, asData.kept));
      const dropped = found.slice(shown.length).map((operation) => operation.codeName);

      const structured = {
        operations: shown.map(document),
        unknown,
        ...(dropped.length ? { not_shown: dropped } : {}),
      };

      const tail = dropped.length
        ? `_Trimmed to fit: ${dropped.length} not shown — ${dropped.join(", ")}. ${hint}_`
        : undefined;

      if (params.response_format === "json") {
        return ok(
          [JSON.stringify(structured, null, 2), tail].filter(Boolean).join("\n\n"),
          structured,
        );
      }

      const sections = shown.map(render);
      if (unknown.length) {
        sections.push(
          [
            "## Not found",
            "",
            `No operation named ${unknown.map((name) => `\`${name}\``).join(", ")}. ` +
              `Call jsm_search_api to find the one you meant.`,
          ].join("\n"),
        );
      }

      return ok([sections.join("\n\n---\n\n"), tail].filter(Boolean).join("\n\n"), structured);
    },
  });
}
