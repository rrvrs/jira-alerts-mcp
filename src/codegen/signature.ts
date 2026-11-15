/**
 * Zod input shapes rendered as TypeScript type text, for jsm_read_api.
 *
 * The model has to call these operations correctly from code it writes, so the
 * argument type is the part that has to be exact — which field is required,
 * which is an enum of three values, which is an array of objects. That is what
 * this file produces.
 *
 * It deliberately does NOT invent return types. A tool's `description` already
 * documents its response under "Returns (json format)", written by hand against
 * a live tenant, and generating a shape from the output schema would produce a
 * worse second description of the same thing — the mistake family.ts's header
 * warns about for prose, applied to types.
 *
 * Driven by `z.toJSONSchema`, the public documented API, rather than by zod's
 * `_zod.def` internals, which churn across minor versions. All 94 input shapes
 * in this catalogue convert without error; the kinds that appear are
 * string, number, integer, boolean, enum, array, object, record, optional and
 * default, nested no deeper than an array of flat objects.
 */

import { z } from "zod";

/** The subset of JSON Schema these shapes produce. */
export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
  description?: string;
  default?: unknown;
  additionalProperties?: boolean | JsonSchema;
  anyOf?: JsonSchema[];
  minimum?: number;
  maximum?: number;
  format?: string;
}

const INDENT = "  ";

/** `"a" | "b"`, or `string` for an enum of nothing (which should not happen). */
function enumText(values: unknown[]): string {
  return values.length ? values.map((value) => JSON.stringify(value)).join(" | ") : "unknown";
}

/**
 * A property key, quoted only when it is not a plain identifier.
 *
 * Every argument in this catalogue is snake_case and needs no quotes, but a
 * record's key pattern is not something this file gets to assume.
 */
function keyText(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
}

export function typeText(schema: JsonSchema, depth = 0): string {
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum?.length) return enumText(schema.enum);
  if (schema.anyOf?.length) {
    return [...new Set(schema.anyOf.map((branch) => typeText(branch, depth)))].join(" | ");
  }

  // `type` may be an array, which is JSON Schema's other way of writing a
  // union — zod 4 emits `type: ["string","number","boolean"]` for
  // `z.union([z.string(), z.number(), z.boolean()])` rather than an anyOf.
  // Reading only the first member silently narrowed every such field to
  // `string`, which is precisely the lie about a schema we have that this file
  // must not tell: jsm_add_alert_extra_properties accepts numbers and booleans
  // and the signature said it did not.
  if (Array.isArray(schema.type)) {
    const branches = schema.type.map((member) => typeText({ ...schema, type: member }, depth));
    return [...new Set(branches)].join(" | ");
  }

  switch (schema.type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return `${typeText(schema.items ?? {}, depth)}[]`;
    case "object":
      return objectText(schema, depth);
    default:
      // No `type`: a record or a passthrough. `additionalProperties` says which.
      if (schema.properties) return objectText(schema, depth);
      if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        return `Record<string, ${typeText(schema.additionalProperties, depth)}>`;
      }
      return "unknown";
  }
}

/**
 * An object type, one property per line with its description as a comment.
 *
 * Multi-line rather than inline because the descriptions are the point: a
 * model reading `query?: string` learns far less than one reading it next to
 * "field:value search, e.g. status:open AND priority:P1".
 */
export function objectText(schema: JsonSchema, depth = 0): string {
  const properties = Object.entries(schema.properties ?? {});
  if (!properties.length) {
    return schema.additionalProperties && typeof schema.additionalProperties === "object"
      ? `Record<string, ${typeText(schema.additionalProperties, depth)}>`
      : "Record<string, unknown>";
  }

  const required = new Set(schema.required ?? []);
  const pad = INDENT.repeat(depth + 1);
  const lines: string[] = ["{"];

  for (const [name, property] of properties) {
    const notes = [
      // Trailing punctuation trimmed before joining: most descriptions already
      // end in a full stop, and appending ". default 20" to one produced
      // "(1-100, default 20).. default 20".
      property.description?.replace(/\s*\.\s*$/, ""),
      property.default !== undefined ? `default ${JSON.stringify(property.default)}` : undefined,
    ].filter((note): note is string => Boolean(note));
    if (notes.length) lines.push(`${pad}/** ${notes.join(". ")}. */`);
    lines.push(
      `${pad}${keyText(name)}${required.has(name) ? "" : "?"}: ${typeText(property, depth + 1)};`,
    );
  }

  lines.push(`${INDENT.repeat(depth)}}`);
  return lines.join("\n");
}

/**
 * The argument type for a raw Zod input shape.
 *
 * `io: "input"` is what puts defaulted and optional fields outside `required`,
 * which is the difference between a signature a model can satisfy and one it
 * thinks demands every field.
 */
export function argumentsText(shape: z.ZodRawShape): string {
  const schema = z.toJSONSchema(z.strictObject(shape), { io: "input" }) as JsonSchema;
  return objectText(schema);
}
