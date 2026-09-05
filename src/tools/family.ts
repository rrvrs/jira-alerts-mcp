/**
 * A factory for the mechanical half of a resource family.
 *
 * Ten configuration families follow the same five shapes — list, get, create,
 * update, delete — and writing them out by hand would be a hundred files whose
 * differences are three lines each. What repeats is genuinely mechanical: path
 * interpolation, input-shape assembly, which executor to call, the pagination
 * output block, the endpoint manifest entry, and the annotation vector.
 *
 * WHAT THIS DELIBERATELY DOES NOT GENERATE: `description`, and a list's
 * `render` and `emptyMessage`. They are required, non-defaultable fields on
 * every operation, so a family that skips them does not compile. This is the
 * point of the whole file. A default renderer would emit JSON-shaped markdown
 * and a default description would emit the OpenAPI summary — and the
 * descriptions are the product here, because they carry what the spec does not
 * say: that writes are asynchronous, that tinyId is not an id, that API tokens
 * cannot delete. Generating prose is how that knowledge quietly stops being
 * written. Making it structurally mandatory is cheaper than a convention
 * everyone agrees with and nobody enforces.
 *
 * The escape hatch is that none of this is privileged: any operation can be
 * omitted here and hand-written as a plain `defineTool` in the same directory.
 * Heartbeats (identified by a query parameter rather than a path id) and the
 * policy enable/disable endpoints are expected to need exactly that. Chasing
 * the last awkward 30% would turn a factory into a DSL.
 */

import { z } from "zod";

import { handleApiError, type JsmClient } from "../services/client.js";
import { fail, ok } from "../services/format.js";
import {
  paginationOutputShape,
  limitField,
  offsetField,
  responseFormatField,
  type ResponseFormat,
} from "../schemas/common.js";
import { type AnyToolDefinition, defineTool, type EndpointDeclaration } from "./define.js";
import { executeList } from "./list-executor.js";
import { executeWrite } from "./execute-write.js";
import { DEFAULT_DIALECT, pagingQueryNames, type PagingDialect } from "./paging.js";
import type { ToolGroup } from "../toolsets.js";

/** A path parameter belonging to a resource above this one. */
export interface ParentParam {
  /** Input parameter name the model supplies, e.g. "schedule_id". */
  param: string;
  /** The brace token in `path`, matching the spec, e.g. "scheduleId". */
  token: string;
  /** How it is described to the model. Required: an id's format is a fact. */
  field: z.ZodType;
}

/** What every operation in a family shares. */
export interface ResourceConfig {
  /** Toolset all of this family's tools belong to. */
  toolset: ToolGroup;
  /**
   * Collection path below the cloud-id root, in the spec's own brace form:
   * "/v1/schedules", or "/v1/schedules/{scheduleId}/rotations" for a nested
   * resource. Every brace token must be named in `parents`.
   */
  path: string;
  /**
   * Path parameters above this resource. A rotation lives under a schedule, so
   * every rotation tool needs the schedule id too — as an input parameter, in
   * the path, and in the manifest. Declared once here rather than in each of
   * the five operations.
   */
  parents?: readonly ParentParam[];
  /**
   * The spec's name for this resource's own path parameter. Almost always
   * "id" — but a schedule override is addressed by "alias", and the manifest
   * has to match the spec exactly or the drift guard rejects it.
   */
  itemToken?: string;
  /**
   * Which verb updates one item. PATCH for most of the API; overrides take PUT,
   * and sending the wrong one is a 405 rather than a silent no-op.
   */
  updateMethod?: "PATCH" | "PUT";
  /**
   * A team-scoped twin of this resource, used when its parameter is supplied.
   *
   * Several families exist twice: `/v1/maintenances` and
   * `/v1/teams/{teamId}/maintenances` are the same six operations against a
   * different scope. Two tools per operation would double the surface for no
   * new capability and force the model to pick between near-identical
   * descriptions — so one tool takes an optional team id and switches the path,
   * and the manifest declares both endpoints. This is the narrow collapse rule:
   * identical annotations, identical input shape but for one value, and no
   * conditional requiredness.
   */
  scoped?: { path: string; parent: ParentParam };
  /** Singular noun for receipts and messages, e.g. "schedule". */
  noun: string;
  /** Key the items sit under in structuredContent, e.g. "schedules". */
  plural: string;
  /** Input parameter naming one item, e.g. "schedule_id". */
  idParam: string;
  /** How that id is described to the model. Required: an id's format is a fact. */
  idField: z.ZodType;
  /** How the list endpoint pages. Defaults to size+offset. */
  paging?: PagingDialect;
  /** Envelope key, for endpoints answering under neither `data` nor `values`. */
  itemsKey?: string | undefined;
}

/** Annotations by operation kind, so `destructiveHint` cannot be forgotten. */
const ANNOTATIONS = {
  read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  create: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  // An update overwrites what was there, and a delete needs no argument.
  update: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  remove: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
} as const;

interface CommonOp {
  name: string;
  title: string;
  /** Never generated. See the note at the top of this file. */
  description: string;
}

export interface ListOp<T, Ctx = undefined> extends CommonOp {
  /** Never generated. */
  render: (items: T[], context: Ctx) => string;
  /** Never generated: an empty list should say what to try, not just "none". */
  emptyMessage: string;
  hint?: string;
  /** Extra query parameters beyond paging, as a raw Zod shape. */
  query?: z.ZodRawShape;
  /** Maps validated params to the query the API reads. */
  toParams?: (params: Record<string, unknown>) => Record<string, unknown>;
  /**
   * The query names this tool puts on the wire, when they differ from the
   * input shape's keys — inputs are snake_case and the API is camelCase, so
   * `toParams` almost always implies this. Defaults to the input keys.
   *
   * This exists because the manifest has to describe the request, not the tool:
   * declaring `target_account_id` against an endpoint that reads
   * `targetAccountId` documents a parameter that is never sent.
   */
  queryFields?: string[];
  /** Fetched once per call and handed to `render` — e.g. a team-name lookup. */
  prepare?: (client: JsmClient) => Promise<Ctx>;
  /** Item shape for the structured payload. Defaults to a passthrough object. */
  item?: z.ZodRawShape;
}

export interface GetOp<T, Ctx = undefined> extends CommonOp {
  /** Never generated. */
  render: (item: T, context: Ctx) => string;
  /**
   * Fetched once and handed to `render`, as on a list. Without this a get and
   * its sibling list disagree: jsm_list_schedules resolves the owning team to a
   * name and jsm_get_schedule would print the bare UUID, from the same data.
   */
  prepare?: (client: JsmClient) => Promise<Ctx>;
}

export interface WriteOp<T> extends CommonOp {
  /** The request body's shape, as the model supplies it. */
  input: z.ZodRawShape;
  /** Maps validated params to the JSON body the API reads. */
  toBody: (params: Record<string, unknown>) => Record<string, unknown>;
  /** Field names the body carries, in the API's casing, for the drift guard. */
  bodyFields: string[];
  render: (item: T) => string;
  /** Output shape for the structured payload. */
  output?: z.ZodRawShape;
}

export interface RemoveOp extends CommonOp {}

const passthroughItem = z.object({}).passthrough();

/** Turns a payload key into something that reads as prose in a message. */
function prose(name: string): string {
  return name.replace(/_/g, " ");
}

/** Substitutes the parent ids into the collection path, picking the scoped twin if asked. */
function collectionPath(config: ResourceConfig, params: Record<string, unknown>): string {
  const scopedTo = config.scoped ? params[config.scoped.parent.param] : undefined;
  let path = scopedTo !== undefined && scopedTo !== null ? config.scoped!.path : config.path;

  const parents = [
    ...(config.parents ?? []),
    ...(scopedTo !== undefined && scopedTo !== null ? [config.scoped!.parent] : []),
  ];
  for (const parent of parents) {
    path = path.replace(`{${parent.token}}`, encodeURIComponent(String(params[parent.param])));
  }
  return path;
}

/** Both manifest paths for a resource that has a team-scoped twin. */
function manifestPaths(config: ResourceConfig, suffix = ""): string[] {
  return [`${config.path}${suffix}`, ...(config.scoped ? [`${config.scoped.path}${suffix}`] : [])];
}

/** One endpoint declaration per path a tool may reach. */
function declare(
  method: EndpointDeclaration["method"],
  paths: string[],
  extra: Omit<EndpointDeclaration, "method" | "path"> = {},
): EndpointDeclaration | EndpointDeclaration[] {
  const declarations = paths.map((path) => ({ method, path, ...extra }));
  return declarations.length === 1 ? declarations[0]! : declarations;
}

/** The optional scope parameter, present on every operation of a twinned family. */
function scopedShape(config: ResourceConfig): z.ZodRawShape {
  return config.scoped ? { [config.scoped.parent.param]: config.scoped.parent.field } : {};
}

/** `/v1/schedules` + "sched 1" -> `/v1/schedules/sched%201`. */
function itemPath(config: ResourceConfig, params: Record<string, unknown>, id: string): string {
  return `${collectionPath(config, params)}/${encodeURIComponent(id)}`;
}

/** The manifest paths use the spec's brace form, not a real id. */
function itemManifestPaths(config: ResourceConfig): string[] {
  return manifestPaths(config, `/{${config.itemToken ?? "id"}}`);
}

/** Parent ids are inputs on every operation in a nested family. */
function parentShape(config: ResourceConfig): z.ZodRawShape {
  return Object.fromEntries((config.parents ?? []).map((p) => [p.param, p.field]));
}

export function defineListOperation<T, Ctx = undefined>(
  config: ResourceConfig,
  op: ListOp<T, Ctx>,
): AnyToolDefinition {
  const paging = config.paging;
  const endpoint = declare("GET", manifestPaths(config), {
    query: [
      ...pagingQueryNames(paging ?? DEFAULT_DIALECT),
      ...(op.queryFields ?? Object.keys(op.query ?? {})),
    ],
  });

  return defineTool({
    name: op.name,
    toolset: config.toolset,
    endpoint,
    title: op.title,
    description: op.description,
    inputSchema: {
      ...parentShape(config),
      ...scopedShape(config),
      ...(op.query ?? {}),
      limit: limitField,
      offset: offsetField,
      response_format: responseFormatField,
    },
    outputSchema: {
      [config.plural]: z.array(op.item ? z.object(op.item).passthrough() : passthroughItem),
      pagination: paginationOutputShape,
    },
    annotations: ANNOTATIONS.read,
    handler: async (params, client) => {
      const typed = params as Record<string, unknown> & {
        limit: number;
        offset: number;
        response_format: ResponseFormat;
      };
      // Resolved before the page is fetched so the renderer is synchronous —
      // a renderer that could await would be a renderer that could make N+1
      // calls, one per row, without anything in the type saying so.
      const context = (op.prepare ? await op.prepare(client) : undefined) as Ctx;

      // Only the offset dialect reads `offset`; sending it to an endpoint that
      // declares no paging parameters is a false statement about the endpoint,
      // and it is the manifest — not the wire — where that does damage.
      const dialect = paging ?? DEFAULT_DIALECT;
      const position = dialect.kind === "offset" ? { offset: typed.offset } : {};

      return executeList<T>({
        client,
        path: collectionPath(config, typed),
        params: { ...position, ...(op.toParams ? op.toParams(typed) : {}) },
        key: config.plural,
        context: `list ${prose(config.plural)}`,
        limit: typed.limit,
        offset: typed.offset,
        format: typed.response_format,
        render: (items) => op.render(items, context),
        emptyMessage: op.emptyMessage,
        hint: op.hint ?? "Increase 'offset' to see the rest.",
        ...(paging ? { paging } : {}),
        itemsKey: config.itemsKey,
      });
    },
  });
}

export function defineGetOperation<T, Ctx = undefined>(
  config: ResourceConfig,
  op: GetOp<T, Ctx>,
): AnyToolDefinition {
  return defineTool({
    name: op.name,
    toolset: config.toolset,
    endpoint: declare("GET", itemManifestPaths(config)),
    title: op.title,
    description: op.description,
    inputSchema: {
      ...parentShape(config),
      ...scopedShape(config),
      [config.idParam]: config.idField,
      response_format: responseFormatField,
    },
    outputSchema: { [config.noun]: passthroughItem },
    annotations: ANNOTATIONS.read,
    handler: async (params, client) => {
      const typed = params as Record<string, unknown>;
      const id = String(typed[config.idParam]);
      try {
        const context = (op.prepare ? await op.prepare(client) : undefined) as Ctx;
        const item = await client.getOne<T>(itemPath(config, typed, id));
        return ok(op.render(item, context), { [config.noun]: item as Record<string, unknown> });
      } catch (error) {
        return fail(
          handleApiError(error, `get ${prose(config.noun)}`, {
            method: "GET",
            path: config.path,
          }),
        );
      }
    },
  });
}

export function defineCreateOperation<T>(
  config: ResourceConfig,
  op: WriteOp<T>,
): AnyToolDefinition {
  return defineTool({
    name: op.name,
    toolset: config.toolset,
    endpoint: declare("POST", manifestPaths(config), { body: op.bodyFields }),
    title: op.title,
    description: op.description,
    inputSchema: { ...parentShape(config), ...scopedShape(config), ...op.input },
    outputSchema: op.output ?? { [config.noun]: passthroughItem },
    annotations: ANNOTATIONS.create,
    handler: async (params, client) =>
      executeWrite<T>(client, {
        label: `Create ${prose(config.noun)}`,
        method: "POST",
        path: collectionPath(config, params as Record<string, unknown>),
        body: op.toBody(params as Record<string, unknown>),
        // Configuration writes answer with the object, not a receipt. Reporting
        // them as async would point the model at a request id that was never
        // issued.
        mode: "sync",
        subject: { key: config.idParam, noun: prose(config.noun) },
        render: op.render,
        structured: (item) => ({ [config.noun]: item as Record<string, unknown> }),
      }),
  });
}

export function defineUpdateOperation<T>(
  config: ResourceConfig,
  op: WriteOp<T>,
): AnyToolDefinition {
  return defineTool({
    name: op.name,
    toolset: config.toolset,
    endpoint: declare(config.updateMethod ?? "PATCH", itemManifestPaths(config), {
      body: op.bodyFields,
    }),
    title: op.title,
    description: op.description,
    inputSchema: {
      ...parentShape(config),
      ...scopedShape(config),
      [config.idParam]: config.idField,
      ...op.input,
    },
    outputSchema: op.output ?? { [config.noun]: passthroughItem },
    annotations: ANNOTATIONS.update,
    handler: async (params, client) => {
      const typed = params as Record<string, unknown>;
      const id = String(typed[config.idParam]);
      return executeWrite<T>(client, {
        label: `Update ${prose(config.noun)}`,
        method: config.updateMethod ?? "PATCH",
        path: itemPath(config, typed, id),
        body: op.toBody(typed),
        mode: "sync",
        subject: { key: config.idParam, value: id, noun: prose(config.noun) },
        render: op.render,
        structured: (item) => ({ [config.noun]: item as Record<string, unknown> }),
      });
    },
  });
}

export function defineRemoveOperation(config: ResourceConfig, op: RemoveOp): AnyToolDefinition {
  return defineTool({
    name: op.name,
    toolset: config.toolset,
    endpoint: declare("DELETE", itemManifestPaths(config)),
    title: op.title,
    description: op.description,
    inputSchema: {
      ...parentShape(config),
      ...scopedShape(config),
      [config.idParam]: config.idField,
    },
    outputSchema: { deleted: z.boolean(), [config.idParam]: z.string().optional() },
    annotations: ANNOTATIONS.remove,
    handler: async (params, client) => {
      const typed = params as Record<string, unknown>;
      const id = String(typed[config.idParam]);
      return executeWrite(client, {
        label: `Delete ${prose(config.noun)}`,
        method: "DELETE",
        path: itemPath(config, typed, id),
        mode: "deleted",
        subject: { key: config.idParam, value: id, noun: prose(config.noun) },
      });
    },
  });
}

/**
 * Composes a family from whichever operations it actually has. Every field is
 * optional because the API is not uniform: some resources have no update
 * endpoint, some no delete, and inventing one to fill the shape would be a tool
 * that 404s.
 */
export interface FamilyOperations<T, Ctx = undefined> {
  list?: ListOp<T, Ctx>;
  get?: GetOp<T, Ctx>;
  create?: WriteOp<T>;
  update?: WriteOp<T>;
  remove?: RemoveOp;
}

export function defineResourceFamily<T, Ctx = undefined>(
  config: ResourceConfig,
  ops: FamilyOperations<T, Ctx>,
): AnyToolDefinition[] {
  const tools: AnyToolDefinition[] = [];
  if (ops.list) tools.push(defineListOperation<T, Ctx>(config, ops.list));
  if (ops.get) tools.push(defineGetOperation<T, Ctx>(config, ops.get));
  if (ops.create) tools.push(defineCreateOperation<T>(config, ops.create));
  if (ops.update) tools.push(defineUpdateOperation<T>(config, ops.update));
  if (ops.remove) tools.push(defineRemoveOperation(config, ops.remove));
  return tools;
}
