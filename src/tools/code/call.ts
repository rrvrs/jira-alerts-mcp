/**
 * jsm_call — invoke one operation from the code API.
 *
 * This is the tool that makes the other ninety-four unnecessary in the tool
 * list. The whole catalogue is reachable through it, so a client pays for one
 * description instead of ninety-four schemas, and an operation nobody calls
 * costs nothing.
 *
 * Read-only by construction. Writes go through jsm_apply, one per call, so a
 * client sees and can approve each one by name — see the note there for why one
 * dispatcher holding all thirty-seven destructive operations behind a single
 * approval would be worse than the tools it replaced.
 */

import { z } from "zod";

import { CHARACTER_LIMIT } from "../../constants.js";
import { fail, ok, type ToolResult } from "../../services/format.js";
import { ALWAYS } from "../../toolsets.js";
import { type AnyToolDefinition, defineTool } from "../define.js";
import { auditInvocation } from "./audit.js";
import { CodeError, type CallContext } from "./context.js";
import type { Dispatcher } from "./dispatch.js";
import type { CodeLimits } from "./limits.js";
import type { OperationRegistry } from "./registry.js";
import { renderResult } from "./render.js";

/** Builds the description, which carries the operation index for this process. */
function describe(registry: OperationRegistry, limits: CodeLimits): string {
  const index = registry.index();

  return `Call one Jira Service Management Operations API operation and get its data back, unrendered.

This server carries the whole JSM Operations alert and on-call surface — ${index.length} operations — behind this one tool rather than one tool each. Pass an operation name and its arguments; you get the API's own JSON, not a formatted summary.

Start here. You usually do not need to look anything up first: the operations are listed below, and their names say what they do. Use jsm_read_api when you need an operation's exact arguments, and jsm_search_api when you cannot see an operation for what you want.

Args:
  - operation (string): the operation to call, from the list below. The tool name works too, so 'listAlerts' and 'jsm_list_alerts' are the same operation.
  - args (object): that operation's arguments. Defaults to {}. Names are snake_case, exactly as jsm_read_api reports them. An argument the operation does not declare is an error, not an ignored field — the schemas are strict on purpose.
  - all_pages (boolean): default false. True reads every page and reports an exact 'count' plus a sample of the records. Use it to count or to find an extreme ("how many schedules are disabled", "which alert has the highest dedupe count") rather than to read everything: the sample is trimmed to fit a response, the count is not.
  - max_records (number, optional): ceiling for all_pages. Defaults to ${limits.maxRecords}, which is also the hard limit.

Returns:
  {
    "operation": string,
    "result": ...,        // the API's data. A collection comes back as
                          // { items: [...], total?, nextOffset?, nextCursor? };
                          // a single record as that record; a 204 as { ok: true }
    "count": number,      // all_pages only: the exact number of records read
    "complete": boolean,  // all_pages only: false when a budget stopped the sweep
    "requests": number    // HTTP requests this call made
  }

Paging: a collection reports 'nextOffset' or 'nextCursor'. Pass it back as the operation's own 'offset' or cursor argument to get the next page. Prefer narrowing the query over paging deeply.

Response size: results are trimmed to ${CHARACTER_LIMIT.toLocaleString("en-GB")} characters, dropping records from the end, and 'truncated' says when that happened. 'count' under all_pages is always exact, even when the sample is trimmed.

Budgets, per call: ${limits.maxRequests} HTTP requests, ${limits.maxRecords.toLocaleString("en-GB")} records, ${limits.maxPages} pages, ${limits.timeoutMs}ms. Exceeding one is reported as an error naming it, and under all_pages the records already read are still returned with 'complete': false.

Three API behaviours that will otherwise catch you out:
  - Alert writes are asynchronous. They answer a receipt, { result, requestId }, not the changed alert — confirm with getRequestStatus.
  - 'tinyId' is not an id. The short identifier shown in the JSM UI will not work anywhere an id is wanted; resolve it with listAlerts first.
  - The alert search window caps at 20,000 records: offset + limit must stay under it. Narrow the query instead of paging deeper.

This tool reads only. Every operation reachable here issues a GET. Writes go through jsm_apply, which takes one operation per call so your client can approve it by name.

Examples:
  - "What's on fire?" -> operation="listAlerts", args={"query":"status:open AND acknowledged:false"}
  - "Who's on call for platform?" -> operation="getOnCall", args={"schedule_id":"platform","schedule_identifier_type":"name"}
  - "How many schedules are disabled?" -> operation="listSchedules", all_pages=true, then count the disabled ones in the sample, or read 'count' for the total
  - "Details for alert ABC-123" -> listAlerts to resolve the tinyId, then operation="getAlert", args={"identifier":"<full id>"}

Operations available here (${index.length}):
${index.join(", ")}

An operation you want that is not listed may still exist — this install loads some toolsets and not others. jsm_search_api searches the whole catalogue and says which is which, and jsm_list_capabilities names the environment variable that turns a family on.`;
}

export interface CodeToolDependencies {
  registry: OperationRegistry;
  dispatcher: Dispatcher;
  limits: CodeLimits;
  /** Builds a fresh per-invocation context. Supplied so tests can fix the clock. */
  newContext: (allowWrites?: string[]) => CallContext;
}

/**
 * Turns whatever went wrong into one message the model can act on.
 *
 * Every code-mode error carries a `kind`, and the kinds have different fixes —
 * a dispatch refusal means change the call, a budget means narrow the work, an
 * operation error means read the API's own advice. Flattening them to "it
 * failed" is how a model retries the same broken call three times.
 */
export function describeFailure(invocationId: string, error: unknown): string {
  if (error instanceof CodeError) {
    return `Error (${error.kind}): ${error.message}\n\nInvocation ${invocationId}.`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `Error: ${message}\n\nInvocation ${invocationId}.`;
}

export function createCallTool(dependencies: CodeToolDependencies): AnyToolDefinition {
  const { registry, dispatcher, limits, newContext } = dependencies;

  return defineTool({
    name: "jsm_call",
    toolset: ALWAYS,
    title: "Call a JSM Operations API operation",
    description: describe(registry, limits),
    inputSchema: {
      operation: z
        .string()
        .min(1)
        .describe("Operation name, e.g. 'listAlerts'. The tool name 'jsm_list_alerts' also works."),
      args: z
        .record(z.string(), z.unknown())
        .default({})
        .describe(
          "The operation's own arguments, snake_case. Strict: an undeclared name is rejected rather than ignored.",
        ),
      all_pages: z
        .boolean()
        .default(false)
        .describe(
          "Read every page and report an exact 'count' plus a trimmed sample. For counting and extremes, not for reading everything.",
        ),
      max_records: z
        .number()
        .int()
        .min(1)
        .max(limits.maxRecords)
        .optional()
        .describe(`Ceiling for all_pages. Defaults to ${limits.maxRecords}.`),
    },
    outputSchema: {
      operation: z.string(),
      result: z.unknown(),
      requests: z.number(),
      truncated: z.boolean(),
      count: z.number().optional(),
      complete: z.boolean().optional(),
    },
    annotations: {
      // Honestly read-only: the dispatcher refuses any operation that is not,
      // because this context carries no write allowlist.
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (params): Promise<ToolResult> => {
      const ctx = newContext();
      const startedAt = Date.now();
      try {
        const result = params.all_pages
          ? await dispatcher.callAll(params.operation, params.args, ctx, params.max_records)
          : await dispatcher.call(params.operation, params.args, ctx);

        const sweep = params.all_pages
          ? (result as {
              items: unknown[];
              pages: number;
              complete: boolean;
              stoppedBecause?: string;
            })
          : undefined;

        // A sweep leads with its count, so the number survives whatever happens
        // to the records after it. It used to live only in structuredContent,
        // under a note in the text saying "'count' above is exact" — above
        // which there was no count.
        const rendered = renderResult(
          sweep
            ? {
                count: sweep.items.length,
                pages: sweep.pages,
                complete: sweep.complete,
                ...(sweep.stoppedBecause ? { stoppedBecause: sweep.stoppedBecause } : {}),
                items: sweep.items,
              }
            : result,
        );

        const structured = {
          operation: params.operation,
          // The trimmed value, never the raw one — see RenderedResult.value.
          result: rendered.value,
          requests: ctx.budget.requests,
          truncated: rendered.truncated,
          ...(sweep ? { count: sweep.items.length, complete: sweep.complete } : {}),
        };

        const notes = [
          rendered.truncated && rendered.shown !== undefined
            ? `_Trimmed to fit: showing ${rendered.shown} of ${rendered.fetched} records. ${sweep ? "'count' is exact; 'items' is a sample." : "Page with 'nextOffset' or 'nextCursor', or narrow the request."}_`
            : undefined,
          sweep?.stoppedBecause ? `_Incomplete: ${sweep.stoppedBecause}_` : undefined,
        ].filter(Boolean);

        auditInvocation({
          tool: "jsm_call",
          ctx,
          startedAt,
          fields: {
            allPages: params.all_pages,
            truncated: rendered.truncated,
            ...(sweep ? { complete: sweep.complete } : {}),
          },
        });
        return ok([rendered.text, ...notes].join("\n\n"), structured);
      } catch (error) {
        auditInvocation({ tool: "jsm_call", ctx, startedAt, error });
        return fail(describeFailure(ctx.invocationId, error));
      } finally {
        ctx.deadline.dispose();
      }
    },
  });
}
