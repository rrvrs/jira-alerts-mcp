/**
 * jsm_apply — invoke one write operation.
 *
 * Separate from jsm_call, and one operation per call, because of an approval
 * problem that a single write-capable dispatcher would make worse than the
 * ninety-four tools it replaces.
 *
 * Thirty-seven of those operations are destructive — every update and every
 * delete. Today each prompts on its own, with its own name in the dialog: a
 * user approving `jsm_delete_schedule` knows what they approved. A dispatcher
 * that could reach all thirty-seven would carry one annotation and therefore
 * one approval, granted once, for a tool whose description says "writes
 * things". That is a real regression, and three things answer it:
 *
 *   1. jsm_call cannot write at all, so the read path stays auto-approvable and
 *      the common case never asks.
 *   2. This takes ONE operation per call. The operation name is an argument, so
 *      it appears in what the client shows before the user says yes.
 *   3. Destructive operations additionally require the operator to have set
 *      JSM_CODE_DESTRUCTIVE. Not an annotation and not a model argument: some
 *      clients auto-approve by tool name and some read no annotations at all,
 *      so the only place this can be enforced independently of client
 *      behaviour is in this process.
 *
 * The composition that restores per-tool approvals wholesale is
 * JSM_TOOLSETS=code,alert-actions — the dispatchers plus the eighteen classic
 * alert-action tools, each with its own name and its own prompt.
 */

import { z } from "zod";

import { fail, ok, type ToolResult } from "../../services/format.js";
import { ALWAYS } from "../../toolsets.js";
import { type AnyToolDefinition, defineTool } from "../define.js";
import { auditInvocation } from "./audit.js";
import { type CodeToolDependencies, describeFailure } from "./call.js";
import type { CodePermissions } from "./limits.js";
import { renderResult } from "./render.js";

export function createApplyTool(
  dependencies: CodeToolDependencies,
  permissions: CodePermissions,
): AnyToolDefinition {
  const { registry, dispatcher, newContext } = dependencies;

  const writes = registry
    .reachable()
    .filter((operation) => operation.kind !== "read")
    .map((operation) => `${operation.codeName}${operation.kind === "destructive" ? "*" : ""}`)
    .sort();

  return defineTool({
    name: "jsm_apply",
    toolset: ALWAYS,
    title: "Apply one JSM write operation",
    description: `Call one write operation from the Jira Service Management Operations API — acknowledge, close, annotate, assign, create, update or delete.

One operation per call, deliberately. The operation you are about to run appears in the arguments, so the approval your client shows names it. Do not try to batch writes through repeated calls without saying what each one will do first.

Args:
  - operation (string): the write operation to run, from the list below.
  - args (object): its arguments, snake_case, exactly as jsm_read_api reports them. Strict — an undeclared name is rejected rather than ignored.

Returns:
  {
    "operation": string,
    "result": ...,        // the API's response: a receipt for an alert action,
                          // the written object for a configuration write,
                          // { ok: true } for a 204
    "requests": number
  }

IMPORTANT — alert writes are asynchronous. Acknowledge, close, assign, snooze, escalate, annotate, tag and delete answer a receipt, { result, requestId }, confirming the request was accepted and NOT that the alert changed. Confirm with jsm_call operation="getRequestStatus". Configuration writes — schedules, rotations, teams, routing — are synchronous and answer with the object.

Read before you write. 'tinyId' is not an id: the short identifier in the JSM UI will not work here, so resolve it with listAlerts first. For a reorder or an overwrite, read the current state and tell the user what will change before calling this.

${
  permissions.destructive
    ? "Destructive operations are ENABLED on this install (JSM_CODE_DESTRUCTIVE is set). Every update and delete below will run. Say what will be lost before calling one."
    : "Destructive operations are DISABLED on this install. Every update and delete is refused, and the refusal names the classic tool that can do it. This is an operator setting (JSM_CODE_DESTRUCTIVE) — you cannot turn it on from a conversation, and you should not suggest the user disable a safeguard mid-task without saying plainly what it protects."
}

Operations available here (* marks destructive):
${writes.length ? writes.join(", ") : "— none; this install is read-only."}

Examples:
  - "Ack the Redis alert, I'm on it" -> resolve the id with jsm_call listAlerts, then operation="acknowledgeAlert", args={"alert_id":"<full id>"}
  - "Add a note to that alert" -> operation="addAlertNote", args={"alert_id":"<id>","note":"Investigating"}
  - "Put Sam on call for Saturday" -> operation="createOverride", args={...}`,
    inputSchema: {
      operation: z
        .string()
        .min(1)
        .describe("The write operation to run. The classic tool name also works."),
      args: z
        .record(z.string(), z.unknown())
        .default({})
        .describe("The operation's own arguments, snake_case. Strict."),
    },
    outputSchema: {
      operation: z.string(),
      result: z.unknown(),
      requests: z.number(),
    },
    annotations: {
      readOnlyHint: false,
      // The honest worst case of what this can reach, so no client auto-approves
      // it. Being conservative here is the whole point of the tool's existence.
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: async (params): Promise<ToolResult> => {
      const operation = registry.find(params.operation);

      if (operation && operation.kind === "read") {
        return fail(
          `Error (dispatch): '${operation.codeName}' only reads, so it belongs in jsm_call. ` +
            `jsm_apply exists so that a write is approved by name; routing a read through it ` +
            `would ask the user to approve a write that is not one.`,
        );
      }

      if (operation && operation.kind === "destructive" && !permissions.destructive) {
        return fail(
          `Error (dispatch): '${operation.codeName}' is destructive, and destructive ` +
            `operations are not enabled on this install. The operator can allow them by ` +
            `setting JSM_CODE_DESTRUCTIVE=true where this server is configured, and ` +
            `restarting it; or they can load '${operation.toolset}' as a classic toolset ` +
            `(JSM_TOOLSETS=code,${operation.toolset}), which registers ${operation.toolName} ` +
            `as its own tool with its own approval. Tell the user which they prefer rather ` +
            `than choosing for them.`,
        );
      }

      // The allowlist is exactly the operation named in this call, so the
      // approval the client showed and the permission the dispatcher grants are
      // the same thing by construction.
      const ctx = newContext(operation ? [operation.codeName] : [params.operation]);
      const startedAt = Date.now();
      try {
        const result = await dispatcher.call(params.operation, params.args, ctx);
        const rendered = renderResult(result);
        // Unconditionally audited: a write made through a dispatcher has to be
        // as traceable as one made through its own tool.
        auditInvocation({ tool: "jsm_apply", ctx, startedAt });
        return ok(rendered.text, {
          operation: params.operation,
          result: rendered.value,
          requests: ctx.budget.requests,
        });
      } catch (error) {
        auditInvocation({ tool: "jsm_apply", ctx, startedAt, error });
        return fail(describeFailure(ctx.invocationId, error));
      } finally {
        ctx.deadline.dispose();
      }
    },
  });
}
