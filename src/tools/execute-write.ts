/**
 * The shared executor behind every write.
 *
 * Replaces the earlier executeAction, which hardcoded POST and the
 * `/v1/alerts/{id}/` prefix and so could express only four of the API's writes.
 * The invariant it existed to protect is unchanged: JSM applies alert actions
 * asynchronously and returns a receipt rather than the updated object, and one
 * executor is what guarantees every write reports that receipt identically and
 * points at jsm_get_request_status. A tool that renders its own response
 * teaches the model an inconsistent contract, and it starts believing writes
 * have landed when they have not.
 *
 * What is new is that asynchrony is now a parameter rather than an assumption.
 * Alert actions are asynchronous; note edits and every configuration write are
 * not. Telling the model to poll a request id that was never issued is its own
 * way of teaching a false contract, so `mode` has to be stated per tool.
 */

import { type JsmClient, handleApiError } from "../services/client.js";
import {
  fail,
  ok,
  renderAsyncReceipt,
  renderDeleted,
  type ToolResult,
} from "../services/format.js";
import type { AsyncActionResponse } from "../types.js";

export type WriteMode =
  /** 202-style receipt: {result, requestId}, change applied out of band. */
  | "async"
  /** The response body is the updated object. */
  | "sync"
  /** 204 with no body. */
  | "deleted";

export interface WriteOptions<T> {
  /** Human label for the action, used in the receipt and in error messages. */
  label: string;
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  /** The full path below the cloud-id root, e.g. "/v1/alerts/{id}/snooze". */
  path: string;
  body?: unknown;
  params?: Record<string, unknown> | undefined;
  mode: WriteMode;
  /**
   * What was written: `key` names the field echoed into the structured payload,
   * `noun` is the word the receipt uses, `value` is the id.
   * e.g. { key: "alert_id", noun: "alert", value: id }.
   */
  subject?: { key: string; value?: string | undefined; noun: string };
  /** Required for mode "sync": renders the object the API returned. */
  render?: (data: T) => string;
}

export async function executeWrite<T>(
  client: JsmClient,
  options: WriteOptions<T>,
): Promise<ToolResult> {
  const { label, method, path, body, params, mode, subject, render } = options;
  const subjectFields =
    subject && subject.value !== undefined ? { [subject.key]: subject.value } : {};

  try {
    const response = await client.request<T>(method, path, {
      ...(body !== undefined ? { body } : {}),
      params,
    });

    if (mode === "deleted") {
      return renderDeleted(label, subject);
    }

    if (mode === "sync") {
      if (!render) {
        // A programming error, not a user-facing one — but returning it as a
        // result rather than throwing keeps the failure inside the tool result
        // where every other failure here lives.
        return fail(`Error (${label.toLowerCase()}): no renderer configured for a sync write.`);
      }
      return ok(render(response), {
        ...subjectFields,
        ...(response && typeof response === "object" ? (response as Record<string, unknown>) : {}),
      });
    }

    const receipt = response as AsyncActionResponse;
    return ok(
      renderAsyncReceipt(label, { noun: subject?.noun ?? "request", id: subject?.value }, receipt),
      {
        requestId: receipt.requestId,
        result: receipt.result,
        ...subjectFields,
      },
    );
  } catch (error) {
    return fail(handleApiError(error, label.toLowerCase(), { method, path }));
  }
}
