/**
 * Alert write tools: acknowledge, close, add note, add responder.
 *
 * Every endpoint here is asynchronous — see ./execute-action.ts.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { JsmClient } from "../../services/client.js";
import { registerTools, type AnyToolDefinition } from "../define.js";
import { acknowledgeAlert } from "./acknowledge.js";
import { addAlertNote } from "./add-note.js";
import { addAlertResponder } from "./add-responder.js";
import { closeAlert } from "./close.js";

export const alertActionTools: AnyToolDefinition[] = [
  acknowledgeAlert,
  closeAlert,
  addAlertNote,
  addAlertResponder,
];

export function registerAlertActionTools(server: McpServer, client: JsmClient): void {
  registerTools(server, client, alertActionTools);
}
