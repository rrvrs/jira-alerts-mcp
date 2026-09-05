/**
 * Tests for tool selection.
 *
 * The default selection has a frozen snapshot here on purpose. Everything else
 * in this file describes behaviour; that one describes a promise to people who
 * already installed the server, and it should only change in a commit that says
 * why.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { allTools, buildServer } from "./server.js";
import {
  CORE_TOOL_NAMES,
  PROFILES,
  resolveSelection,
  ToolsetSelectionError,
  TOOLSETS,
} from "./toolsets.js";
import { callTool, stubClient, textOf } from "./tools/test-support.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { JsmClient } from "./services/client.js";
import type { Selection } from "./toolsets.js";

const names = (selection: Selection) => selection.tools.map((tool) => tool.name);

/** buildServer over an in-memory pair, so capabilities is exercised as registered. */
async function connectServer(client: JsmClient, selection: Selection): Promise<Client> {
  const server = buildServer(client, selection);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
  return mcpClient;
}

describe("resolveSelection", () => {
  it("defaults to the whole responder surface, and no further", () => {
    // The frozen default. `responder` is the alert-and-on-call surface, which
    // is what someone installing an alerts server is asking for — it is NOT
    // "every toolset that exists", and must not quietly become that as
    // configuration families land. A change here is a change to every existing
    // install's tool list and auto-approval surface, so it should be hard to
    // make by accident.
    const selection = resolveSelection(allTools);

    assert.deepEqual(selection.requested, ["responder"]);
    assert.deepEqual(selection.toolsets, [...PROFILES.responder.toolsets]);
    assert.deepEqual(
      names(selection),
      allTools
        .filter((tool) => (PROFILES.responder.toolsets as readonly string[]).includes(tool.toolset))
        .map((tool) => tool.name),
    );
    // Configuration families are not in it.
    assert.ok(!names(selection).includes("jsm_create_schedule"));
  });

  it("registers every toolset under `all`", () => {
    const selection = resolveSelection(allTools, { env: { JSM_TOOLSETS: "all" } });

    assert.deepEqual(selection.toolsets, [...TOOLSETS]);
    assert.deepEqual(
      names(selection),
      allTools.map((tool) => tool.name),
    );
  });

  it("still offers the pre-toolset thirteen, plus create, as `core`", () => {
    // Written out rather than compared against CORE_TOOL_NAMES on purpose.
    // Comparing the constant to itself would stay green through any edit and
    // guard nothing; the point is that changing this surface has to be typed
    // twice, in a change that says why.
    const selection = resolveSelection(allTools, {
      env: { JSM_TOOLSETS: "core" } as NodeJS.ProcessEnv,
    });

    assert.deepEqual(names(selection), [
      "jsm_list_alerts",
      "jsm_get_alert",
      "jsm_list_alert_notes",
      "jsm_list_alert_logs",
      "jsm_get_request_status",
      "jsm_create_alert",
      "jsm_acknowledge_alert",
      "jsm_close_alert",
      "jsm_add_alert_note",
      "jsm_add_alert_responder",
      "jsm_list_schedules",
      "jsm_get_on_call",
      "jsm_get_next_on_call",
      "jsm_get_schedule_timeline",
    ]);
  });

  it("keeps CORE_TOOL_NAMES in step with the catalogue", () => {
    // A name here that no tool answers to would silently shrink the default.
    const known = new Set(allTools.map((tool) => tool.name));
    assert.deepEqual(
      CORE_TOOL_NAMES.filter((name) => !known.has(name)),
      [],
    );
  });

  it("does not treat an unset variable as a request for everything", () => {
    // `responder` and `all` hold the same tools today because every toolset is
    // an alert or on-call one. They are not the same request, and when the
    // config families land, this is the assertion that will say so.
    const selection = resolveSelection(allTools, { env: {} as NodeJS.ProcessEnv });
    assert.deepEqual(selection.requested, ["responder"]);
  });

  it("expands a single toolset to just that family", () => {
    const selection = resolveSelection(allTools, {
      env: { JSM_TOOLSETS: "oncall" } as NodeJS.ProcessEnv,
    });

    assert.deepEqual(selection.toolsets, ["oncall"]);
    assert.ok(
      names(selection).every((name) => name.includes("on_call") || name.includes("schedule")),
    );
    assert.equal(names(selection).includes("jsm_list_alerts"), false);
  });

  it("combines several names", () => {
    const selection = resolveSelection(allTools, {
      env: { JSM_TOOLSETS: "alerts,oncall" } as NodeJS.ProcessEnv,
    });

    assert.deepEqual(selection.toolsets, ["alerts", "oncall"]);
    assert.equal(names(selection).includes("jsm_acknowledge_alert"), false);
  });

  it("registers the whole catalogue for 'all'", () => {
    const selection = resolveSelection(allTools, {
      env: { JSM_TOOLSETS: "all" } as NodeJS.ProcessEnv,
    });

    assert.deepEqual(
      names(selection),
      allTools.map((tool) => tool.name),
    );
  });

  it("keeps 'core' a narrower surface than the default", () => {
    const core = resolveSelection(allTools, {
      env: { JSM_TOOLSETS: "core" } as NodeJS.ProcessEnv,
    });

    assert.ok(core.tools.length < allTools.length);
  });

  it("ignores case and surrounding whitespace", () => {
    const selection = resolveSelection(allTools, {
      env: { JSM_TOOLSETS: " Alerts , ONCALL " } as NodeJS.ProcessEnv,
    });

    assert.deepEqual(selection.toolsets, ["alerts", "oncall"]);
  });

  it("lets a flag override the environment", () => {
    const selection = resolveSelection(allTools, {
      env: { JSM_TOOLSETS: "all" } as NodeJS.ProcessEnv,
      argv: ["node", "index.js", "--toolsets=oncall"],
    });

    assert.deepEqual(selection.toolsets, ["oncall"]);
  });

  it("rejects an unknown name instead of quietly registering less", () => {
    assert.throws(
      () =>
        resolveSelection(allTools, { env: { JSM_TOOLSETS: "alerts,oncal" } as NodeJS.ProcessEnv }),
      (error: unknown) => {
        assert.ok(error instanceof ToolsetSelectionError);
        assert.match(error.message, /Unknown toolset 'oncal'/);
        assert.match(error.message, /Did you mean 'oncall'\?/);
        assert.match(error.message, /Valid names: /);
        return true;
      },
    );
  });

  it("omits the suggestion when nothing is close", () => {
    assert.throws(
      () =>
        resolveSelection(allTools, {
          env: { JSM_TOOLSETS: "confluence" } as NodeJS.ProcessEnv,
        }),
      (error: unknown) => {
        assert.ok(error instanceof ToolsetSelectionError);
        assert.equal(/Did you mean/.test(error.message), false);
        return true;
      },
    );
  });

  it("withholds every write tool in read-only mode", () => {
    const selection = resolveSelection(allTools, {
      env: { JSM_TOOLSETS: "all", JSM_READ_ONLY: "true" } as NodeJS.ProcessEnv,
    });

    assert.ok(selection.readOnly);
    assert.ok(selection.tools.length > 0);
    assert.ok(selection.tools.every((tool) => tool.annotations.readOnlyHint));
    assert.equal(names(selection).includes("jsm_close_alert"), false);
  });

  it("accepts --read-only as well as the variable", () => {
    const selection = resolveSelection(allTools, {
      argv: ["node", "index.js", "--read-only"],
    });

    assert.ok(selection.readOnly);
  });

  it("treats a non-truthy JSM_READ_ONLY as off", () => {
    const selection = resolveSelection(allTools, {
      env: { JSM_READ_ONLY: "false" } as NodeJS.ProcessEnv,
    });

    assert.equal(selection.readOnly, false);
  });

  it("fails loudly when the selection would register nothing", () => {
    assert.throws(
      () =>
        resolveSelection(allTools, {
          env: { JSM_TOOLSETS: "alert-actions", JSM_READ_ONLY: "true" } as NodeJS.ProcessEnv,
        }),
      (error: unknown) => {
        assert.ok(error instanceof ToolsetSelectionError);
        assert.match(error.message, /registers no tools/);
        assert.match(error.message, /read-only/);
        return true;
      },
    );
  });

  it("gives every catalogue tool a toolset that can actually be selected", () => {
    // A tool whose toolset is not in TOOLSETS would be unreachable by any
    // selection — registered nowhere, and invisible to jsm_list_capabilities.
    const selectable = new Set<string>(TOOLSETS);
    const orphans = allTools.filter((tool) => !selectable.has(tool.toolset));
    assert.deepEqual(
      orphans.map((tool) => tool.name),
      [],
    );
  });
});

describe("jsm_list_capabilities", () => {
  let client: JsmClient;

  beforeEach(() => {
    client = stubClient().client;
  });

  it("is registered even when a selection hides nearly everything", async () => {
    const selection = resolveSelection(allTools, {
      env: { JSM_TOOLSETS: "oncall" } as NodeJS.ProcessEnv,
    });
    const mcp = await connectServer(client, selection);

    const listed = (await mcp.listTools()).tools.map((tool) => tool.name);
    assert.ok(listed.includes("jsm_list_capabilities"));
    assert.equal(listed.length, selection.tools.length + 1);
  });

  it("names the toolsets that are off and how to turn them on", async () => {
    const selection = resolveSelection(allTools, {
      env: { JSM_TOOLSETS: "oncall" } as NodeJS.ProcessEnv,
    });
    const mcp = await connectServer(client, selection);

    const text = textOf(await callTool(mcp, "jsm_list_capabilities"));
    assert.match(text, /alerts — off/);
    assert.match(text, /oncall — on/);
    assert.match(text, /JSM_TOOLSETS/);
  });

  it("reports scopes and counts in the structured payload", async () => {
    const selection = resolveSelection(allTools);
    const mcp = await connectServer(client, selection);

    const result = await callTool(mcp, "jsm_list_capabilities", { response_format: "json" });
    const payload = result.structuredContent as {
      tool_count: number;
      read_only: boolean;
      toolsets: Array<{ name: string; enabled: boolean; scopes: string[]; tool_count: number }>;
    };

    assert.equal(payload.tool_count, selection.tools.length);
    assert.equal(payload.read_only, false);
    assert.deepEqual(
      payload.toolsets.map((entry) => entry.name),
      [...TOOLSETS],
    );

    const oncall = payload.toolsets.find((entry) => entry.name === "oncall");
    assert.deepEqual(oncall?.scopes, ["read:ops-config:jira-service-management"]);
    assert.equal(oncall?.tool_count, 4);
  });

  it("says read-only is on, so an absent write tool is not read as unsupported", async () => {
    const selection = resolveSelection(allTools, {
      env: { JSM_TOOLSETS: "all", JSM_READ_ONLY: "true" } as NodeJS.ProcessEnv,
    });
    const mcp = await connectServer(client, selection);

    const text = textOf(await callTool(mcp, "jsm_list_capabilities"));
    assert.match(text, /Read-only mode is on/);
  });
});
