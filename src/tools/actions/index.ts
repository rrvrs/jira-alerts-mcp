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
import { addAlertExtraProperties, removeAlertExtraProperties } from "./extra-properties.js";
import { addAlertTags, removeAlertTags } from "./tags.js";
import { assignAlert } from "./assign.js";
import { snoozeAlert } from "./snooze.js";
import { unacknowledgeAlert } from "./unacknowledge.js";
import { updateAlertField } from "./update-field.js";
import { deleteAlertNote, updateAlertNote } from "./update-note.js";

export const alertActionTools: AnyToolDefinition[] = [
  createAlert,
  acknowledgeAlert,
  unacknowledgeAlert,
  snoozeAlert,
  assignAlert,
  escalateAlert,
  closeAlert,
  updateAlertField,
  addAlertNote,
  updateAlertNote,
  deleteAlertNote,
  addAlertTags,
  removeAlertTags,
  addAlertExtraProperties,
  removeAlertExtraProperties,
  addAlertResponder,
];

export function registerAlertActionTools(server: McpServer, client: JsmClient): void {
  registerTools(server, client, alertActionTools);
}
