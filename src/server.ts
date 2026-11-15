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
import { withModernDialect } from "./services/schema-dialect.js";
import type { Selection } from "./toolsets.js";
import { createCapabilitiesTool } from "./tools/capabilities.js";
import { createCodeMode } from "./tools/code/index.js";
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
];

/**
 * Every tool this process registers: the selection, code mode's dispatchers
 * when it is on, and jsm_list_capabilities either way.
 *
 * The last two are built here rather than resolved into the selection because
 * their descriptions report what THIS install can reach — the capabilities
 * tool explains a family that is off, and jsm_call embeds the list of
 * operations it can dispatch. A static description would be wrong on every
 * install but one.
 *
 * Exported so the wire snapshot and the TOOLS.md coverage test can read the
 * composed list rather than `allTools`, which does not contain either.
 */
export function composeTools(client: JsmClient, selection: Selection): AnyToolDefinition[] {
  const codeMode = selection.codeToolsets.length
    ? createCodeMode({
        catalogue: allTools,
        // Built from the selection, never from allTools: a dispatcher that
        // reached past what the operator enabled would make the toolset promise
        // meaningless.
        reachable: new Set(
          allTools
            .filter((tool) => (selection.codeToolsets as readonly string[]).includes(tool.toolset))
            .map((tool) => tool.name),
        ),
        client,
        readOnly: selection.readOnly,
      })
    : undefined;

  const registered = [...selection.tools, ...(codeMode?.tools ?? [])];
  return [
    ...registered,
    createCapabilitiesTool(allTools, selection, registered, codeMode?.sandbox),
  ];
}

/**
 * Builds a server exposing exactly `selection`, plus jsm_list_capabilities.
 *
 * The capabilities tool is added here rather than in the selection because it
 * is registered regardless: a selection that hides a family should still be
 * able to say so.
 */
export function buildServer(client: JsmClient, selection: Selection): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerTools(server, client, composeTools(client, selection));

  // Every transport this server is handed gets the dialect correction, so no
  // future call site can forget it — see services/schema-dialect.ts for why the
  // SDK's advertised schemas are unusable without it.
  const connect = server.connect.bind(server);
  server.connect = (transport) => connect(withModernDialect(transport));

  return server;
}
