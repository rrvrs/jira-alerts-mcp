import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { allTools } from "../server.js";
import { argumentsText, objectText, typeText } from "./signature.js";

describe("typeText", () => {
  it("renders the primitives", () => {
    assert.equal(typeText({ type: "string" }), "string");
    assert.equal(typeText({ type: "integer" }), "number");
    assert.equal(typeText({ type: "number" }), "number");
    assert.equal(typeText({ type: "boolean" }), "boolean");
  });

  it("renders an enum as a literal union, not as string", () => {
    // The whole value of a generated signature is that it says which three
    // values the API accepts. Collapsing to `string` would lose the only part
    // a model cannot guess.
    assert.equal(typeText({ enum: ["asc", "desc"] }), '"asc" | "desc"');
  });

  it("renders arrays and arrays of objects", () => {
    assert.equal(typeText({ type: "array", items: { type: "string" } }), "string[]");
    assert.equal(
      typeText({
        type: "array",
        items: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      }),
      "{\n  id: string;\n}[]",
    );
  });

  it("renders an open map as a Record", () => {
    assert.equal(typeText({ additionalProperties: { type: "string" } }), "Record<string, string>");
  });

  it("falls back to unknown rather than inventing a shape", () => {
    assert.equal(typeText({}), "unknown");
  });

  it("renders a type array as the union it is", () => {
    // JSON Schema's other way of spelling a union, and the one zod 4 emits for
    // z.union([z.string(), z.number(), z.boolean()]). Reading only type[0]
    // narrowed jsm_add_alert_extra_properties to Record<string, string> and
    // told a model that a number would be rejected.
    assert.equal(typeText({ type: ["string", "number", "boolean"] }), "string | number | boolean");
    assert.equal(typeText({ type: ["string", "null"] }), "string | null");
    assert.equal(
      typeText({ type: ["array", "null"], items: { type: "string" } }),
      "string[] | null",
    );
  });
});

describe("objectText", () => {
  it("marks optional properties and keeps required ones bare", () => {
    const text = objectText({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
      required: ["a"],
    });
    assert.match(text, /^\s*a: string;$/m);
    assert.match(text, /^\s*b\?: number;$/m);
  });

  it("carries the description into a doc comment, with the default", () => {
    const text = objectText({
      type: "object",
      properties: { limit: { type: "integer", description: "Page size (1-100).", default: 20 } },
    });
    assert.match(text, /\/\*\* Page size \(1-100\)\. default 20\. \*\//);
    // One full stop, not two: most descriptions already end in one.
    assert.ok(!text.includes(".."), `double punctuation in: ${text}`);
  });

  it("quotes a key that is not an identifier", () => {
    const text = objectText({ type: "object", properties: { "odd-key": { type: "string" } } });
    assert.match(text, /"odd-key"\?: string;/);
  });
});

describe("argumentsText over the real catalogue", () => {
  it("renders every tool's arguments without throwing", () => {
    for (const tool of allTools) {
      const text = argumentsText(tool.inputSchema);
      assert.ok(text.startsWith("{"), `${tool.name}: not an object type`);
    }
  });

  it("never emits `any` in a type position", () => {
    // `any` would be a lie about a schema we have. Checked against the type
    // lines only: the doc comments carry the tools' own prose, and
    // jsm_get_request_status legitimately says "returned by any alert write
    // tool" — scanning the whole text failed on an English sentence.
    for (const tool of allTools) {
      const types = argumentsText(tool.inputSchema)
        .split("\n")
        .filter((line) => !line.trim().startsWith("/**"))
        .join("\n");
      assert.ok(!/\bany\b/.test(types), `${tool.name}: emitted 'any' in a type`);
    }
  });

  it("puts defaulted fields outside required, or a model thinks they are mandatory", () => {
    // io: "input" is what does this. With the default (output) every defaulted
    // field reads as required and a model fills them all in.
    const listAlerts = allTools.find((tool) => tool.name === "jsm_list_alerts");
    assert.ok(listAlerts);
    const text = argumentsText(listAlerts.inputSchema);
    assert.match(text, /limit\?: number;/);
    assert.match(text, /response_format\?: "markdown" \| "json";/);
  });

  it("keeps a required field required", () => {
    const create = allTools.find((tool) => tool.name === "jsm_create_alert");
    assert.ok(create);
    assert.match(argumentsText(create.inputSchema), /^\s*message: string;$/m);
  });

  it("renders the gnarliest shapes in the catalogue", () => {
    // The three kinds that nest: array-of-object, enum-inside-array, open map.
    const create = allTools.find((tool) => tool.name === "jsm_create_alert");
    assert.ok(create);
    const text = argumentsText(create.inputSchema);
    assert.match(text, /responders\?: \{/);
    assert.match(text, /type: "user" \| "team" \| "escalation" \| "schedule";/);
    // An open map whose values are a union. Both tools that take extra
    // properties accept a string, a number or a boolean, and the signature has
    // to say all three: reading only the first member of the schema's `type`
    // array rendered this as Record<string, string> and told a model a number
    // would be rejected.
    assert.match(
      text,
      /extra_properties\?: Record<string, string \| number \| boolean>;/,
      "a type array must render as a union, not as its first member",
    );

    const add = allTools.find((tool) => tool.name === "jsm_add_alert_extra_properties");
    assert.ok(add);
    assert.match(
      argumentsText(add.inputSchema),
      /extra_properties: Record<string, string \| number \| boolean>;/,
    );
  });

  it("agrees with zod about what it rendered", () => {
    // A signature that claims a field is optional when zod requires it would
    // send a model down a path the server rejects. Checked by asking zod.
    for (const tool of allTools) {
      const schema = z.toJSONSchema(z.strictObject(tool.inputSchema), { io: "input" }) as {
        required?: string[];
        properties?: Record<string, unknown>;
      };
      const text = argumentsText(tool.inputSchema);
      for (const name of schema.required ?? []) {
        assert.match(
          text,
          new RegExp(`^\\s*${name}: `, "m"),
          `${tool.name}: ${name} is required but rendered optional`,
        );
      }
    }
  });
});
