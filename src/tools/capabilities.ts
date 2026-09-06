/**
 * jsm_list_capabilities — what this server can do, including what it is not
 * currently loaded to do.
 *
 * This is what makes a small default safe. Without it, a toolset the user has
 * not enabled is indistinguishable from a feature that does not exist: the
 * model finds no tool, and either says the server cannot do it or invents one.
 * With it, "can you show me the schedule rotations?" gets an answer that names
 * the toolset and the variable that turns it on.
 *
 * Registered regardless of selection, and answers entirely from memory — no
 * API call, no credentials, so it works even when the token is wrong.
 */

import { z } from "zod";

import { ok, type ToolResult } from "../services/format.js";
import {
  ALWAYS,
  SELECTABLE_NAMES,
  TOOLSETS,
  TOOLSET_INFO,
  type Selection,
  type ToolsetName,
} from "../toolsets.js";
import { defineTool, type AnyToolDefinition } from "./define.js";

interface ToolsetReport {
  name: ToolsetName;
  enabled: boolean;
  summary: string;
  scopes: string[];
  tool_count: number;
  tools: string[];
}

function report(catalogue: AnyToolDefinition[], selection: Selection): ToolsetReport[] {
  const enabled = new Set(selection.tools.map((tool) => tool.name));

  return TOOLSETS.map((name) => {
    const inSet = catalogue.filter((tool) => tool.toolset === name);
    const loaded = inSet.filter((tool) => enabled.has(tool.name));
    return {
      name,
      enabled: loaded.length > 0,
      summary: TOOLSET_INFO[name].summary,
      scopes: TOOLSET_INFO[name].scopes,
      tool_count: loaded.length,
      tools: loaded.map((tool) => tool.name),
    };
  });
}

function render(reports: ToolsetReport[], selection: Selection): string {
  const lines: string[] = [
    `**Selection:** ${selection.requested.join(", ")}${selection.readOnly ? " (read-only)" : ""}`,
    `**Tools registered:** ${selection.tools.length}`,
    "",
  ];

  for (const entry of reports) {
    const mark = entry.enabled ? "on" : "off";
    lines.push(`### ${entry.name} — ${mark}${entry.enabled ? ` (${entry.tool_count} tools)` : ""}`);
    lines.push(entry.summary);
    lines.push(`Scopes: ${entry.scopes.join(", ")}`);
    if (entry.enabled) {
      lines.push(`Tools: ${entry.tools.join(", ")}`);
    } else {
      lines.push(
        `Not loaded. Enable it by adding '${entry.name}' to the JSM_TOOLSETS environment ` +
          `variable (or --toolsets=) where this server is configured, then restarting it.`,
      );
    }
    lines.push("");
  }

  lines.push(`Selectable names: ${SELECTABLE_NAMES.join(", ")}.`);
  if (selection.readOnly) {
    lines.push(
      "Read-only mode is on, so every write tool is withheld regardless of the toolsets above. " +
        "Unset JSM_READ_ONLY to restore them.",
    );
  }

  return lines.join("\n");
}

/**
 * Built per process rather than declared statically, because it reports the
 * selection this process actually resolved.
 */
export function createCapabilitiesTool(
  catalogue: AnyToolDefinition[],
  selection: Selection,
): AnyToolDefinition {
  return defineTool({
    name: "jsm_list_capabilities",
    toolset: ALWAYS,
    title: "List this server's toolsets",
    description: `Report every toolset this server knows about, whether it is currently loaded, and how to load one that is not.

Call this before telling the user something is impossible. This server carries far more of the Jira Service Management Operations API than any one install registers — the operator chooses which families load, so an absent tool usually means "not enabled here", not "not supported". This tool tells you which of the two it is, and names the exact environment variable to change.

It takes no arguments, makes no API call, and needs no credentials, so it also answers when the token is missing or wrong.

Args: none beyond response_format.
  - response_format ('markdown' | 'json'): default "markdown"

Returns (json format):
  {
    "requested": string[],       // the names this process was configured with
    "read_only": boolean,
    "tool_count": number,        // tools actually registered
    "toolsets": [
      {
        "name": string,
        "enabled": boolean,
        "summary": string,
        "scopes": string[],      // OAuth scopes this family needs
        "tool_count": number,
        "tools": string[]
      }
    ]
  }

Examples:
  - User asks for something no loaded tool covers -> call this, then tell them which toolset covers it and that JSM_TOOLSETS needs to include it.
  - "What can you do here?" -> call this rather than guessing from your tool list.

Note: changing JSM_TOOLSETS requires restarting the server. You cannot enable a toolset from inside a conversation.`,
    inputSchema: {
      response_format: z
        .enum(["markdown", "json"])
        .default("markdown")
        .describe("Output format. 'markdown' is compact (default); 'json' returns every field."),
    },
    outputSchema: {
      requested: z.array(z.string()),
      read_only: z.boolean(),
      tool_count: z.number(),
      toolsets: z.array(z.object({}).passthrough()),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      // Answers from this process's own configuration, not from Atlassian.
      openWorldHint: false,
    },
    handler: async (params): Promise<ToolResult> => {
      const reports = report(catalogue, selection);
      const structured = {
        requested: selection.requested,
        read_only: selection.readOnly,
        tool_count: selection.tools.length,
        toolsets: reports,
      };

      const text =
        params.response_format === "json"
          ? JSON.stringify(structured, null, 2)
          : render(reports, selection);

      return ok(text, structured);
    },
  });
}
