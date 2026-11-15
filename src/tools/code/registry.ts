/**
 * The operation catalogue, as the code API sees it.
 *
 * One object per tool, carrying the code name a script calls it by, whether
 * this process can actually dispatch it, and a lazily-built TypeScript
 * declaration. Built once per process — `jsm_search_api` and `jsm_read_api`
 * read it on every call, and running 94 shapes through z.toJSONSchema per call
 * would be work with no reason to repeat.
 *
 * It holds the WHOLE catalogue, not just what this process registered, and
 * marks each entry `available`. That split is deliberate and it is the same
 * argument jsm_list_capabilities makes: a model that cannot find an operation
 * will tell the user the server cannot do it. Searching wider than we can
 * dispatch, and saying which is which, is what stops that.
 */

import { z } from "zod";

import { argumentsText } from "../../codegen/signature.js";
import type { ToolGroup } from "../../toolsets.js";
import type { AnyToolDefinition } from "../define.js";

/** How a script may use an operation, and how a client should treat it. */
export type OperationKind = "read" | "write" | "destructive";

export interface Operation {
  /** What a script calls it: `jsm_list_alerts` -> `listAlerts`. */
  codeName: string;
  toolName: string;
  toolset: ToolGroup;
  kind: OperationKind;
  /** Whether this process can dispatch it: its toolset is loaded and it has a data layer. */
  available: boolean;
  /** Why it is not available, when it is not. Reuses jsm_list_capabilities' wording. */
  unavailableReason?: string;
  /** True for the auto-pageable reads, which also get a `listAll*` form. */
  pageable: boolean;
  tool: AnyToolDefinition;
  /** The description's first line. Written as a standalone summary in every case. */
  summary: string;
  /** The TypeScript argument type. Memoised: an operation nobody reads never pays. */
  declaration(): string;
}

export interface SearchQuery {
  query?: string | undefined;
  toolset?: string | undefined;
  kind?: "read" | "write" | "any" | undefined;
  limit?: number | undefined;
}

export interface OperationRegistry {
  /** Every operation in the catalogue, available or not. */
  all(): readonly Operation[];
  /** By code name (`listAlerts`) or tool name (`jsm_list_alerts`). Both are accepted. */
  find(name: string): Operation | undefined;
  search(query: SearchQuery): readonly Operation[];
  /** The ones this process can dispatch. */
  reachable(): readonly Operation[];
  /** Code names of the reachable operations, sorted — the index a description embeds. */
  index(): readonly string[];
}

/** `jsm_list_alerts` -> `listAlerts`. Mechanical, so it inherits tool names' stability. */
export function toCodeName(toolName: string): string {
  return toolName
    .replace(/^jsm_/, "")
    .split("_")
    .map((part, position) => (position === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join("");
}

function kindOf(tool: AnyToolDefinition): OperationKind {
  if (tool.annotations.readOnlyHint) return "read";
  return tool.annotations.destructiveHint ? "destructive" : "write";
}

/**
 * The first line of the description.
 *
 * Not a generated or shortened summary: every description in this catalogue
 * opens with a standalone sentence (median 71 characters), written by hand, and
 * algorithmically rewriting prose is how the knowledge in it stops being
 * written — the argument family.ts makes about never generating descriptions.
 */
function summaryOf(tool: AnyToolDefinition): string {
  return tool.description.split("\n", 1)[0]?.trim() ?? tool.title;
}

/** Only a GET collection can be asked for a later page, and only some dialects can. */
function isPageable(tool: AnyToolDefinition): boolean {
  if (!tool.plan) return false;
  try {
    // The plan needs arguments to build a path, and we only want its shape.
    // A probe with empty arguments is enough for that and cannot reach the
    // network; a plan that throws on it is simply reported as not pageable.
    const probe = tool.plan({} as never);
    if (probe.shape !== "collection") return false;
    const kind = probe.paging?.kind ?? "offset";
    return kind === "offset" || kind === "cursor" || kind === "token";
  } catch {
    return false;
  }
}

/** Builds the registry. `reachable` is the set of tool names this process may dispatch. */
export function createRegistry(
  catalogue: readonly AnyToolDefinition[],
  reachable: ReadonlySet<string>,
): OperationRegistry {
  const operations: Operation[] = catalogue.map((tool) => {
    const hasDataLayer = Boolean(tool.plan ?? tool.fetch);
    const available = hasDataLayer && reachable.has(tool.name);
    let declaration: string | undefined;

    return {
      codeName: toCodeName(tool.name),
      toolName: tool.name,
      toolset: tool.toolset,
      kind: kindOf(tool),
      available,
      ...(available
        ? {}
        : {
            unavailableReason: hasDataLayer
              ? `Not loaded. Enable it by adding '${tool.toolset}' to the JSM_TOOLSETS ` +
                `environment variable where this server is configured, then restarting it.`
              : `This operation has no code-API data layer, so it can only be called as the ` +
                `classic tool ${tool.name}.`,
          }),
      pageable: isPageable(tool),
      tool,
      summary: summaryOf(tool),
      declaration() {
        declaration ??= argumentsText(tool.inputSchema);
        return declaration;
      },
    };
  });

  const byCodeName = new Map(operations.map((operation) => [operation.codeName, operation]));
  const byToolName = new Map(operations.map((operation) => [operation.toolName, operation]));

  /** Everything a query may match against, lowercased once per operation. */
  const haystacks = new Map(
    operations.map((operation) => [
      operation.codeName,
      {
        code: operation.codeName.toLowerCase(),
        tool: operation.toolName.toLowerCase(),
        // The title is searched because it is often the plainest statement of
        // what an operation does: "Reorder a routing rule" is the word someone
        // would type, and it appears in no other field —
        // jsm_change_routing_rule_order was unfindable by "reorder" without it.
        title: operation.tool.title.toLowerCase(),
        summary: operation.summary.toLowerCase(),
        toolset: operation.toolset.toLowerCase(),
        paths: [operation.tool.endpoint]
          .flat()
          .map((endpoint) => endpoint?.path.toLowerCase() ?? "")
          .join(" "),
        description: operation.tool.description.toLowerCase(),
      },
    ]),
  );

  /**
   * Tiered rather than weighted: an exact name match must always outrank a
   * description that happens to mention the word, and tiers say that plainly.
   *
   * Two needles are tried against the names, not one. A code name is camelCase
   * with no separators, so "on call" matched nothing in `getoncall` and the
   * results came back ranked by whichever descriptions happened to contain the
   * phrase — `createOverride` and `assignAlert` ahead of `getOnCall`. Squashing
   * the terms gives "oncall", which is how the name is actually spelled.
   */
  const score = (operation: Operation, terms: string[], requireAll = true): number => {
    const hay = haystacks.get(operation.codeName);
    if (!hay) return Number.POSITIVE_INFINITY;

    const everything = `${hay.code} ${hay.tool} ${hay.title} ${hay.summary} ${hay.toolset} ${hay.paths} ${hay.description}`;
    // Every term has to appear somewhere, so a second word narrows rather than
    // widens — "routing rule" must not match everything matching "rule".
    const matched = terms.filter((term) => everything.includes(term));
    if (requireAll ? matched.length !== terms.length : matched.length === 0) {
      return Number.POSITIVE_INFINITY;
    }

    const phrase = terms.join(" ");
    const squashed = terms.join("");
    const needles = squashed === phrase ? [phrase] : [squashed, phrase];

    for (const needle of needles) {
      if (hay.code === needle) return 0;
      if (hay.code.startsWith(needle)) return 1;
      if (hay.code.includes(needle)) return 2;
      if (hay.tool.includes(needle)) return 3;
    }
    for (const needle of needles) {
      if (hay.title.includes(needle)) return 4;
      if (hay.summary.includes(needle)) return 5;
      if (hay.toolset.includes(needle)) return 6;
      if (hay.paths.includes(needle)) return 7;
    }
    // Every term is somewhere, but nothing matched as a phrase: still a hit,
    // just the weakest kind.
    return 8;
  };

  return {
    all: () => operations,
    find: (name) => byCodeName.get(name) ?? byToolName.get(name),
    reachable: () => operations.filter((operation) => operation.available),
    index: () =>
      operations
        .filter((operation) => operation.available)
        .map((operation) => operation.codeName)
        .sort(),
    search({ query, toolset, kind = "any", limit }) {
      const needle = query?.trim().toLowerCase();
      let hits = operations.filter((operation) => {
        if (toolset && operation.toolset !== toolset) return false;
        if (kind === "read" && operation.kind !== "read") return false;
        if (kind === "write" && operation.kind === "read") return false;
        return true;
      });

      if (needle) {
        const terms = needle.split(/\s+/).filter(Boolean);
        const rank = (requireAll: boolean) =>
          hits
            .map((operation) => ({ operation, rank: score(operation, terms, requireAll) }))
            .filter((entry) => Number.isFinite(entry.rank))
            .sort(
              (a, b) =>
                a.rank - b.rank ||
                // Within a tier, shorter is closer to what was typed. Without
                // this, "listAlert" suggested listAlertAttachments,
                // listAlertLogs and listAlertNotes — all of which share the
                // prefix — and pushed listAlerts out of the top three.
                a.operation.codeName.length - b.operation.codeName.length ||
                a.operation.codeName.localeCompare(b.operation.codeName),
            )
            .map((entry) => entry.operation);

        const strict = rank(true);
        // A model may type a question rather than keywords — "who gets
        // notified" has no operation containing the word "who", and requiring
        // every term returns nothing at all. Falling back to any-term matching
        // turns that into a useful list instead of a dead end, while leaving
        // precise queries ranked exactly as before: the fallback only runs when
        // the strict pass found nothing.
        hits = strict.length || terms.length < 2 ? strict : rank(false);
      } else {
        hits = [...hits].sort((a, b) => a.codeName.localeCompare(b.codeName));
      }

      return limit === undefined ? hits : hits.slice(0, limit);
    },
  };
}

/** The shape every tool's arguments are validated against before dispatch. */
export function argumentSchema(tool: AnyToolDefinition): z.ZodType {
  return z.strictObject(tool.inputSchema);
}
