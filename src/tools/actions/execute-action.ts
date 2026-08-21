/**
 * The shared executor behind every alert write.
 *
 * JSM applies alert actions asynchronously: the endpoint returns a requestId
 * immediately and the change lands out of band. Centralising the POST here is
 * what guarantees all four write tools report that receipt identically and
 * point at jsm_get_request_status — a tool that renders its own response
 * teaches the model an inconsistent contract, and it starts believing writes
 * have landed when they have not.
 */

import { JsmClient, handleApiError } from "../../services/client.js";
import { fail, ok, renderAsyncReceipt, type ToolResult } from "../../services/format.js";
import type { AsyncActionResponse } from "../../types.js";

export async function executeAction(
  client: JsmClient,
  label: string,
  alertId: string,
  path: string,
  body: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    const response = await client.request<AsyncActionResponse>(
      "POST",
      `/v1/alerts/${encodeURIComponent(alertId)}/${path}`,
      { body },
    );

    return ok(renderAsyncReceipt(label, alertId, response), {
      requestId: response.requestId,
      result: response.result,
      alert_id: alertId,
    });
  } catch (error) {
    return fail(handleApiError(error, label.toLowerCase()));
  }
}
