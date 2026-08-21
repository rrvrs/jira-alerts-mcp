#!/usr/bin/env node
/**
 * MCP server for Jira Service Management Operations (alerts & on-call).
 *
 * Covers the alert and on-call surface that the Atlassian Rovo connector does
 * not expose: alert search and detail, notes and activity logs, acknowledge /
 * close / annotate / add-responder, and current + next on-call lookup.
 *
 * Transports: stdio by default; streamable HTTP with TRANSPORT=http.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";

import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { JsmClient, JsmConfigError, loadConfig } from "./services/client.js";
import { registerAlertReadTools } from "./tools/alerts.js";
import { registerAlertActionTools } from "./tools/alert-actions.js";
import { registerOnCallTools } from "./tools/oncall.js";

function buildServer(client: JsmClient): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  registerAlertReadTools(server, client);
  registerAlertActionTools(server, client);
  registerOnCallTools(server, client);

  return server;
}

async function runStdio(client: JsmClient): Promise<void> {
  const server = buildServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the protocol channel — all logging goes to stderr.
  console.error(`${SERVER_NAME} v${SERVER_VERSION} running via stdio`);
}

async function runHttp(client: JsmClient): Promise<void> {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", server: SERVER_NAME, version: SERVER_VERSION });
  });

  app.post("/mcp", async (req, res) => {
    // A fresh stateless transport per request avoids request-id collisions
    // between concurrent clients.
    const server = buildServer(client);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  // Bind to loopback by default: this server holds credentials and should not
  // be exposed on all interfaces without a deliberate decision.
  const host = process.env.HOST ?? "127.0.0.1";

  app.listen(port, host, () => {
    console.error(`${SERVER_NAME} v${SERVER_VERSION} listening on http://${host}:${port}/mcp`);
  });
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.error(
      [
        `${SERVER_NAME} v${SERVER_VERSION}`,
        "",
        "MCP server for Jira Service Management Operations alerts and on-call.",
        "",
        "Environment:",
        "  JSM_CLOUD_ID    (required) Atlassian site cloud id",
        "  JSM_EMAIL       Atlassian account email (with JSM_API_TOKEN)",
        "  JSM_API_TOKEN   Atlassian API token",
        "  JSM_OAUTH_TOKEN OAuth 3LO bearer token (alternative to email + token)",
        "  TRANSPORT       'stdio' (default) or 'http'",
        "  PORT / HOST     HTTP transport bind settings (default 127.0.0.1:3000)",
      ].join("\n"),
    );
    return;
  }

  let client: JsmClient;
  try {
    client = new JsmClient(loadConfig());
  } catch (error) {
    if (error instanceof JsmConfigError) {
      console.error(`Startup failed: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  if ((process.env.TRANSPORT ?? "stdio") === "http") {
    await runHttp(client);
  } else {
    await runStdio(client);
  }
}

main().catch((error: unknown) => {
  console.error("Fatal error:", error instanceof Error ? error.message : error);
  process.exit(1);
});
