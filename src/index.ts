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

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { NextFunction, Request, Response } from "express";

import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { JsmClient, JsmConfigError, loadConfig } from "./services/client.js";
import { buildServer } from "./server.js";

async function runStdio(client: JsmClient): Promise<void> {
  const server = buildServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the protocol channel — all logging goes to stderr.
  console.error(`${SERVER_NAME} v${SERVER_VERSION} running via stdio`);
}

async function runHttp(client: JsmClient): Promise<void> {
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  // Bind to loopback by default: this server holds credentials and should not
  // be exposed on all interfaces without a deliberate decision.
  const host = process.env.HOST ?? "127.0.0.1";
  const allowedHosts = process.env.ALLOWED_HOSTS?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  // createMcpExpressApp installs Host-header validation as well as
  // express.json(). Binding to loopback is NOT sufficient on its own: without
  // this check any web page the user visits can POST to 127.0.0.1 and drive
  // every tool with our Atlassian credentials (DNS rebinding). The SDK warns
  // on the console if you bind wide without setting ALLOWED_HOSTS.
  const app = createMcpExpressApp({
    host,
    ...(allowedHosts?.length ? { allowedHosts } : {}),
  });

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", server: SERVER_NAME, version: SERVER_VERSION });
  });

  app.post("/mcp", async (req, res, next) => {
    // A fresh stateless transport per request avoids request-id collisions
    // between concurrent clients.
    const server = buildServer(client);
    // @ts-expect-error The SDK types sessionIdGenerator as `?: () => string`, but
    // its own docs give `sessionIdGenerator: undefined` as the way to select
    // stateless mode. Under exactOptionalPropertyTypes those disagree. Dropping
    // the key to satisfy the compiler would change which mode we run in, so the
    // key stays and the error is suppressed. Remove this once the SDK's types
    // admit undefined — an unused suppression fails the build and says so.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      // @ts-expect-error Transport declares `sessionId?: string` while
      // StreamableHTTPServerTransport declares `get sessionId(): string | undefined`
      // — a required property whose type includes undefined. Under
      // exactOptionalPropertyTypes the SDK's own class does not satisfy its own
      // interface (same for onclose/onerror/onmessage). Nothing to fix on our side.
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      // Express 5 forwards a rejected async handler to the error middleware on
      // its own, so this catch is not what keeps a bad request from becoming a
      // fatal unhandled rejection. It is here to close the transport and server
      // before handing off — without it, a failed request leaks both.
      void transport.close();
      void server.close();
      next(error);
    }
  });

  // Stateless mode supports POST only. Say so, rather than letting Express
  // return its default 404 HTML to a client probing for an SSE stream.
  app.all("/mcp", (_req, res) => {
    res
      .status(405)
      .set("Allow", "POST")
      .json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed. This endpoint accepts POST only." },
        id: null,
      });
  });

  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("Request failed:", error.message);
    if (res.headersSent) return;

    // body-parser rejects a malformed body with an http-errors 400. That is the
    // client's mistake, not ours, and -32700 is the JSON-RPC code for it.
    const status =
      (error as { status?: number; statusCode?: number }).status ??
      (error as { statusCode?: number }).statusCode ??
      500;
    const isClientError = status >= 400 && status < 500;

    res.status(isClientError ? status : 500).json({
      jsonrpc: "2.0",
      error: isClientError
        ? { code: -32700, message: "Parse error: request body is not valid JSON" }
        : { code: -32603, message: "Internal server error" },
      id: null,
    });
  });

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
        "  ALLOWED_HOSTS   Comma-separated Host allowlist for the HTTP transport;",
        "                  required when binding beyond loopback",
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
