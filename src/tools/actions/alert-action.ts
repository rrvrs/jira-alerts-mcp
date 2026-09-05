/**
 * The alert family's shortcut into executeWrite.
 *
 * Nearly every alert action is a POST to `/v1/alerts/{id}/{action}` returning an
 * async receipt, so this exists to keep that prefix and that mode in one place
 * as the family grows. The three field updates are PATCH against the same
 * shape, which is why the method is a parameter with the common case as its
 * default rather than a second helper. Tag and extra-property removal are DELETE
 * with a JSON request body, which is unusual but is what the API specifies. Everything load-bearing lives in
 * ../execute-write.ts — this is the alert-shaped call of it, not a second
 * executor.
 */

import type { JsmClient } from "../../services/client.js";
import type { ToolResult } from "../../services/format.js";
import { executeWrite } from "../execute-write.js";

export function alertAction(
  client: JsmClient,
  label: string,
  alertId: string,
  action: string,
  body: Record<string, unknown>,
  method: "POST" | "PATCH" | "DELETE" = "POST",
): Promise<ToolResult> {
  return executeWrite(client, {
    label,
    method,
    path: `/v1/alerts/${encodeURIComponent(alertId)}/${action}`,
    body,
    mode: "async",
    subject: { key: "alert_id", value: alertId, noun: "alert" },
  });
}
