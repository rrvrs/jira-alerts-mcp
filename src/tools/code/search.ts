/**
 * jsm_search_api — find an operation.
 *
 * The fallback when jsm_call's embedded index is not enough: "is there anything
 * for forwarding rules?", "what can I do to a maintenance window?".
 *
 * It searches the WHOLE catalogue and marks each hit `available`, rather than
 * searching only what this process loaded. That is the same argument
 * jsm_list_capabilities makes and it matters more here: a model that finds
 * nothing reports that the server cannot do the thing, when the truth is that
 * the operator did not load that family. Searching wider than we can dispatch,
 * and saying which is which, is what prevents a wrong answer.
 */

import { z } from "zod";

import { ok, withCharacterLimit, type ToolResult } from "../../services/format.js";
import { ALWAYS, TOOLSETS } from "../../toolsets.js";
import { type AnyToolDefinition, defineTool } from "../define.js";
import type { Operation, OperationRegistry } from "./registry.js";

type Detail = "names" | "summaries" | "signatures";

function renderOperation(operation: Operation, detail: Detail): string {
  const head = `### ${operation.codeName}  \`${operation.kind}\`${
    operation.available ? "" : "  — NOT AVAILABLE HERE"
  }`;

  if (detail === "names") {
    return `- ${operation.codeName} (${operation.toolset}, ${operation.kind})${
      operation.available ? "" : " — not available here"
    }`;
  }

  const lines = [head, operation.summary];
  if (!operation.available) lines.push(`**${operation.unavailableReason}**`);
  if (detail === "signatures") {
    lines.push("", "```ts", `${operation.codeName}(args: ${operation.declaration()})`, "```");
  }
  return lines.join("\n");
}

export function createSearchTool(registry: OperationRegistry): AnyToolDefinition {
  const total = registry.all().length;

  return defineTool({
    name: "jsm_search_api",
    toolset: ALWAYS,
    title: "Search the JSM Operations API catalogue",
    description: `Find a Jira Service Management Operations API operation by keyword, across all ${total} this server knows about.

Call this when jsm_call's own list of operations does not obviously contain what you want, or before telling the user something is not possible. It searches the entire catalogue — including families this install has not loaded — and says which of the two an absent operation is.

Args:
  - query (string, optional): keywords. Matched against the operation name, its title, its one-line summary, its toolset, its endpoint path and then its description, in that order of preference. Keywords beat sentences: 'routing rule' finds more than 'how do I change which team gets paged'. Omit to list everything.
  - toolset (string, optional): one of ${TOOLSETS.join(", ")}.
  - kind ('read' | 'write' | 'any'): default 'any'. 'write' covers both writes and destructive operations.
  - detail ('names' | 'summaries' | 'signatures'): default 'summaries'. 'names' is one line each and the cheapest way to see the shape of a family; 'signatures' adds the full TypeScript argument type, which is the same thing jsm_read_api returns.
  - limit (number): 1-100, default 25.

Returns (json format):
  {
    "operations": [
      {
        "operation": string,      // the name to pass to jsm_call
        "tool": string,           // its classic tool name
        "toolset": string,
        "kind": "read" | "write" | "destructive",
        "available": boolean,     // false means this install did not load it
        "reason": string,         // present when available is false — says how to load it
        "summary": string,
        "endpoints": string[]     // e.g. ["GET /v1/alerts"]
      }
    ],
    "matched": number,            // hits before 'limit' was applied
    "searched": number            // the whole catalogue
  }

An operation with "available": false exists in this server but is not loaded here. Do not report it as unsupported: the 'reason' names the environment variable that turns its family on, and jsm_list_capabilities explains the same thing in more detail. Say that to the user and let them decide.

Examples:
  - "Can I forward someone's pages while they're away?" -> query="forwarding"
  - "What can I do to a maintenance window?" -> query="maintenance", detail="names"
  - "I need the exact arguments for reordering a routing rule" -> query="reorder", detail="signatures"
  - "Show me every destructive operation" -> kind="write", detail="names", limit=100`,
    inputSchema: {
      query: z
        .string()
        .optional()
        .describe("Keywords. Omit to list everything at the chosen detail level."),
      toolset: z.enum(TOOLSETS).optional().describe("Restrict to one API family."),
      kind: z
        .enum(["read", "write", "any"])
        .default("any")
        .describe("'write' covers writes and destructive operations alike."),
      detail: z
        .enum(["names", "summaries", "signatures"])
        .default("summaries")
        .describe("How much to report per hit."),
      limit: z.number().int().min(1).max(100).default(25),
      response_format: z.enum(["markdown", "json"]).default("markdown"),
    },
    outputSchema: {
      operations: z.array(z.object({ operation: z.string() }).passthrough()),
      matched: z.number(),
      searched: z.number(),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      // Answers from this process's own catalogue, not from Atlassian.
      openWorldHint: false,
    },
    handler: async (params): Promise<ToolResult> => {
      const matched = registry.search({
        query: params.query,
        toolset: params.toolset,
        kind: params.kind,
      });
      const requested = matched.slice(0, params.limit);

      const describe = (operation: Operation) => ({
        operation: operation.codeName,
        tool: operation.toolName,
        toolset: operation.toolset,
        kind: operation.kind,
        available: operation.available,
        ...(operation.unavailableReason ? { reason: operation.unavailableReason } : {}),
        summary: operation.summary,
        endpoints: [operation.tool.endpoint]
          .flat()
          .map((endpoint) => (endpoint ? `${endpoint.method} ${endpoint.path}` : ""))
          .filter(Boolean),
        ...(params.detail === "signatures" ? { arguments: operation.declaration() } : {}),
      });

      // Fitted against BOTH forms of the answer, and the smaller count wins.
      // 'signatures' with limit 100 used to return 60,000 characters of text
      // and 74,000 of structured content with no ceiling at all — on the tool
      // whose job is to keep definitions out of the context window.
      const hint =
        "Lower 'limit', narrow 'query', or ask for less 'detail' — 'names' is one line each.";
      const asText = withCharacterLimit(
        requested,
        (kept) => kept.map((operation) => renderOperation(operation, params.detail)).join("\n\n"),
        hint,
      );
      const asData = withCharacterLimit(
        requested,
        (kept) => JSON.stringify(kept.map(describe), null, 2),
        hint,
      );
      const hits = requested.slice(0, Math.min(asText.kept, asData.kept));
      const trimmed = hits.length < requested.length;

      const structured = {
        operations: hits.map(describe),
        matched: matched.length,
        searched: registry.all().length,
      };

      const footer = trimmed
        ? `\n\n_Trimmed to fit: showing ${hits.length} of ${requested.length} requested (${matched.length} matched). ${hint}_`
        : matched.length > hits.length
          ? `\n\n_Showing ${hits.length} of ${matched.length} matches. Raise 'limit' or narrow 'query'._`
          : "";

      if (params.response_format === "json") {
        return ok(JSON.stringify(structured, null, 2).concat(footer), structured);
      }

      const header = params.query
        ? `# Operations matching "${params.query}"`
        : "# JSM Operations API catalogue";
      const body = hits.length
        ? hits.map((operation) => renderOperation(operation, params.detail)).join("\n\n")
        : `Nothing matched. Try fewer or different keywords — this searches names, titles, summaries, endpoint paths and descriptions across all ${registry.all().length} operations.`;

      return ok(
        [header, "", `${matched.length} of ${registry.all().length} operations matched.`, "", body]
          .join("\n")
          .concat(footer),
        structured,
      );
    },
  });
}
