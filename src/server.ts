/**
 * Server assembly: which tool domains exist, and how a selection of them gets
 * registered.
 *
 * Kept apart from index.ts so transports and tool composition can change
 * independently, and so tests can build a server without touching stdio or
 * Express.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import type { JsmClient } from "./services/client.js";
import type { Selection } from "./toolsets.js";
import { createCapabilitiesTool } from "./tools/capabilities.js";
import type { AnyToolDefinition } from "./tools/define.js";
import { registerTools } from "./tools/define.js";
import { alertReadTools } from "./tools/alerts/index.js";
import { alertActionTools } from "./tools/actions/index.js";
import { onCallTools } from "./tools/oncall/index.js";
import { scheduleConfigTools } from "./tools/schedules/index.js";
import { teamTools } from "./tools/teams/index.js";
import { maintenanceWindowTools } from "./tools/maintenance/index.js";
import { heartbeatTools } from "./tools/heartbeats/index.js";
import { routingTools } from "./tools/routing/index.js";
import { policyTools } from "./tools/policies/index.js";

/**
 * Every tool this server knows how to register, in catalogue order.
 *
 * This is the full catalogue, not what any one process exposes — resolveSelection
 * cuts it down. The drift guard and the docs generator both want the whole thing,
 * so it stays exported unfiltered.
 */
export const allTools: AnyToolDefinition[] = [
  ...alertReadTools,
  ...alertActionTools,
  ...onCallTools,
  ...scheduleConfigTools,
  ...teamTools,
  ...maintenanceWindowTools,
  ...heartbeatTools,
  ...routingTools,
  ...policyTools,
];

/**
 * Builds a server exposing exactly `selection`, plus jsm_list_capabilities.
 *
 * The capabilities tool is added here rather than in the selection because it
 * is registered regardless: a selection that hides a family should still be
 * able to say so.
 */
export function buildServer(client: JsmClient, selection: Selection): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerTools(server, client, [...selection.tools, createCapabilitiesTool(allTools, selection)]);
  return server;
}
