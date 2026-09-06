/**
 * Teams: discovery, and turning Operations on for a team.
 *
 * GET /v1/teams is the endpoint that motivated `itemsKey` and the unpaged
 * dialect. It answers under `platformTeams` rather than `data` or `values`, and
 * takes no paging parameters at all — so the generic envelope handling would
 * have reported "no teams found" against a populated site, and the
 * `fetched >= limit` heuristic would have claimed another page forever.
 */

import { renderTeams } from "../../services/render/teams.js";
import type { PlatformTeam } from "../../types.js";
import { defineListOperation, type ResourceConfig } from "../family.js";
import { teamIdField } from "./shapes.js";

export const teamResource: ResourceConfig = {
  toolset: "teams",
  path: "/v1/teams",
  noun: "team",
  plural: "teams",
  idParam: "team_id",
  idField: teamIdField,
  // Neither `data` nor `values`, and no paging parameters.
  itemsKey: "platformTeams",
  paging: { kind: "none" },
};

export const listTeams = defineListOperation<PlatformTeam>(teamResource, {
  name: "jsm_list_teams",
  title: "List JSM teams",
  description: `List the teams on this site, with their ids.

Start here whenever something needs a team id: creating a schedule, adding a team as an alert responder, or reading a team's roles and policies.

Args:
  - response_format ('markdown' | 'json'): default 'markdown'

Returns (json format): { "teams": [ { "teamId": string, "teamName": string } ], "pagination": { "count": number, "has_more": false } }

This endpoint returns every team in one response and takes no paging parameters, so \`limit\` and \`offset\` do nothing here. has_more is false unless the response was too large to render, in which case it is trimmed and there is no way to ask for the rest — narrow the request instead.

An empty list usually means the credentials cannot see any team rather than that the site has none — team visibility is per-account.

Examples:
  - "Which teams exist?" -> no args
  - "Create a schedule for the payments team" -> this first, to get the team id`,
  render: (teams) => ["# Teams", "", renderTeams(teams)].join("\n"),
  emptyMessage:
    "No teams found. Team visibility is per-account, so this usually means the credentials cannot see any team rather than that none exist.",
});
