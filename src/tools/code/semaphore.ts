/**
 * A counting semaphore, for capping concurrent outbound requests.
 *
 * Exists because a script's `Promise.all` over forty schedules would otherwise
 * open forty connections at once. handleApiError has a 429 branch, which is
 * evidence the API throttles, and code mode's first visible effect on a busy
 * site should not be rate-limit errors that classic mode never produced.
 *
 * FIFO rather than LIFO: a fan-out that starves its first request is a fan-out
 * whose slowest path is unbounded, and the invocation has a deadline.
 */

export interface Semaphore {
  /** Runs `work` once a slot is free, releasing the slot whether it resolves or throws. */
  run<T>(work: () => Promise<T>): Promise<T>;
  /** Slots currently held. Asserted on by the concurrency tests. */
  readonly active: number;
  /** The high-water mark, so a test can prove the cap was never exceeded. */
  readonly peak: number;
}

export function createSemaphore(limit: number): Semaphore {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`semaphore limit must be a positive integer, got ${limit}`);
  }

  let active = 0;
  let peak = 0;
  const waiting: Array<() => void> = [];

  const release = (): void => {
    active -= 1;
    // Hand the slot straight to the next waiter rather than decrementing and
    // letting it re-check: between those two steps another caller could take
    // the slot, and the queue would stop being FIFO.
    const next = waiting.shift();
    if (next) next();
  };

  const acquire = async (): Promise<void> => {
    if (active < limit) {
      active += 1;
      peak = Math.max(peak, active);
      return;
    }
    await new Promise<void>((resolve) => {
      waiting.push(() => {
        active += 1;
        peak = Math.max(peak, active);
        resolve();
      });
    });
  };

  return {
    async run<T>(work: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await work();
      } finally {
        release();
      }
    },
    get active() {
      return active;
    },
    get peak() {
      return peak;
    },
  };
}
