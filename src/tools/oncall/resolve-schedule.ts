/**
 * Turns a schedule name into a schedule id.
 *
 * Every schedule endpoint takes an id in the path and nothing else — the
 * `scheduleIdentifierType` parameter these tools used to send is not part of
 * the JSM Operations API at all (the only `identifierType` in the spec is on
 * /v1/roles), so a name went out as a path segment and came back 404. The
 * timeline endpoint is id-only too, so this resolution has to happen here.
 */

import type { JsmClient } from "../../services/client.js";
import type { Paged, Schedule } from "../../types.js";

export interface ResolvedSchedule {
  id: string;
  /** The schedule's real name, when we looked it up. Used for headings. */
  name?: string;
}

/** Thrown for a name that matches no schedule, or more than one. */
export class ScheduleLookupError extends Error {}

/**
 * Process-wide name -> id cache. The mapping is stable, and during an incident
 * the same schedule gets asked about repeatedly.
 */
const cache = new Map<string, ResolvedSchedule>();

/** Exposed for tests, so one case's cached schedule cannot answer the next. */
export function clearScheduleCache(): void {
  cache.clear();
}

export async function resolveScheduleId(
  client: JsmClient,
  identifier: string,
  identifierType: "id" | "name",
): Promise<ResolvedSchedule> {
  if (identifierType === "id") return { id: identifier };

  const key = identifier.toLowerCase();
  const cached = cache.get(key);
  if (cached) return cached;

  // `query` is documented as an exact, case-insensitive match on name (a
  // trailing `*` makes it a prefix match), so this is a lookup rather than a
  // scan. Ask for two: one is enough to answer, two is enough to detect an
  // ambiguous name instead of silently picking one.
  const page = await client.getCollection<Schedule>("/v1/schedules", {
    query: identifier,
    size: 2,
  });

  return pickSchedule(page, identifier, key);
}

function pickSchedule(
  page: Paged<Schedule>,
  identifier: string,
  cacheKey: string,
): ResolvedSchedule {
  const matches = page.items.filter((schedule) => schedule.id);

  if (!matches.length) {
    throw new ScheduleLookupError(
      `No schedule is named '${identifier}'. Names are matched exactly (case-insensitively) — ` +
        `list what exists with jsm_list_schedules, or pass the schedule id with ` +
        `schedule_identifier_type='id'.`,
    );
  }

  if (matches.length > 1) {
    const ids = matches.map((schedule) => `'${schedule.name}' (${schedule.id})`).join(", ");
    throw new ScheduleLookupError(
      `More than one schedule matches '${identifier}': ${ids}. Re-run with the id you want and ` +
        `schedule_identifier_type='id'.`,
    );
  }

  const match = matches[0]!;
  const resolved: ResolvedSchedule = {
    id: match.id,
    ...(match.name ? { name: match.name } : {}),
  };
  cache.set(cacheKey, resolved);
  return resolved;
}
