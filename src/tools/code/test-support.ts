/**
 * Argument synthesis for the catalogue-wide sweeps.
 *
 * The parity sweep has to drive ninety-odd tools, which means ninety-odd sets
 * of valid arguments. Hand-writing them would be the same counted gap
 * catalogue.test.ts describes: forty tools in no test file, closed by writing
 * forty near-identical cases that the next family reopens. Synthesising them
 * from each tool's own schema covers every tool that exists now and every tool
 * added later.
 *
 * Not a `.test.ts` file so the suite can import it, and excluded from `dist` by
 * tsconfig's `exclude`, which matches `src/**​/test-support.ts` at any depth.
 */

import { z } from "zod";

/** The subset of JSON Schema `z.toJSONSchema` emits for these input shapes. */
interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  format?: string;
  additionalProperties?: boolean | JsonSchema;
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  default?: unknown;
}

/**
 * Per-tool argument overrides, for the fields a shape cannot describe.
 *
 * A date has to parse, an offset has to stay inside the alert search window,
 * and an enum-of-one-real-value cannot be guessed. Every entry is a fact the
 * schema does not carry.
 *
 * Kept honest by a test that fails when an override stops being necessary —
 * the same rule `allowUnknownQuery` follows in the endpoint manifest, because
 * an unexplained allowance that nothing needs is how a wrong value becomes
 * permanent.
 */
export const ARG_OVERRIDES: Record<string, Record<string, unknown>> = {
  // `value`'s valid range depends on `field`, which a JSON Schema for this
  // shape cannot say — so the handler checks it and refuses a non-priority
  // locally rather than spending a round trip on a guaranteed 422. A
  // synthesised "x" takes that branch and the tool never reaches the network,
  // which reads as "the plan describes nothing" in the parity sweep.
  jsm_update_alert_field: { field: "priority", value: "P1" },
};

function valueFor(schema: JsonSchema, path: string): unknown {
  if (schema.const !== undefined) return schema.const;
  if (schema.enum?.length) return schema.enum[0];
  // A union: the first branch that yields something is as good as any, and
  // these shapes only use anyOf for nullable and for string|number ids.
  if (schema.anyOf?.length) return valueFor(schema.anyOf[0] as JsonSchema, path);
  if (schema.allOf?.length) return valueFor(schema.allOf[0] as JsonSchema, path);

  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;

  switch (type) {
    case "string":
      // Formats matter: a date-time that does not parse fails validation before
      // the handler is reached, and the failure would read as a tool bug.
      if (schema.format === "date-time") return "2026-01-01T00:00:00.000Z";
      if (schema.format === "date") return "2026-01-01";
      if (schema.format === "email") return "someone@example.com";
      if (schema.format === "uri" || schema.format === "url") return "https://example.com";
      return "x".repeat(Math.max(1, schema.minLength ?? 1));
    case "integer":
    case "number":
      return schema.minimum ?? 1;
    case "boolean":
      return true;
    case "array":
      return [valueFor(schema.items ?? { type: "string" }, `${path}[]`)];
    case "object":
      return objectFor(schema, path);
    case "null":
      return null;
    default:
      // No `type` and no enum: a passthrough or record. An empty object
      // satisfies both, and anything richer would be inventing a requirement.
      return schema.properties || schema.additionalProperties ? objectFor(schema, path) : {};
  }
}

function objectFor(schema: JsonSchema, path: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // Required fields only. Optional ones are left out on purpose so each tool's
  // own zod defaults apply, which is what a real call looks like.
  for (const key of schema.required ?? []) {
    const property = schema.properties?.[key];
    if (property) out[key] = valueFor(property, `${path}.${key}`);
  }
  return out;
}

/**
 * The smallest valid argument object for a raw Zod input shape.
 *
 * Goes through `z.toJSONSchema` rather than reading zod internals: it is the
 * public, documented API, and `_zod.def` churns across minor versions.
 */
export function minimalArgs(
  shape: z.ZodRawShape,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const schema = z.toJSONSchema(z.strictObject(shape), { io: "input" }) as JsonSchema;
  return { ...objectFor(schema, ""), ...overrides };
}
