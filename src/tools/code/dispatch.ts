/**
 * Runs one operation, or every page of one, against the JSM API.
 *
 * This is where a `RequestPlan` stops being data and becomes a request. It is
 * the only route the code API has to the network, which is what lets the
 * budgets, the deadline, the write allowlist and the audit trail all be
 * enforced in one place rather than per operation.
 *
 * What it deliberately does not do is render. A dispatched read returns the
 * rows, untruncated — see the note in list-executor.ts for why reusing a
 * handler's output would cap a 2,000-row fetch at whatever fit a markdown page.
 */

import { z } from "zod";

import { MAX_LIMIT } from "../../constants.js";
import { handleApiError, type JsmClient } from "../../services/client.js";
import { extractLinkParam } from "../../services/format.js";
import type { RequestPlan } from "../define.js";
import { fetchList } from "../list-executor.js";
import { DEFAULT_DIALECT, type PagingDialect } from "../paging.js";
import { budgetedClient } from "./budgeted-client.js";
import { BudgetError, type CallContext, DispatchError, OperationError } from "./context.js";
import type { Operation, OperationRegistry } from "./registry.js";

/** One page of a collection, as a script sees it. */
export interface PageResult {
  items: unknown[];
  /** The grand total, where the endpoint reports one. */
  total?: number;
  nextOffset?: number;
  nextCursor?: string;
}

/** Every page of a collection, bounded. */
export interface AllPagesResult {
  items: unknown[];
  pages: number;
  /**
   * False when a budget or the endpoint's own paging stopped this early.
   *
   * In the value rather than only in a log line, because the repo's standing
   * bug class is "told 20 was all of them": a partial read that looks complete
   * is a wrong answer, and a script can branch on this.
   */
  complete: boolean;
  stoppedBecause?: string;
}

export interface Dispatcher {
  /** One operation, one page. */
  call(name: string, args: unknown, ctx: CallContext): Promise<unknown>;
  /** One operation, every page it will serve, inside the invocation's budgets. */
  callAll(name: string, args: unknown, ctx: CallContext, max?: number): Promise<AllPagesResult>;
}

function statusOf(error: unknown): number | undefined {
  const response = (error as { response?: { status?: number } } | undefined)?.response;
  return typeof response?.status === "number" ? response.status : undefined;
}

function isRetryable(error: unknown): boolean {
  const status = statusOf(error);
  if (status === 429) return true;
  if (status !== undefined && status >= 500) return true;
  return (error as { code?: string } | undefined)?.code === "ECONNABORTED";
}

/** `Retry-After` in milliseconds, when the API said. Seconds or an HTTP date. */
function retryAfterMs(error: unknown): number | undefined {
  const headers = (error as { response?: { headers?: Record<string, unknown> } } | undefined)
    ?.response?.headers;
  const raw = headers?.["retry-after"] ?? headers?.["Retry-After"];
  if (typeof raw !== "string" && typeof raw !== "number") return undefined;

  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);

  const at = Date.parse(String(raw));
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/** A sleep that gives up when the invocation's deadline does. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

const DEFAULT_RETRY_MS = 1_000;

/**
 * Retries a 429 once, honouring Retry-After.
 *
 * Once, not until it works: a script that is being throttled should learn that
 * and narrow its work, and an unbounded retry inside a tool call is how one
 * request becomes a quiet denial of service against someone's own tenant. The
 * retry goes back through the budgeted client, so it costs a request from the
 * invocation's budget — a retrying script cannot exceed its budget by retrying.
 *
 * Only 429. A 5xx is classified as transient by handleApiError, which says so
 * in prose the script can read and act on; retrying it here would hide a real
 * outage behind a doubled latency.
 */
async function withRateLimitRetry<T>(ctx: CallContext, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (statusOf(error) !== 429) throw error;

    const waitMs = retryAfterMs(error) ?? DEFAULT_RETRY_MS;
    // A retry that cannot finish before the deadline is a retry that turns a
    // rate-limit error into a timeout, which is a worse thing to report.
    if (waitMs + 250 > ctx.deadline.remainingMs()) throw error;

    await sleep(waitMs, ctx.deadline.signal);
    ctx.deadline.check();
    return work();
  }
}

/** The cursor parameter a dialect reads, for advancing a page. */
function cursorParam(dialect: PagingDialect): "after" | "pageToken" | undefined {
  if (dialect.kind === "cursor") return "after";
  if (dialect.kind === "token") return "pageToken";
  return undefined;
}

function pageOf(
  plan: RequestPlan,
  items: unknown[],
  total: number | undefined,
  next: string | undefined,
): PageResult {
  const dialect = plan.paging ?? DEFAULT_DIALECT;
  const cursor = cursorParam(dialect);
  return {
    items,
    ...(total !== undefined ? { total } : {}),
    ...(dialect.kind === "offset"
      ? { nextOffset: Number(plan.params?.offset ?? 0) + items.length }
      : {}),
    // Only when there is one: an explicit `nextCursor: undefined` reads in a
    // script as "there is a next page and I lost it".
    ...(cursor && extractLinkParam(next, cursor)
      ? { nextCursor: extractLinkParam(next, cursor) as string }
      : {}),
  };
}

export interface DispatcherOptions {
  /**
   * Whether jsm_apply is registered on this server.
   *
   * Only changes what a refusal says. Pointing a model at jsm_apply on a
   * read-only install sends it looking for a tool that is not there.
   */
  writesAvailable?: boolean;
}

export function createDispatcher(
  registry: OperationRegistry,
  client: JsmClient,
  options: DispatcherOptions = {},
): Dispatcher {
  const writesAvailable = options.writesAvailable ?? true;
  /** Resolves and authorises, or explains exactly what to change. */
  function admit(name: string, ctx: CallContext): Operation {
    const operation = registry.find(name);
    if (!operation) {
      const near = registry
        .search({ query: name, limit: 3 })
        .map((candidate) => candidate.codeName);
      throw new DispatchError(
        `No operation named '${name}'.` +
          (near.length ? ` Did you mean ${near.join(", ")}?` : "") +
          ` Call jsm_search_api to find one.`,
      );
    }

    if (!operation.available) {
      throw new DispatchError(
        `'${operation.codeName}' is not available. ${operation.unavailableReason}`,
      );
    }

    if (operation.kind !== "read" && !ctx.allowWrites.has(operation.codeName)) {
      throw new DispatchError(
        `'${operation.codeName}' ${operation.kind === "destructive" ? "is destructive and " : ""}` +
          `writes, and this call may only read. ` +
          (writesAvailable
            ? `Writes go through jsm_apply, one operation per call, so your client can approve ` +
              `each one by name.`
            : `This server is running read-only (JSM_READ_ONLY), so no write is available ` +
              `here at all. Tell the user rather than looking for another way.`),
      );
    }

    return operation;
  }

  /** Validates against the tool's own schema, so dispatch and the tool agree. */
  function parse(operation: Operation, args: unknown): Record<string, unknown> {
    const result = z.strictObject(operation.tool.inputSchema).safeParse(args ?? {});
    if (!result.success) {
      throw new DispatchError(
        `Arguments for '${operation.codeName}' are not valid: ` +
          result.error.issues
            .map((issue) => `${issue.path.join(".") || "(root)"} — ${issue.message}`)
            .join("; ") +
          `. Call jsm_read_api with operations: ["${operation.codeName}"] for its signature.`,
      );
    }
    return result.data as Record<string, unknown>;
  }

  /** Turns an API failure into something a script can branch on and a model can read. */
  function asOperationError(
    operation: Operation,
    plan: RequestPlan | undefined,
    error: unknown,
    ctx: CallContext,
  ) {
    if (error instanceof BudgetError || error instanceof DispatchError) return error;

    // A request cancelled by the invocation's own deadline is a spent budget,
    // not a network fault. Left to handleApiError it read "could not reach
    // api.atlassian.com (ERR_CANCELED). Check network access and any proxy
    // settings" — sending someone to debug a proxy because a script ran long.
    const cancelled =
      (error as { code?: string } | undefined)?.code === "ERR_CANCELED" ||
      ["CanceledError", "AbortError"].includes(
        (error as { name?: string } | undefined)?.name ?? "",
      );
    if (cancelled && (ctx.deadline.signal.aborted || ctx.deadline.expired())) {
      return new BudgetError(
        "timeoutMs",
        ctx.limits.timeoutMs,
        `'${operation.codeName}' was still waiting on the API when this call's ` +
          `${ctx.limits.timeoutMs}ms deadline passed, and was cancelled. Narrow the work, or ` +
          `raise JSM_CODE_TIMEOUT_MS where this server is configured.`,
      );
    }

    return new OperationError(
      operation.codeName,
      // handleApiError's prose carries the scope advice, the 402/403 plan-limit
      // split and the tinyId hint — knowledge that took a live tenant to learn.
      // A second error vocabulary beside it would lose all of it.
      handleApiError(error, operation.codeName, {
        method: plan?.method ?? "GET",
        path: plan?.path ?? "/v1",
      }),
      statusOf(error),
      isRetryable(error),
    );
  }

  async function runPlan(
    plan: RequestPlan,
    ctx: CallContext,
    budgeted: JsmClient,
  ): Promise<unknown> {
    switch (plan.shape) {
      case "collection": {
        const page = await withRateLimitRetry(ctx, () => fetchList(plan, budgeted));
        ctx.budget.chargeRecords(page.items.length);
        return pageOf(plan, page.items, page.totalCount, page.paging?.next);
      }
      case "object": {
        const body =
          plan.method === "GET"
            ? await withRateLimitRetry(ctx, () => budgeted.getOne<unknown>(plan.path, plan.params))
            : await withRateLimitRetry(ctx, () =>
                budgeted.request<unknown>(plan.method, plan.path, {
                  params: plan.params,
                  body: plan.body,
                }),
              );
        return body ?? null;
      }
      case "empty": {
        await withRateLimitRetry(ctx, () =>
          budgeted.request<unknown>(plan.method, plan.path, {
            params: plan.params,
            body: plan.body,
          }),
        );
        // A 204 has nothing to return, and returning undefined would read in a
        // script as "the call did nothing".
        return { ok: true };
      }
    }
  }

  return {
    async call(name, args, ctx) {
      const operation = admit(name, ctx);
      const params = parse(operation, args);
      ctx.operations.push(operation.codeName);
      ctx.deadline.check();

      const budgeted = budgetedClient(client, ctx);
      let plan: RequestPlan | undefined;

      try {
        let result: unknown;
        if (operation.tool.fetch) {
          // A composite's own calls go through the budgeted client, so each is
          // charged, deadline-bound and queued without the composite knowing.
          result = await operation.tool.fetch(params, budgeted, ctx);
        } else {
          // Kept in `plan` so the catch below can name the method and path the
          // failure came from.
          plan = operation.tool.plan!(params);
          result = await runPlan(plan, ctx, budgeted);
        }

        if (operation.kind !== "read") {
          ctx.applied.push({
            operation: operation.codeName,
            ...(typeof params.alert_id === "string" ? { subject: params.alert_id } : {}),
          });
        }
        return result;
      } catch (error) {
        throw asOperationError(operation, plan, error, ctx);
      }
    },

    async callAll(name, args, ctx, max) {
      const operation = admit(name, ctx);
      if (!operation.pageable) {
        throw new DispatchError(
          `'${operation.codeName}' cannot be paged. ` +
            (operation.kind === "read"
              ? `This endpoint returns its whole collection in one response and accepts no ` +
                `paging parameters, so call it with ${operation.codeName} instead.`
              : `Only a collection read can be paged.`),
        );
      }

      // Checked here rather than trusted: this arrives from a script, and a
      // negative value reached `items.length = -5` below and surfaced as a raw
      // "RangeError: Invalid array length".
      if (max !== undefined && (!Number.isInteger(max) || max < 1)) {
        throw new DispatchError(
          `'max' must be a whole number of at least 1, got ${JSON.stringify(max)}. ` +
            `Omit it to read up to this call's ${ctx.limits.maxRecords}-record limit.`,
        );
      }

      // A sweep reads at the largest page the endpoint takes unless the caller
      // chose one. Inheriting the default of 20 spent fifty requests on a
      // thousand records and then stopped at the page limit, reporting a
      // partial result for a collection it could have read in ten.
      const raw = (args ?? {}) as Record<string, unknown>;
      const widened =
        !("limit" in raw) && "limit" in operation.tool.inputSchema
          ? z.strictObject(operation.tool.inputSchema).safeParse({ ...raw, limit: MAX_LIMIT })
          : undefined;
      const params = widened?.success
        ? (widened.data as Record<string, unknown>)
        : parse(operation, args);
      ctx.operations.push(operation.codeName);

      const first = operation.tool.plan!(params);
      const dialect = first.paging ?? DEFAULT_DIALECT;
      const cursor = cursorParam(dialect);
      const ceiling = Math.min(max ?? ctx.limits.maxRecords, ctx.limits.maxRecords);
      const start = Number(first.params?.offset ?? 0);
      const budgeted = budgetedClient(client, ctx);

      const items: unknown[] = [];
      let query = { ...first.params };
      let pages = 0;
      let requests = 0;
      let stoppedBecause: string | undefined;

      // Every exit is an explicit `break` below, each beside the reason for it.
      // The loop used to test `!stoppedBecause`, which was always true when it
      // was evaluated and read as a guard that was doing nothing.
      while (true) {
        if (requests >= ctx.limits.maxPages) {
          stoppedBecause = `stopped at the ${ctx.limits.maxPages}-page limit`;
          break;
        }

        let page: Awaited<ReturnType<typeof fetchList>>;
        try {
          ctx.deadline.check();
          requests += 1;
          page = await withRateLimitRetry(ctx, () =>
            fetchList({ ...first, params: query }, budgeted),
          );
          ctx.budget.chargeRecords(page.items.length);
        } catch (error) {
          const mapped = asOperationError(operation, first, error, ctx);
          // Whatever ends a sweep part-way — a budget, or the API failing on
          // page seven — the pages already read are returned, marked partial.
          // Losing sixty requests' worth of work to an exception is strictly
          // worse than saying what was gathered and why it stopped. A failure
          // on the very first page has gathered nothing, so that one throws.
          if (mapped instanceof BudgetError || pages > 0) {
            stoppedBecause = mapped.message;
            break;
          }
          throw mapped;
        }

        // An empty page is the only unambiguous end of an offset-paged
        // collection. A page merely SHORTER than the one asked for is not: an
        // endpoint that clamps the page size returns fifty when asked for a
        // hundred with two hundred still to come, and treating that as the end
        // reported 50 of 250 records as a complete sweep — the "told 20 was all
        // of them" bug, in the one place built to prevent it.
        if (page.items.length === 0) break;

        pages += 1;
        items.push(...page.items);

        if (items.length >= ceiling) {
          items.length = ceiling;
          stoppedBecause = `reached the ${ceiling}-record ceiling for this call`;
          break;
        }

        if (cursor) {
          const next = extractLinkParam(page.paging?.next, cursor);
          if (!next) break;
          query = { ...query, [cursor]: next };
          continue;
        }

        // Where the endpoint reports a total, that ends the sweep without the
        // extra request an empty page costs.
        if (page.totalCount !== undefined && start + items.length >= page.totalCount) break;
        query = { ...query, offset: Number(query.offset ?? 0) + page.items.length };
      }

      return {
        items,
        pages,
        complete: stoppedBecause === undefined,
        ...(stoppedBecause ? { stoppedBecause } : {}),
      };
    },
  };
}
