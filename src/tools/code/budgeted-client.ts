/**
 * A JsmClient that charges the invocation's budget for every request.
 *
 * The alternative was threading a CallContext through `resolveScheduleId`,
 * `answerOnCall`, `fetchTimeline` and `resolveIdentities` so each could charge
 * for itself. That spreads the budget across five files and makes "did you
 * remember to charge?" a question every future helper has to get right — and a
 * composite that forgot would be a way around the request budget, which is the
 * one guarantee the budget exists to make.
 *
 * Wrapping the client instead moves the question somewhere it cannot be
 * forgotten: a request that is not charged is a request that was not made.
 *
 * Each public method is wrapped explicitly rather than by a Proxy. A Proxy
 * would have to rebind `this` so that `getCollection`'s internal `this.request`
 * re-entered the wrapper, which both double-charges and depends on a detail of
 * how JsmClient happens to be written today. Delegating to the real method
 * charges exactly once, per public call, and reads as what it is.
 *
 * A test asserts this wraps every public method JsmClient has, so a method
 * added later cannot quietly bypass the budget.
 */

import type { JsmClient, RequestOptions } from "../../services/client.js";
import type { Paged } from "../../types.js";
import type { CallContext } from "./context.js";

/** The public surface this has to cover. Kept in one place for the test to read. */
export const BUDGETED_METHODS = ["request", "getCollection", "getOne", "jiraGet"] as const;

export function budgetedClient(client: JsmClient, ctx: CallContext): JsmClient {
  /**
   * The deadline first, then the budget, then the queue.
   *
   * Order matters: checking the deadline before charging means an invocation
   * that has already run out of time reports that, rather than reporting a
   * request budget it never actually spent. And charging before queueing means
   * the budget bounds requests *attempted*, so a script cannot queue two
   * hundred calls behind a limit of sixty and have them all eventually run.
   */
  const spend = async <T>(
    signal: AbortSignal | undefined,
    work: (s: AbortSignal) => Promise<T>,
  ) => {
    ctx.deadline.check();
    ctx.budget.chargeRequest();
    return ctx.inflight.run(() => work(signal ?? ctx.deadline.signal));
  };

  const budgeted = {
    request: <T>(
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
      path: string,
      options: RequestOptions = {},
    ): Promise<T> =>
      spend(options.signal, (signal) => client.request<T>(method, path, { ...options, signal })),

    getCollection: <T>(
      path: string,
      params?: Record<string, unknown>,
      options: { itemsKey?: string | undefined; signal?: AbortSignal | undefined } = {},
    ): Promise<Paged<T>> =>
      spend(options.signal, (signal) =>
        client.getCollection<T>(path, params, { ...options, signal }),
      ),

    getOne: <T>(
      path: string,
      params?: Record<string, unknown>,
      options: { signal?: AbortSignal | undefined } = {},
    ): Promise<T> =>
      spend(options.signal, (signal) => client.getOne<T>(path, params, { ...options, signal })),

    jiraGet: <T>(
      path: string,
      params?: Record<string, unknown>,
      options: { signal?: AbortSignal | undefined } = {},
    ): Promise<T> =>
      spend(options.signal, (signal) => client.jiraGet<T>(path, params, { ...options, signal })),
  };

  // Cast rather than implement: JsmClient's private axios instances are not
  // reachable or needed here, and every public method is accounted for above —
  // which is what the test checks.
  return budgeted as unknown as JsmClient;
}
