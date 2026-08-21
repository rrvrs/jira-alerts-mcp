/**
 * Server assembly: which tool domains exist, and how they get registered.
 *
 * Kept apart from index.ts so transports and tool composition can change
 * independently, and so tests can build a server without touching stdio or
 * Express.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import type { JsmClient } from "./services/client.js";
import type { AnyToolDefinition } from "./tools/define.js";
import { registerTools } from "./tools/define.js";
import { alertReadTools } from "./tools/alerts/index.js";
import { alertActionTools } from "./tools/actions/index.js";
import { onCallTools } from "./tools/oncall/index.js";

/** Every tool this server exposes, in the order they are registered. */
export const allTools: AnyToolDefinition[] = [
  ...alertReadTools,
  ...alertActionTools,
  ...onCallTools,
];

export function buildServer(client: JsmClient): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerTools(server, client, allTools);
  return server;
}
