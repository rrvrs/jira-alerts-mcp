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
  /** Every request the tool issued, in order — JSM and Jira alike. */
  calls: Array<{
    path: string;
    params?: Record<string, unknown> | undefined;
    /** Set for calls that went through `request`, i.e. every write. */
    method?: string;
    body?: unknown;
    /** The itemsKey a list tool asked getCollection to read, if any. */
    itemsKey?: string | undefined;
  }>;
}

export interface StubOptions {
  /**
   * Responses keyed by path substring, for tools that issue more than one GET
   * (resolving a schedule name, then asking who is on-call). First match wins;
   * anything unmatched falls back to `page`.
   */
  routes?: Array<{ match: string; page?: Paged<unknown>; one?: unknown; error?: unknown }>;
  /** Response for client.jiraGet, or an error to throw from it. */
  jira?: unknown;
  jiraError?: unknown;
  /** Response body for client.request — the path every write takes. */
  write?: unknown;
  /** Thrown from client.request instead of returning `write`. */
  writeError?: unknown;
}

/**
 * A JsmClient that records requests and serves fixed responses, so tools can be
 * driven end to end without a network or a tenant.
 */
export function stubClient(
  page: Paged<unknown> = { items: [] },
  options: StubOptions = {},
): StubClient {
  const calls: StubClient["calls"] = [];
  const route = (path: string) => options.routes?.find((r) => path.includes(r.match));

  const client = new (class extends JsmClient {
    override async request<T>(
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
      path: string,
      requestOptions: { params?: Record<string, unknown> | undefined; body?: unknown } = {},
    ): Promise<T> {
      calls.push({ path, method, body: requestOptions.body, params: requestOptions.params });
      if (options.writeError) throw options.writeError;
      return (options.write ?? {}) as T;
    }

    override async getCollection<T>(
      path: string,
      params?: Record<string, unknown>,
      collectionOptions: { itemsKey?: string | undefined } = {},
    ): Promise<Paged<T>> {
      calls.push({ path, params, itemsKey: collectionOptions.itemsKey });
      const matched = route(path);
      if (matched?.error) throw matched.error;
      return (matched?.page ?? page) as Paged<T>;
    }

    override async getOne<T>(path: string, params?: Record<string, unknown>): Promise<T> {
      calls.push({ path, params });
      const matched = route(path);
      if (matched?.error) throw matched.error;
      if (matched) return (matched.one ?? matched.page?.items[0] ?? {}) as T;
      return (page.items[0] ?? {}) as T;
    }

    override async jiraGet<T>(path: string, params?: Record<string, unknown>): Promise<T> {
      calls.push({ path, params });
      if (options.jiraError) throw options.jiraError;
      return (options.jira ?? {}) as T;
    }
  })(testConfig);

  return { client, calls };
}

/** An axios-shaped error, for exercising the API error paths. */
export function httpError(status: number): Error & { isAxiosError: true } {
  return Object.assign(new Error(`HTTP ${status}`), {
    isAxiosError: true as const,
    response: { status, data: {} },
  });
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
