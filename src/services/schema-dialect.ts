/**
 * Re-declares advertised tool schemas as JSON Schema 2020-12.
 *
 * @modelcontextprotocol/sdk 1.30.0 advertises every tool schema as draft-07:
 * McpServer's tools/list handler calls `toJsonSchemaCompat` with only
 * `strictUnions` and `pipeStrategy`, and `mapMiniTarget` falls back to
 * 'draft-7' when no `target` is passed (server/zod-json-schema-compat.js).
 * Strict clients — Claude Code among them — compile `outputSchema` with an Ajv
 * that supports 2020-12 only, and reject the tool before it is ever called:
 *
 *   Tool 'jsm_list_alerts' has an invalid outputSchema: JSON Schema declares an
 *   unsupported dialect ("$schema": "http://json-schema.org/draft-07/schema#").
 *
 * That is every tool in this server, not a subset. `toJsonSchemaCompat` does
 * accept `target: 'draft-2020-12'`, but no McpServer or Server option reaches
 * it, so the correction has to happen on the wire.
 *
 * Rewriting only the `$schema` line is sound here because none of our schemas
 * use a construct the two dialects read differently — no `$ref`, no
 * `definitions`, no boolean `exclusiveMinimum`/`exclusiveMaximum`, no
 * tuple-form `items`. server.test.ts asserts that stays true as schemas grow.
 *
 * It also costs no validation: the SDK checks tool output by parsing the Zod
 * object in `validateToolOutput`, never the JSON Schema advertised here.
 *
 * Known upstream: typescript-sdk issues #2084 and #2721, with fixes open and
 * unmerged in PRs #2085 (since 2026-05) and #2653. 1.30.0 is the latest release
 * and still emits draft-07, so there is no version to upgrade to. Remove this
 * once one of those PRs ships — see docs/sdk-dialect-issue.md.
 */

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/** The dialect strict clients expect. Exported so tests assert the same string. */
export const SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

/** A tools/list entry, narrowed to the two fields carrying a dialect. */
interface AdvertisedTool {
  inputSchema?: { $schema?: string };
  outputSchema?: { $schema?: string };
}

/** Rewrites one schema's dialect, leaving a schema that declares none alone. */
function retarget(schema: { $schema?: string } | undefined): void {
  if (schema?.$schema !== undefined) {
    schema.$schema = SCHEMA_DIALECT;
  }
}

/**
 * Wraps `transport.send` so tools/list results leave with a modern dialect.
 *
 * Applied to the transport rather than the request handler because the handler
 * is built inside McpServer from private state; the transport is the one seam
 * the SDK actually exposes, so this survives SDK upgrades that do not fix the
 * underlying bug.
 */
export function withModernDialect<T extends Transport>(transport: T): T {
  const send = transport.send.bind(transport);

  transport.send = (message, options) => {
    const result: unknown = "result" in message ? message.result : undefined;
    const tools: unknown =
      result && typeof result === "object" && "tools" in result
        ? (result as { tools: unknown }).tools
        : undefined;

    if (Array.isArray(tools)) {
      for (const tool of tools as AdvertisedTool[]) {
        retarget(tool.inputSchema);
        retarget(tool.outputSchema);
      }
    }

    return send(message, options);
  };

  return transport;
}
