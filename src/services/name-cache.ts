/**
 * One registry for every process-wide cache in the server.
 *
 * Each of these caches is individually justified — a name-to-id mapping is
 * stable, and during an incident the same schedule and the same rotation get
 * asked about repeatedly. The problem is not the caching, it is that each one
 * arrived with its own module-level Map and its own exported `clear` for tests.
 * Two of those is a convention; ten, one per resource family, is a bug waiting
 * to happen — a new cache lands, no test clears it, and one case's cached
 * answer silently satisfies the next case's assertion. That failure is
 * order-dependent and reads as flakiness rather than as a missing clear.
 *
 * So caches register themselves on creation, and `clearAllNameCaches()` empties
 * every one. Adding a cache adds it to the reset by construction; forgetting is
 * no longer possible.
 */

/** Every cache created through this module, for the all-clear. */
const registry = new Set<{ clear: () => void }>();

export interface NameCache<V> {
  get(key: string): V | undefined;
  set(key: string, value: V): void;
  clear(): void;
  readonly size: number;
}

/**
 * A bounded string-keyed cache.
 *
 * `maxEntries` guards a long-lived session rather than a hot loop: on overflow
 * the whole map is dropped instead of evicting one entry, which is the cheap
 * approximation the identity cache already used and is fine for mappings this
 * stable.
 */
export function createNameCache<V>(maxEntries = 500): NameCache<V> {
  const entries = new Map<string, V>();

  const cache: NameCache<V> = {
    get: (key) => entries.get(key),
    set(key, value) {
      if (entries.size >= maxEntries) entries.clear();
      entries.set(key, value);
    },
    clear: () => entries.clear(),
    get size() {
      return entries.size;
    },
  };

  registry.add(cache);
  return cache;
}

/**
 * A cache holding a single value, for a lookup with no key — the whole team
 * directory, fetched once.
 */
export interface SingletonCache<V> {
  get(): V | undefined;
  set(value: V): void;
  clear(): void;
}

export function createSingletonCache<V>(): SingletonCache<V> {
  let value: V | undefined;
  const cache: SingletonCache<V> = {
    get: () => value,
    set: (next) => {
      value = next;
    },
    clear: () => {
      value = undefined;
    },
  };
  registry.add(cache);
  return cache;
}

/** Empties every registered cache. Call between tests. */
export function clearAllNameCaches(): void {
  for (const cache of registry) cache.clear();
}
