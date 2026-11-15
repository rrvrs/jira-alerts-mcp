import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { CODE_MAX_REQUESTS, CODE_MAX_REQUESTS_MAX, CODE_TIMEOUT_MS } from "../../constants.js";
import { CodeLimitsError, LIMIT_VARIABLES, resolveLimits } from "./limits.js";

const env = (values: Record<string, string>) => values as NodeJS.ProcessEnv;

describe("resolveLimits", () => {
  it("uses the defaults when nothing is set", () => {
    const limits = resolveLimits();
    assert.equal(limits.timeoutMs, CODE_TIMEOUT_MS);
    assert.equal(limits.maxRequests, CODE_MAX_REQUESTS);
  });

  it("honours an override", () => {
    assert.equal(resolveLimits(env({ JSM_CODE_MAX_REQUESTS: "10" })).maxRequests, 10);
  });

  it("treats an empty or whitespace value as unset", () => {
    assert.equal(
      resolveLimits(env({ JSM_CODE_MAX_REQUESTS: "  " })).maxRequests,
      CODE_MAX_REQUESTS,
    );
  });

  it("refuses a value above the hard ceiling rather than clamping it quietly", () => {
    // Clamping would leave a config that reads as applied and is not. The
    // operator asked for something the server will not do; say so.
    assert.throws(
      () => resolveLimits(env({ JSM_CODE_MAX_REQUESTS: String(CODE_MAX_REQUESTS_MAX + 1) })),
      (error: unknown) => {
        assert.ok(error instanceof CodeLimitsError);
        assert.match(error.message, /hard limit/);
        assert.match(error.message, new RegExp(String(CODE_MAX_REQUESTS_MAX)));
        return true;
      },
    );
  });

  it("refuses zero and negative budgets", () => {
    assert.throws(() => resolveLimits(env({ JSM_CODE_MAX_PAGES: "0" })), CodeLimitsError);
    assert.throws(() => resolveLimits(env({ JSM_CODE_MAX_PAGES: "-1" })), CodeLimitsError);
  });

  it("refuses anything that is not a plain decimal integer", () => {
    // Number() would happily accept all of these and resolve to something the
    // operator did not type.
    for (const raw of ["0x10", "1e3", "12.5", "ten", "1_000"]) {
      assert.throws(
        () => resolveLimits(env({ JSM_CODE_MAX_RECORDS: raw })),
        CodeLimitsError,
        `expected '${raw}' to be rejected`,
      );
    }
  });

  it("names every variable it reads, so --help and the README cannot drift", () => {
    assert.deepEqual([...LIMIT_VARIABLES].sort(), [
      "JSM_CODE_MAX_INFLIGHT",
      "JSM_CODE_MAX_PAGES",
      "JSM_CODE_MAX_RECORDS",
      "JSM_CODE_MAX_REQUESTS",
      "JSM_CODE_TIMEOUT_MS",
    ]);
  });
});
