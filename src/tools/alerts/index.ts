/**
 * Read-only alert tools: search, detail, notes, activity logs, request status.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { JsmClient } from "../../services/client.js";
import { registerTools, type AnyToolDefinition } from "../define.js";
import { getAlert } from "./get-alert.js";
import { listAlertLogs } from "./list-logs.js";
import { listAlertNotes } from "./list-notes.js";
import { listAlerts } from "./list-alerts.js";
import { getRequestStatus } from "./request-status.js";

export const alertReadTools: AnyToolDefinition[] = [
  listAlerts,
  getAlert,
  listAlertNotes,
  listAlertLogs,
  getRequestStatus,
];

export function registerAlertReadTools(server: McpServer, client: JsmClient): void {
  registerTools(server, client, alertReadTools);
}
