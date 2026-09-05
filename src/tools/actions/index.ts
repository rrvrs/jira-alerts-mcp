/**
 * Alert write tools: acknowledge, close, add note, add responder.
 *
 * Every endpoint here is asynchronous — see ./alert-action.ts.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { JsmClient } from "../../services/client.js";
import { registerTools, type AnyToolDefinition } from "../define.js";
import { acknowledgeAlert } from "./acknowledge.js";
import { addAlertNote } from "./add-note.js";
import { addAlertResponder } from "./add-responder.js";
import { closeAlert } from "./close.js";
import { createAlert } from "./create-alert.js";
import { escalateAlert } from "./escalate.js";
import { assignAlert } from "./assign.js";
import { snoozeAlert } from "./snooze.js";
import { unacknowledgeAlert } from "./unacknowledge.js";

export const alertActionTools: AnyToolDefinition[] = [
  createAlert,
  acknowledgeAlert,
  unacknowledgeAlert,
  snoozeAlert,
  assignAlert,
  escalateAlert,
  closeAlert,
  addAlertNote,
  addAlertResponder,
];

export function registerAlertActionTools(server: McpServer, client: JsmClient): void {
  registerTools(server, client, alertActionTools);
}
