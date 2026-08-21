/**
 * On-call tools: schedule discovery, who is on-call now, who is on-call next.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { JsmClient } from "../../services/client.js";
import { registerTools, type AnyToolDefinition } from "../define.js";
import { getNextOnCall } from "./get-next-on-call.js";
import { getOnCall } from "./get-on-call.js";
import { listSchedules } from "./list-schedules.js";

export const onCallTools: AnyToolDefinition[] = [listSchedules, getOnCall, getNextOnCall];

export function registerOnCallTools(server: McpServer, client: JsmClient): void {
  registerTools(server, client, onCallTools);
}
