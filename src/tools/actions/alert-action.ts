/**
 * The alert family's shortcut into executeWrite.
 *
 * Every alert action is a POST to `/v1/alerts/{id}/{action}` that returns an
 * async receipt, so this exists to keep that prefix and that mode in one place
 * as the family grows past four tools. Everything load-bearing lives in
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
): Promise<ToolResult> {
  return executeWrite(client, {
    label,
    method: "POST",
    path: `/v1/alerts/${encodeURIComponent(alertId)}/${action}`,
    body,
    mode: "async",
    subject: { key: "alert_id", value: alertId, noun: "alert" },
  });
}
