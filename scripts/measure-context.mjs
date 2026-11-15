#!/usr/bin/env node
/**
 * What each selection costs a client before it reads a request.
 *
 * The README quotes numbers from this script rather than from anybody's blog
 * post. Code execution with MCP reports tool definitions falling from 150,000
 * tokens to 2,000 — a 98.7% saving — but that baseline is a multi-server
 * aggregate with no toolset mechanism, and this server already paid part of
 * that cost in toolsets.ts. Its remaining headroom is smaller, and saying so is
 * more persuasive than quoting a number that was measured somewhere else.
 *
 * Characters are the hard figure: they are what the transport sends. The token
 * column is chars/4, an estimate, and labelled as one — the real count depends
 * on the tokeniser and nothing here knows which one a client uses.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { allTools, buildServer } from "../src/server.ts";
import { JsmClient, loadConfig } from "../src/services/client.ts";
import { PROFILE_NAMES, TOOLSETS, resolveSelection } from "../src/toolsets.ts";

const client = new JsmClient(loadConfig({ JSM_CLOUD_ID: "cloud-id", JSM_OAUTH_TOKEN: "bearer" }));

async function measure(names) {
  const selection = resolveSelection(allTools, { env: { JSM_TOOLSETS: names } });
  const server = buildServer(client, selection);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "measure", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  try {
    const listed = await mcp.listTools();
    // The tools array as the transport serialises it. The JSON-RPC envelope
    // around it is a constant and would only blur the comparison.
    const chars = JSON.stringify(listed.tools).length;
    return { tools: listed.tools.length, chars };
  } finally {
    await mcp.close();
    await server.close();
  }
}

const rows = [];
for (const profile of PROFILE_NAMES) {
  rows.push({ selection: profile, ...(await measure(profile)) });
}
rows.push({ selection: "every toolset", ...(await measure([...TOOLSETS].join(","))) });

const pad = (value, width) => String(value).padStart(width);
console.log("selection          tools     chars    ~tokens");
console.log("--------------------------------------------- ");
for (const row of rows) {
  console.log(
    `${row.selection.padEnd(18)}${pad(row.tools, 5)}${pad(row.chars.toLocaleString("en-GB"), 10)}${pad(Math.round(row.chars / 4).toLocaleString("en-GB"), 11)}`,
  );
}

const code = rows.find((row) => row.selection === "code");
const responder = rows.find((row) => row.selection === "responder");
const everything = rows.find((row) => row.selection === "every toolset");

if (code && responder && everything) {
  const cut = (from) => `${Math.round((1 - code.chars / from.chars) * 100)}%`;
  console.log("");
  console.log(`code mode vs the 'responder' default: -${cut(responder)}`);
  console.log(`code mode vs every toolset:           -${cut(everything)}`);
  console.log("");
  console.log("~tokens is chars/4, an estimate. Characters are what the transport sends.");
}
