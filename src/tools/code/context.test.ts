import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  BudgetError,
  createBudget,
  createCallContext,
  createDeadline,
  EngineError,
  OperationError,
} from "./context.js";
import { resolveLimits } from "./limits.js";

const limits = (overrides: Partial<ReturnType<typeof resolveLimits>> = {}) => ({
  ...resolveLimits(),
  ...overrides,
});

describe("createBudget", () => {
  it("charges a request before it is issued, so retries cannot be free", () => {
    const budget = createBudget(limits({ maxRequests: 2 }));
    budget.chargeRequest();
    budget.chargeRequest();
    assert.equal(budget.requests, 2);
    assert.throws(() => budget.chargeRequest(), BudgetError);
  });

  it("names the budget and tells the model the work so far is still valid", () => {
    const budget = createBudget(limits({ maxRequests: 1 }));
    budget.chargeRequest();
    assert.throws(
      () => budget.chargeRequest(),
      (error: unknown) => {
        assert.ok(error instanceof BudgetError);
        assert.equal(error.budget, "maxRequests");
        assert.equal(error.limit, 1);
        assert.equal(error.kind, "budget");
        assert.match(error.message, /still valid/);
        return true;
      },
    );
  });

  it("refuses a page that would cross the record budget, before holding it", () => {
    // Checked against the incoming count rather than after the fact: a 100-row
    // page arriving at a budget with 5 left should be refused, not accepted and
    // then reported as over.
    const budget = createBudget(limits({ maxRecords: 100 }));
    budget.chargeRecords(95);
    assert.throws(() => budget.chargeRecords(10), BudgetError);
    assert.equal(budget.records, 95, "a refused charge must not be counted");
    budget.chargeRecords(5);
    assert.equal(budget.records, 100);
  });

  it("counts requests and records separately", () => {
    // They bound different things: requests bound what we do to Atlassian,
    // records bound what this process holds in memory.
    const budget = createBudget(limits({ maxRequests: 1, maxRecords: 1_000 }));
    budget.chargeRequest();
    budget.chargeRecords(500);
    assert.equal(budget.requests, 1);
    assert.equal(budget.records, 500);
  });
});

describe("createDeadline", () => {
  it("reports the time left and does not throw before it is up", () => {
    let now = 1_000;
    const deadline = createDeadline(10_000, () => now);
    try {
      assert.equal(deadline.remainingMs(), 10_000);
      now += 4_000;
      assert.equal(deadline.remainingMs(), 6_000);
      assert.equal(deadline.expired(), false);
      deadline.check();
    } finally {
      deadline.dispose();
    }
  });

  it("throws a budget error naming the timeout once it is up", () => {
    let now = 0;
    const deadline = createDeadline(5_000, () => now);
    try {
      now = 5_001;
      assert.equal(deadline.expired(), true);
      assert.throws(
        () => deadline.check(),
        (error: unknown) => {
          assert.ok(error instanceof BudgetError);
          assert.equal(error.budget, "timeoutMs");
          assert.match(error.message, /JSM_CODE_TIMEOUT_MS/);
          return true;
        },
      );
    } finally {
      deadline.dispose();
    }
  });

  it("exposes a signal the HTTP client can honour", async () => {
    // The point of the signal: REQUEST_TIMEOUT_MS is 30s and an invocation gets
    // 10, so without propagating this a slow request outlives the deadline.
    const deadline = createDeadline(5);
    try {
      assert.equal(deadline.signal.aborted, false);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(deadline.signal.aborted, true);
    } finally {
      deadline.dispose();
    }
  });
});

describe("createCallContext", () => {
  it("gives every invocation an id, so a log line can be matched to a report", () => {
    const first = createCallContext({ limits: limits() });
    const second = createCallContext({ limits: limits() });
    try {
      assert.notEqual(first.invocationId, second.invocationId);
      assert.ok(first.invocationId.length > 0);
    } finally {
      first.deadline.dispose();
      second.deadline.dispose();
    }
  });

  it("defaults to reads only", () => {
    const ctx = createCallContext({ limits: limits() });
    try {
      assert.equal(ctx.allowWrites.size, 0);
      assert.deepEqual(ctx.operations, []);
      assert.deepEqual(ctx.applied, []);
    } finally {
      ctx.deadline.dispose();
    }
  });

  it("carries the allowlist as a set, because only those were approved", () => {
    const ctx = createCallContext({ limits: limits(), allowWrites: ["acknowledgeAlert"] });
    try {
      assert.equal(ctx.allowWrites.has("acknowledgeAlert"), true);
      assert.equal(ctx.allowWrites.has("deleteAlert"), false);
    } finally {
      ctx.deadline.dispose();
    }
  });

  it("shares one budget across the whole invocation", () => {
    // A per-call budget would be no budget: sixty operations of one request
    // each would never trip a sixty-per-call limit.
    const ctx = createCallContext({ limits: limits({ maxRequests: 3 }) });
    try {
      ctx.budget.chargeRequest();
      ctx.budget.chargeRequest();
      ctx.budget.chargeRequest();
      assert.throws(() => ctx.budget.chargeRequest(), BudgetError);
    } finally {
      ctx.deadline.dispose();
    }
  });
});

describe("the error taxonomy", () => {
  it("tags each kind, so a handler can tell the model what to do next", () => {
    assert.equal(new BudgetError("maxPages", 1, "x").kind, "budget");
    assert.equal(new OperationError("listAlerts", "x", 404, false).kind, "operation");
    assert.equal(new EngineError("x").kind, "engine");
  });

  it("keeps the API's own prose on an operation error, alongside the fields", () => {
    // handleApiError's text carries the scope advice, the 402/403 plan split
    // and the tinyId hint. A second error vocabulary beside it would lose them.
    const error = new OperationError(
      "getAlert",
      "Error (get alert): no alert with id …",
      404,
      false,
    );
    assert.equal(error.operation, "getAlert");
    assert.equal(error.status, 404);
    assert.equal(error.retryable, false);
    assert.match(error.message, /no alert with id/);
    assert.ok(error instanceof Error);
  });
});
