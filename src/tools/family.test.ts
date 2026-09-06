/**
 * Tests for the resource-family factory.
 *
 * Driven through connectTools rather than by calling the handlers, for the same
 * reason the rest of the suite is: a 204 and an empty page both produce results
 * the SDK rejects outright when an outputSchema is declared, and calling the
 * handler directly would return a plausible object and prove nothing.
 *
 * The point of most of these is that the factory cannot quietly get a tool's
 * *safety* metadata wrong at scale. One forgotten `destructiveHint` in a
 * hand-written file is one tool a client auto-approves that it should have
 * prompted on; the same mistake in the factory is every delete tool in ten
 * families.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";

import { defineResourceFamily, type ResourceConfig } from "./family.js";
import { callTool, connectTools, stubClient, textOf } from "./test-support.js";

const resource: ResourceConfig = {
  toolset: "oncall",
  path: "/v1/widgets",
  noun: "widget",
  plural: "widgets",
  idParam: "widget_id",
  idField: z.string().min(1).describe("Widget id."),
};

interface Widget {
  id: string;
  name: string;
}

function family() {
  return defineResourceFamily<Widget>(resource, {
    list: {
      name: "jsm_list_widgets",
      title: "List widgets",
      description: "List widgets.",
      render: (items) => `# Widgets\n${items.map((i) => i.name).join(", ")}`,
      emptyMessage: "No widgets found. Try creating one.",
    },
    get: {
      name: "jsm_get_widget",
      title: "Get widget",
      description: "Get a widget.",
      render: (item) => `Widget ${item.name}`,
    },
    create: {
      name: "jsm_create_widget",
      title: "Create widget",
      description: "Create a widget.",
      input: { name: z.string() },
      toBody: (p) => ({ name: p.name }),
      bodyFields: ["name"],
      render: (item) => `Created ${item.name}`,
    },
    update: {
      name: "jsm_update_widget",
      title: "Update widget",
      description: "Update a widget.",
      input: { name: z.string() },
      toBody: (p) => ({ name: p.name }),
      bodyFields: ["name"],
      render: (item) => `Updated ${item.name}`,
    },
    remove: {
      name: "jsm_delete_widget",
      title: "Delete widget",
      description: "Delete a widget.",
    },
  });
}

const byName = (name: string) => family().find((t) => t.name === name);

describe("defineResourceFamily", () => {
  it("derives the annotation vector from the operation, not from the author", () => {
    // The reason the factory owns annotations at all: `destructiveHint` is the
    // field a client reads to decide whether to prompt, and it defaults to
    // "safe" when forgotten. Deriving it means a delete cannot be born
    // auto-approvable.
    assert.equal(byName("jsm_list_widgets")?.annotations.readOnlyHint, true);
    assert.equal(byName("jsm_get_widget")?.annotations.readOnlyHint, true);
    assert.equal(byName("jsm_create_widget")?.annotations.destructiveHint, false);
    assert.equal(byName("jsm_create_widget")?.annotations.idempotentHint, false);
    assert.equal(byName("jsm_update_widget")?.annotations.destructiveHint, true);
    assert.equal(byName("jsm_delete_widget")?.annotations.destructiveHint, true);
    assert.equal(byName("jsm_delete_widget")?.annotations.readOnlyHint, false);
  });

  it("declares an endpoint per operation, matching what the handler sends", () => {
    assert.deepEqual(byName("jsm_get_widget")?.endpoint, {
      method: "GET",
      path: "/v1/widgets/{id}",
    });
    assert.deepEqual(byName("jsm_create_widget")?.endpoint, {
      method: "POST",
      path: "/v1/widgets",
      body: ["name"],
    });
    assert.deepEqual(byName("jsm_delete_widget")?.endpoint, {
      method: "DELETE",
      path: "/v1/widgets/{id}",
    });
  });

  it("omits the operations a resource does not have", () => {
    // Not every resource has all five. Generating a delete tool for a resource
    // with no delete endpoint would ship a tool that only ever 404s.
    const partial = defineResourceFamily<Widget>(resource, {
      get: { name: "jsm_get_widget", title: "t", description: "d", render: () => "x" },
    });
    assert.deepEqual(
      partial.map((t) => t.name),
      ["jsm_get_widget"],
    );
  });

  it("lists through the shared executor, with the pagination block", async () => {
    const { client, calls } = stubClient({
      items: [{ id: "1", name: "one" }],
      paging: undefined,
      totalCount: 1,
    });
    const mcp = await connectTools(family(), client);

    const result = await callTool(mcp, "jsm_list_widgets", { limit: 5, offset: 10 });

    assert.match(textOf(result), /# Widgets/);
    assert.equal(calls[0]?.path, "/v1/widgets");
    assert.equal(calls[0]?.params?.size, 5);
    assert.equal(calls[0]?.params?.offset, 10);
    const structured = result.structuredContent as { pagination: { count: number } };
    assert.equal(structured.pagination.count, 1);
  });

  it("sends a declared query parameter even when the family maps no params", async () => {
    // toParams used to be the only route from `query` to the wire, so a family
    // that declared a filter and forgot to map it dropped it in silence — the
    // parameter was in the input shape, in the description and in the endpoint
    // manifest, and never in the request. jsm_list_maintenances shipped that way.
    const tools = defineResourceFamily<Widget>(resource, {
      list: {
        name: "jsm_list_widgets",
        title: "t",
        description: "d",
        query: { type: z.enum(["all", "past"]).optional() },
        render: (items) => `${items.length}`,
        emptyMessage: "none",
      },
    });
    const { client, calls } = stubClient({ items: [{ id: "1", name: "one" }] });
    const mcp = await connectTools(tools, client);

    await callTool(mcp, "jsm_list_widgets", { type: "past" });

    assert.equal(calls[0]?.params?.type, "past");
  });

  it("lets toParams rename a declared parameter, and does not also send the input name", async () => {
    const tools = defineResourceFamily<Widget>(resource, {
      list: {
        name: "jsm_list_widgets",
        title: "t",
        description: "d",
        query: { account_id: z.string().optional() },
        queryFields: ["accountId"],
        toParams: (p) => ({ accountId: p.account_id }),
        render: (items) => `${items.length}`,
        emptyMessage: "none",
      },
    });
    const { client, calls } = stubClient({ items: [{ id: "1", name: "one" }] });
    const mcp = await connectTools(tools, client);

    await callTool(mcp, "jsm_list_widgets", { account_id: "acc-1" });

    assert.equal(calls[0]?.params?.accountId, "acc-1");
    assert.ok(!("account_id" in (calls[0]?.params ?? {})));
  });

  it("returns the empty message rather than an empty render", async () => {
    const { client } = stubClient({ items: [] });
    const mcp = await connectTools(family(), client);

    const result = await callTool(mcp, "jsm_list_widgets", {});

    assert.match(textOf(result), /No widgets found/);
  });

  it("percent-encodes the id into every item path", async () => {
    const { client, calls } = stubClient({ items: [{ id: "a/b", name: "x" }] });
    const mcp = await connectTools(family(), client);

    await callTool(mcp, "jsm_get_widget", { widget_id: "a/b c" });

    assert.equal(calls[0]?.path, "/v1/widgets/a%2Fb%20c");
  });

  it("sends a PATCH to the item path on update, and the mapped body", async () => {
    const { client, calls } = stubClient({ items: [] }, { write: { id: "1", name: "renamed" } });
    const mcp = await connectTools(family(), client);

    const result = await callTool(mcp, "jsm_update_widget", { widget_id: "1", name: "renamed" });

    assert.equal(calls[0]?.method, "PATCH");
    assert.equal(calls[0]?.path, "/v1/widgets/1");
    assert.deepEqual(calls[0]?.body, { name: "renamed" });
    // Configuration writes are synchronous: the response is the object, so the
    // receipt must not point at jsm_get_request_status.
    assert.match(textOf(result), /Updated renamed/);
    assert.doesNotMatch(textOf(result), /jsm_get_request_status/);
  });

  it("reports a delete as a 204 with a structured payload, not an empty result", async () => {
    const { client, calls } = stubClient({ items: [] }, { write: undefined });
    const mcp = await connectTools(family(), client);

    const result = await callTool(mcp, "jsm_delete_widget", { widget_id: "1" });

    assert.equal(calls[0]?.method, "DELETE");
    assert.equal(calls[0]?.path, "/v1/widgets/1");
    assert.ok(result.structuredContent, "a 204 still has to ship structuredContent");
  });

  it("hands the prepared context to the renderer", async () => {
    // The knob jsm_list_schedules needs: one lookup for the whole page, so the
    // renderer stays synchronous and cannot make a call per row.
    const tools = defineResourceFamily<Widget, string>(resource, {
      list: {
        name: "jsm_list_widgets",
        title: "t",
        description: "d",
        prepare: async () => "PREPARED",
        render: (items, context) => `${context}: ${items.length}`,
        emptyMessage: "none",
      },
    });
    const { client } = stubClient({ items: [{ id: "1", name: "one" }] });
    const mcp = await connectTools(tools, client);

    assert.match(textOf(await callTool(mcp, "jsm_list_widgets", {})), /PREPARED: 1/);
  });
});
