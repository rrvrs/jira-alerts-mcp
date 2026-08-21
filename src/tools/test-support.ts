/**
 * Test helpers for driving tools the way a real MCP client does.
 *
 * The distinction matters. Invoking a registered handler directly skips the
 * SDK's output-schema validation, and that is exactly how a bug shipped in
 * which every list tool returned `-32602 Output validation error` for an empty
 * result set: the handler returned a perfectly sensible message, and the SDK
 * rejected it for carrying no structuredContent. Tests that go through a real
 * McpServer catch that; tests that call handlers directly certify it as fine.
 *
 * Not a `.test.ts` file so the suite can import it, and excluded from `dist`
 * by tsconfig's `exclude`.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer as McpServerImpl } from "@modelcontextprotocol/sdk/server/mcp.js";

import { JsmClient, loadConfig } from "../services/client.js";
import { registerTools, type AnyToolDefinition } from "./define.js";
import type { ToolResult } from "../services/format.js";
import type { Paged } from "../types.js";

/** Credentials good enough to construct a JsmClient. No request is ever sent. */
export const testConfig = loadConfig({
  JSM_CLOUD_ID: "cloud-id",
  JSM_OAUTH_TOKEN: "bearer",
} as NodeJS.ProcessEnv);

export interface StubClient {
  client: JsmClient;
  /** Every collection request the tool issued, in order. */
  calls: Array<{ path: string; params?: Record<string, unknown> }>;
}

/**
 * A JsmClient that records requests and serves a fixed page, so tools can be
 * driven end to end without a network or a tenant.
 */
export function stubClient(page: Paged<unknown> = { items: [] }): StubClient {
  const calls: StubClient["calls"] = [];

  const client = new (class extends JsmClient {
    override async getCollection<T>(
      path: string,
      params?: Record<string, unknown>,
    ): Promise<Paged<T>> {
      calls.push({ path, params });
      return page as Paged<T>;
    }

    override async getOne<T>(path: string, params?: Record<string, unknown>): Promise<T> {
      calls.push({ path, params });
      return (page.items[0] ?? {}) as T;
    }
  })(testConfig);

  return { client, calls };
}

/**
 * Stands up a real server and client over an in-memory transport. Tools called
 * through the returned client go through argument parsing, the handler, and
 * output-schema validation — the same path a live MCP client takes.
 */
export async function connectTools(
  definitions: AnyToolDefinition[],
  client: JsmClient,
): Promise<Client> {
  const server = new McpServerImpl({ name: "test", version: "0.0.0" });
  registerTools(server, client, definitions);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);

  return mcpClient;
}

/** Calls a tool and returns the result in the shape the tools produce. */
export async function callTool(
  mcpClient: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  return (await mcpClient.callTool({ name, arguments: args })) as unknown as ToolResult;
}

/** The text a model would actually read from a tool result. */
export function textOf(result: ToolResult): string {
  return result.content[0]?.text ?? "";
}
