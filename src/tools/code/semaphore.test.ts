import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createSemaphore } from "./semaphore.js";

const defer = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe("createSemaphore", () => {
  it("rejects a nonsensical limit", () => {
    assert.throws(() => createSemaphore(0), RangeError);
    assert.throws(() => createSemaphore(1.5), RangeError);
  });

  it("never lets more than `limit` run at once", async () => {
    const semaphore = createSemaphore(3);
    const gates = Array.from({ length: 10 }, defer);

    const running = gates.map((gate, index) =>
      semaphore.run(async () => {
        await gate.promise;
        return index;
      }),
    );

    // Release one at a time; the peak can never exceed the limit no matter how
    // the releases interleave.
    for (const gate of gates) {
      assert.ok(semaphore.active <= 3, `active rose to ${semaphore.active}`);
      gate.resolve();
      await Promise.resolve();
    }

    assert.deepEqual(await Promise.all(running), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.equal(semaphore.peak, 3);
    assert.equal(semaphore.active, 0);
  });

  it("releases the slot when the work throws", async () => {
    const semaphore = createSemaphore(1);

    await assert.rejects(
      semaphore.run(async () => {
        throw new Error("boom");
      }),
      /boom/,
    );

    // A leaked slot on the error path would deadlock the next caller, which is
    // the failure that only shows up once something starts failing.
    assert.equal(semaphore.active, 0);
    assert.equal(await semaphore.run(async () => "ok"), "ok");
  });

  it("serves waiters first-in first-out", async () => {
    const semaphore = createSemaphore(1);
    const order: number[] = [];
    const gate = defer();

    const first = semaphore.run(async () => {
      await gate.promise;
      order.push(0);
    });
    const rest = [1, 2, 3].map((n) =>
      semaphore.run(async () => {
        order.push(n);
      }),
    );

    gate.resolve();
    await Promise.all([first, ...rest]);

    assert.deepEqual(order, [0, 1, 2, 3]);
  });
});
