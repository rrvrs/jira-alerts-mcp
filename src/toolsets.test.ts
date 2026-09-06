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
  TOOLSET_INFO,
  ToolsetSelectionError,
  TOOLSETS,
  UNVERIFIED_TOOLSETS,
  VERIFIED_TOOLSETS,
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

  it("registers every VERIFIED toolset under `all`, and no others", () => {
    // `all` deliberately does not mean every toolset. A family that has never
    // been seen to work against a live tenant ships, but has to be named on
    // its own — otherwise asking for everything quietly hands someone tools
    // whose only evidence is that they compile.
    const selection = resolveSelection(allTools, { env: { JSM_TOOLSETS: "all" } });

    assert.deepEqual(selection.toolsets, [...VERIFIED_TOOLSETS]);
    assert.ok(VERIFIED_TOOLSETS.length < TOOLSETS.length, "there should be quarantined toolsets");
    for (const toolset of UNVERIFIED_TOOLSETS) {
      assert.ok(
        !selection.toolsets.includes(toolset),
        `'all' pulled in ${toolset}, which is unverified`,
      );
    }
  });

  it("keeps every unverified toolset out of every profile", () => {
    // The invariant 2.0.0 is built on: everything a profile can load has
    // returned a real success against the API. Removing a family's
    // `unverified` reason is the one edit that lets it back in, and that edit
    // has to explain itself.
    for (const [profileName, profile] of Object.entries(PROFILES)) {
      for (const toolset of profile.toolsets) {
        assert.ok(
          !TOOLSET_INFO[toolset].unverified,
          `profile '${profileName}' loads '${toolset}', which is marked unverified`,
        );
      }
    }
  });

  it("still lets someone name an unverified toolset explicitly", () => {
    // Quarantine, not deletion — a site whose plan includes heartbeats has to
    // have a way in, and this is it.
    const selection = resolveSelection(allTools, {
      env: { JSM_TOOLSETS: "all,heartbeats" } as NodeJS.ProcessEnv,
    });

    assert.ok(selection.toolsets.includes("heartbeats"));
    assert.ok(names(selection).includes("jsm_list_heartbeats"));
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

  it("registers every verified tool for 'all', and nothing quarantined", () => {
    const selection = resolveSelection(allTools, {
      env: { JSM_TOOLSETS: "all" } as NodeJS.ProcessEnv,
    });

    assert.deepEqual(
      names(selection),
      allTools
        .filter((tool) => !UNVERIFIED_TOOLSETS.includes(tool.toolset as never))
        .map((tool) => tool.name),
    );
  });

  it("keeps core's frozen list when a toolset is named beside it", () => {
    // The bug this replaces: a profile's `only` list was cleared globally by
    // any bare toolset, so `core,schedules` handed back every tool in both
    // families — including jsm_delete_alert, which core exists to exclude.
    // core is frozen so an install's auto-approval surface cannot widen under
    // it, and names are documented to combine freely; intersecting keeps both.
    const core = resolveSelection(allTools, {
      env: { JSM_TOOLSETS: "core" } as NodeJS.ProcessEnv,
    });
    const schedules = resolveSelection(allTools, {
      env: { JSM_TOOLSETS: "schedules" } as NodeJS.ProcessEnv,
    });
    const combined = resolveSelection(allTools, {
      env: { JSM_TOOLSETS: "core,schedules" } as NodeJS.ProcessEnv,
    });

    assert.deepEqual(
      names(combined).sort(),
      [...new Set([...names(core), ...names(schedules)])].sort(),
    );
    assert.equal(names(combined).includes("jsm_delete_alert"), false);
    assert.equal(names(combined).includes("jsm_delete_alert_note"), false);
  });

  it("lets an open profile widen a toolset core restricts", () => {
    // The other direction: responder is open over alerts, alert-actions and
    // oncall, so combining it with core is still the whole responder surface.
    // Intersecting per name must not turn a union into an intersection.
    const responder = resolveSelection(allTools, {
      env: { JSM_TOOLSETS: "responder" } as NodeJS.ProcessEnv,
    });
    const combined = resolveSelection(allTools, {
      env: { JSM_TOOLSETS: "core,responder" } as NodeJS.ProcessEnv,
    });

    assert.deepEqual(names(combined).sort(), names(responder).sort());
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

  it("blames read-only, not the selection, for a family whose tools all write", async () => {
    // alert-actions is entirely writes, so read-only leaves it with no
    // registered tools and it reports as "off". It was then given the generic
    // advice — add it to JSM_TOOLSETS — which does nothing at all: it is
    // already selected, and read-only is what withheld it.
    const selection = resolveSelection(allTools, {
      env: { JSM_READ_ONLY: "true" } as NodeJS.ProcessEnv,
    });
    const mcp = await connectServer(client, selection);

    const text = textOf(await callTool(mcp, "jsm_list_capabilities"));
    const section = text.slice(text.indexOf("### alert-actions"));
    const entry = section.slice(0, section.indexOf("###", 1));

    assert.match(entry, /read-only mode withheld them/);
    assert.doesNotMatch(entry, /Enable it by adding/);
    // oncall is not selected here at all, so it still gets the generic advice.
    const off = text.slice(text.indexOf("### maintenance"));
    assert.match(off.slice(0, off.indexOf("###", 1)), /Enable it by adding/);
  });
});
