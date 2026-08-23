/**
 * Turns Atlassian ids into names.
 *
 * Every responder the JSM Operations API returns — on-call participants, alert
 * responders, schedule owners — is a bare id (`712020:9ae5385e-…`). Nothing in
 * the Operations API resolves one to a person, so answering "who do I page?"
 * with something a human can act on means a second call to the Jira platform
 * API for users, and to /v1/teams for teams.
 *
 * The hard rule in this module: **a failed lookup never fails the answer.**
 * Knowing that an unnamed account id is on-call is worth far more than a clean
 * error, so every path here degrades to "ids, plus a line saying why they are
 * still ids" rather than throwing.
 */

import axios from "axios";

import { IDENTITY_CACHE_MAX, USER_LOOKUP_BATCH } from "../constants.js";
import type { JsmClient } from "./client.js";
import type { ResolvedIdentity } from "../types.js";

interface JiraUser {
  accountId?: string;
  displayName?: string;
  emailAddress?: string;
  active?: boolean;
}

interface PlatformTeam {
  teamId?: string;
  teamName?: string;
}

/** What a caller needs to render a resolution attempt honestly. */
export interface Directory {
  /** Resolved entries, keyed by id. Ids that could not be resolved are absent. */
  names: Map<string, ResolvedIdentity>;
  /**
   * Set when a lookup failed. Rendered as a single line beneath the answer so
   * the reader knows the ids are unresolved because of a config gap, not
   * because the responder has no name.
   */
  note?: string;
}

/**
 * Process-wide cache. Display names change far more slowly than a session
 * lasts, and the same rotation gets asked about repeatedly during an incident.
 */
const userCache = new Map<string, ResolvedIdentity>();
let teamCache: Map<string, string> | undefined;

/** Keeps the cache bounded without pulling in an LRU dependency. */
function remember(id: string, value: ResolvedIdentity): void {
  if (userCache.size >= IDENTITY_CACHE_MAX) userCache.clear();
  userCache.set(id, value);
}

/** Exposed for tests: a cached name from a previous case must not leak into the next. */
export function clearDirectoryCache(): void {
  userCache.clear();
  teamCache = undefined;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Explains an identity lookup failure in terms of what to change.
 *
 * Kept separate from handleApiError because the advice differs: a 401/403 here
 * is almost always the Jira user scope missing from a token that is otherwise
 * working fine, which is a different fix from the ops-alert/ops-config scopes.
 */
function describeLookupFailure(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    if (status === 401 || status === 403) {
      return (
        "Responder ids could not be resolved to names: the credentials lack the Jira user scope. " +
        "Add read:jira-user to the token — a separate grant from the ops-alert and ops-config " +
        "scopes, and everything else here works without it. (The granular equivalent is the whole " +
        "set read:application-role:jira, read:group:jira, read:user:jira and read:avatar:jira, " +
        "which Atlassian still marks Beta; read:jira-user is the one to reach for.)"
      );
    }
    if (status === 404) {
      return (
        "Responder ids could not be resolved to names: the Jira API was not reachable for this site. " +
        "Check that JSM_CLOUD_ID is the cloud id of a site with Jira on it."
      );
    }
    return `Responder ids could not be resolved to names (HTTP ${status ?? "network error"}).`;
  }
  return "Responder ids could not be resolved to names.";
}

/**
 * Resolves Jira account ids to display names via /rest/api/3/user/bulk.
 *
 * `maxResults` is sent explicitly because the endpoint defaults it to 10: a
 * batch of 50 ids would come back with 10 names and no indication that the
 * other 40 were dropped.
 */
export async function resolveUsers(client: JsmClient, ids: string[]): Promise<Directory> {
  const names = new Map<string, ResolvedIdentity>();
  const missing: string[] = [];

  for (const id of new Set(ids)) {
    const cached = userCache.get(id);
    if (cached) names.set(id, cached);
    else missing.push(id);
  }

  if (!missing.length) return { names };

  try {
    for (const batch of chunk(missing, USER_LOOKUP_BATCH)) {
      const page = await client.jiraGet<{ values?: JiraUser[] }>("/rest/api/3/user/bulk", {
        accountId: batch,
        maxResults: batch.length,
      });

      for (const user of page.values ?? []) {
        if (!user.accountId) continue;
        const resolved: ResolvedIdentity = {
          id: user.accountId,
          type: "user",
          ...(user.displayName ? { displayName: user.displayName } : {}),
          ...(user.emailAddress ? { emailAddress: user.emailAddress } : {}),
        };
        remember(user.accountId, resolved);
        names.set(user.accountId, resolved);
      }
    }
  } catch (error) {
    // Partial results are kept deliberately: some names beat none.
    return { names, note: describeLookupFailure(error) };
  }

  return { names };
}

/**
 * Resolves team ids to team names via /v1/teams.
 *
 * Sits behind read:ops-config, which any caller reaching this point already
 * holds, so unlike the user lookup this needs no extra grant.
 */
export async function resolveTeams(client: JsmClient): Promise<Map<string, string>> {
  if (teamCache) return teamCache;

  try {
    const response = await client.getOne<{ platformTeams?: PlatformTeam[] }>("/v1/teams");
    const teams = new Map<string, string>();
    for (const team of response.platformTeams ?? []) {
      if (team.teamId && team.teamName) teams.set(team.teamId, team.teamName);
    }
    teamCache = teams;
    return teams;
  } catch {
    // Same rule as above: a missing team name must not cost the caller the answer.
    return new Map();
  }
}

/**
 * Resolves a mixed list of responder ids — users, teams, escalations — in as
 * few calls as possible.
 *
 * `types` says what each id is when the API told us (participants carry a
 * type; a flat user list does not). Ids of unknown type are tried as users,
 * which is what a flat on-call list always contains.
 */
export async function resolveIdentities(
  client: JsmClient,
  entries: Array<{ id: string; type?: string }>,
): Promise<Directory> {
  const userIds = entries.filter((e) => !e.type || e.type === "user").map((e) => e.id);
  const teamIds = entries.filter((e) => e.type === "team").map((e) => e.id);

  const [users, teams] = await Promise.all([
    userIds.length
      ? resolveUsers(client, userIds)
      : Promise.resolve<Directory>({ names: new Map() }),
    teamIds.length ? resolveTeams(client) : Promise.resolve(new Map<string, string>()),
  ]);

  const names = new Map(users.names);
  for (const entry of entries) {
    if (entry.type === "team") {
      const teamName = teams.get(entry.id);
      if (teamName) names.set(entry.id, { id: entry.id, type: "team", displayName: teamName });
    }
  }

  return users.note ? { names, note: users.note } : { names };
}

/**
 * Renders one responder for a human: a name where we have one, and always the
 * id, because the id is what the JSM UI and every other tool here take.
 */
export function renderIdentity(identity: ResolvedIdentity): string {
  const kind = identity.type;
  const labels = [
    ...(kind && kind !== "user" ? [kind] : []),
    ...(identity.forwarded ? ["forwarded"] : []),
  ];
  const suffix = labels.length ? ` (${labels.join(", ")})` : "";

  // No name means the lookup could not resolve it. Show the id plainly rather
  // than a placeholder — the id is what every other tool here accepts.
  if (!identity.displayName) return `\`${identity.id}\`${suffix}`;

  const email = identity.emailAddress ? ` (${identity.emailAddress})` : "";
  return `**${identity.displayName}**${email}${suffix} — \`${identity.id}\``;
}
