/**
 * jsm_run — run a script against the JSM Operations API.
 *
 * This is the half of code execution that jsm_call cannot do. jsm_call takes
 * tool definitions out of the context window; this takes the *data* out too.
 * A script reads two thousand alerts, counts the ones that matter, and logs a
 * sentence — and the two thousand never reach the model at all.
 *
 * It is read-only, and not by configuration. The context handed to the
 * dispatcher carries no write allowlist, so every operation reachable from a
 * script is one with `readOnlyHint` that issues a GET. That is what keeps the
 * sandbox's threat model short enough to be true: the live risk is prompt
 * injection — alert messages and notes are written by whatever integration
 * fired them, they reach the model's context, and a model acting on
 * instructions found there can write a script. A script that cannot write
 * cannot be made to delete a schedule.
 *
 * Writes stay in jsm_apply, one per call, where the client approves each by
 * name. See apply.ts for the full argument.
 */

import { z } from "zod";

import { CHARACTER_LIMIT, CODE_MAX_SCRIPT_CHARS } from "../../constants.js";
import { fail, ok, withCharacterLimit, type ToolResult } from "../../services/format.js";
import { ALWAYS } from "../../toolsets.js";
import { type AnyToolDefinition, defineTool } from "../define.js";
import { auditInvocation } from "./audit.js";
import { describeFailure, type CodeToolDependencies } from "./call.js";
import type { ScriptEngine } from "./engine.js";
import type { CodeLimits } from "./limits.js";
import type { OperationRegistry } from "./registry.js";

function describe(registry: OperationRegistry, limits: CodeLimits): string {
  const reads = registry
    .reachable()
    .filter((operation) => operation.kind === "read")
    .map((operation) => operation.codeName)
    .sort();
  const pageable = registry
    .reachable()
    .filter((operation) => operation.pageable)
    .map((operation) => `listAll${operation.codeName.slice("list".length)}`)
    .sort();

  return `Run a JavaScript snippet that reads from the Jira Service Management Operations API, and get back only what it logs.

Use this instead of jsm_call whenever the answer is smaller than the data it comes from: a count, an extreme, a join across two families, a filter over more records than you want to read. The script runs next to the API, so a sweep over two thousand alerts costs you the one line you log about it rather than two thousand records of context.

Args:
  - script (string): JavaScript. Top-level \`await\` works. Up to ${CODE_MAX_SCRIPT_CHARS.toLocaleString("en-GB")} characters.

How to write one:
  - \`await jsm.<operation>(args)\` calls one operation and returns the API's data. Arguments are the same snake_case ones jsm_read_api documents. A collection comes back as \`{ items, total?, nextOffset?, nextCursor? }\`.
  - \`await jsm.listAll<Thing>(args, { max })\` reads every page and returns \`{ items, pages, complete, stoppedBecause? }\`. **Check \`complete\`** — false means a budget stopped the sweep early and \`items\` is partial.
  - \`console.log(...)\` is the only way anything reaches you. A script that computes the right answer and logs nothing returns nothing. Log a summary: a single line is cut at 20,000 characters.
  - The script's whole world is \`jsm\`, \`console\` and the JavaScript language itself. There is no \`require\`, \`import\`, \`fetch\`, \`process\`, \`setTimeout\` or \`eval\` — not blocked, absent — so do not reach for them.
  - A failed operation throws, and the error carries \`.status\`, \`.operation\` and \`.retryable\` alongside its message, so \`catch (e) { if (e.status === 404) ... }\` works.

Returns: the script's log lines, in order, trimmed to ${CHARACTER_LIMIT.toLocaleString("en-GB")} characters. On failure, the lines logged before it failed plus one error saying which kind it was: a syntax error (fix the script), a thrown error (fix the logic), a budget (narrow the work), or an operation error (read the API's own advice in the message).

The sandbox: the script runs in its own empty JavaScript realm, inside a separate process that has no filesystem, no network, no ability to start anything, and an empty environment — it cannot reach the Atlassian credential, and it could not send anything anywhere if it had it. Every API call it makes is a message to this server, which makes the request. There is no state between runs: each script gets a fresh process.

**It can only read.** Every operation below issues a GET. To change something, use jsm_apply, which takes one operation per call so your client can approve it by name.

Budgets, shared across the whole script: ${limits.maxRequests} HTTP requests, ${limits.maxRecords.toLocaleString("en-GB")} records, ${limits.maxPages} pages per auto-paged read, ${limits.maxInflight} concurrent requests, ${limits.timeoutMs}ms. A budget reached mid-script is reported as a budget error, and anything logged before it still comes back.

Examples:

  "How many schedules are disabled?"
    const all = await jsm.listAllSchedules({});
    const off = all.items.filter(s => s.enabled === false);
    console.log(\`\${off.length} of \${all.items.length} schedules are disabled\`);
    console.log(off.map(s => s.name).join(", "));

  "Which schedule has nobody on call right now?"
    const { items: schedules } = await jsm.listSchedules({ limit: 100 });
    const gaps = [];
    for (const s of schedules) {
      const answer = await jsm.getOnCall({ schedule_id: s.id });
      if (!answer.participants?.length) gaps.push(s.name ?? s.id);
    }
    console.log(gaps.length ? \`Nobody on call for: \${gaps.join(", ")}\` : "Every schedule is covered");

  "Which open P1 has the highest dedupe count?"
    const all = await jsm.listAllAlerts({ query: "status:open AND priority:P1" }, { max: 2000 });
    if (!all.complete) console.log(\`Partial: \${all.stoppedBecause}\`);
    const worst = all.items.reduce((a, b) => ((b.count ?? 0) > (a.count ?? 0) ? b : a));
    console.log(\`\${worst.tinyId} — \${worst.message} (count \${worst.count})\`);

Operations you can call (${reads.length}), as \`await jsm.<name>(args)\`:
${reads.join(", ")}

Auto-paged forms (${pageable.length}):
${pageable.join(", ")}

Call jsm_read_api for an operation's exact arguments before guessing them, and jsm_search_api if you cannot see the operation you want.`;
}

export function createRunTool(
  dependencies: CodeToolDependencies,
  engine: ScriptEngine,
): AnyToolDefinition {
  const { registry, dispatcher, limits, newContext } = dependencies;

  return defineTool({
    name: "jsm_run",
    toolset: ALWAYS,
    title: "Run a read-only script against the JSM API",
    description: describe(registry, limits),
    inputSchema: {
      script: z
        .string()
        .min(1)
        .max(CODE_MAX_SCRIPT_CHARS)
        .describe(
          "JavaScript. Top-level await works. Call operations as `await jsm.listAlerts({...})`, and log what you want returned.",
        ),
    },
    outputSchema: {
      logs: z.array(z.string()),
      truncated: z.boolean(),
      requests: z.number(),
      records: z.number(),
      operations: z.array(z.string()),
      error: z.object({ kind: z.string(), message: z.string() }).optional(),
    },
    annotations: {
      // Honest: the context below carries no write allowlist, so the
      // dispatcher refuses every non-read operation.
      readOnlyHint: true,
      destructiveHint: false,
      // A script can read anything twice and get different answers.
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (params): Promise<ToolResult> => {
      const ctx = newContext();
      const startedAt = Date.now();

      try {
        const outcome = await engine.run({
          script: params.script,
          ctx,
          call: (operation, args, allPages, max) =>
            allPages
              ? dispatcher.callAll(operation, args, ctx, max)
              : dispatcher.call(operation, args, ctx),
        });

        // Trimmed line-wise so the output stays readable rather than cut
        // mid-sentence, using the same budget and the same wording every other
        // tool uses.
        const rendered = withCharacterLimit(
          outcome.logs,
          (lines) => lines.join("\n"),
          "Log less per line, or log a summary rather than whole records.",
        );

        const structured = {
          logs: outcome.logs.slice(0, rendered.kept),
          truncated: outcome.truncated || rendered.kept < outcome.logs.length,
          requests: ctx.budget.requests,
          records: ctx.budget.records,
          operations: [...new Set(ctx.operations)].sort(),
          ...(outcome.error ? { error: outcome.error } : {}),
        };

        auditInvocation({
          tool: "jsm_run",
          ctx,
          startedAt,
          ...(outcome.error ? { error: new Error(outcome.error.message) } : {}),
          fields: {
            scriptChars: params.script.length,
            logLines: outcome.logs.length,
            ...(outcome.error ? { errorKind: outcome.error.kind } : {}),
          },
        });

        const parts = [
          outcome.logs.length ? rendered.text : "_The script logged nothing._",
          outcome.truncated
            ? "_Some log lines were dropped: the script logged more than this server will carry._"
            : undefined,
          outcome.error
            ? `\n**Error (${outcome.error.kind}):** ${outcome.error.message}\n\nInvocation ${ctx.invocationId}.`
            : undefined,
        ].filter(Boolean);

        // A script that failed still reports what it logged first, so partial
        // work is not thrown away — and `isError` stays honest about the run.
        return outcome.error ? fail(parts.join("\n")) : ok(parts.join("\n"), structured);
      } catch (error) {
        auditInvocation({ tool: "jsm_run", ctx, startedAt, error });
        return fail(describeFailure(ctx.invocationId, error));
      } finally {
        ctx.deadline.dispose();
      }
    },
  });
}
