/**
 * Team roles: what a member is allowed to do within one team's operations.
 *
 * GET /v1/teams/{teamId}/roles is the other endpoint that motivated the
 * envelope handling: it answers with a bare JSON array rather than any
 * envelope, which the generic `data ?? values ?? []` read would have turned
 * into "no roles found" against a team that has them.
 */

import { z } from "zod";

import { renderTeamRole, renderTeamRoles } from "../../services/render/teams.js";
import type { TeamRole } from "../../types.js";
import { defineResourceFamily, type ResourceConfig } from "../family.js";
import { rightsField, teamIdField } from "./shapes.js";

const roleWriteShape = {
  name: z.string().min(1).describe("Name of the role, as it appears in the team's settings."),
  rights: rightsField,
};

const toRoleBody = (params: Record<string, unknown>) => ({
  name: params.name,
  rights: params.rights,
});

export const teamRoleResource: ResourceConfig = {
  toolset: "teams",
  path: "/v1/teams/{teamId}/roles",
  noun: "team_role",
  plural: "team_roles",
  idParam: "role_id",
  idField: z.string().min(1).describe("Team role id, from jsm_list_team_roles."),
  itemToken: "identifier",
  parents: [{ param: "team_id", token: "teamId", field: teamIdField }],
  // A bare array, and no paging parameters.
  paging: { kind: "none" },
};

export const teamRoleTools = defineResourceFamily<TeamRole>(teamRoleResource, {
  list: {
    name: "jsm_list_team_roles",
    title: "List roles in a JSM team",
    description: `List the roles defined on a team, with how many rights each one grants.

Args:
  - team_id (string): the team, from jsm_list_teams
  - response_format ('markdown' | 'json'): default 'markdown'

Returns (json format): { "team_roles": [ { "id": string, "name": string, "rights": [...] } ], "pagination": { "count": number, "has_more": false } }

This endpoint returns every role at once and takes no paging parameters, so limit and offset do nothing and has_more is always false.

A role with no rights grants nothing — it is not a shorthand for "everything".`,
    render: (roles) => ["# Team roles", "", renderTeamRoles(roles)].join("\n"),
    emptyMessage:
      "This team has no custom roles, so members hold only the built-in ones. Add one with jsm_create_team_role.",
  },
  get: {
    name: "jsm_get_team_role",
    title: "Get one team role",
    description: `Read one team role in full, including the rights it grants.

Args:
  - team_id (string), role_id (string)
  - response_format ('markdown' | 'json'): default 'markdown'

Returns: { "team_role": { "id": string, "name": string, "rights": [...] } }

Read this before creating or updating a role: rights are free-form objects whose shape is not documented, and copying an existing role's is far more reliable than guessing.`,
    render: (role) => renderTeamRole(role),
  },
  create: {
    name: "jsm_create_team_role",
    title: "Create a role in a JSM team",
    description: `Create a role on a team.

Args:
  - team_id (string): the team
  - name (string): the role name
  - rights (array): the rights it grants, as the API's own objects

Returns: { "team_role": { "id": string, ... } }

Synchronous — the response is the created role.

Read an existing role with jsm_get_team_role first and follow its \`rights\` shape. Passing an empty list creates a role that grants nothing, which is accepted without complaint.`,
    input: roleWriteShape,
    toBody: toRoleBody,
    bodyFields: ["name", "rights"],
    render: (role) => renderTeamRole(role),
  },
  update: {
    name: "jsm_update_team_role",
    title: "Update a team role",
    description: `Change a team role's name or the rights it grants.

Args:
  - team_id (string), role_id (string)
  - name (string), rights (array)

Returns: { "team_role": { "id": string, ... } }

IMPORTANT: \`rights\` replaces the whole list. To add one right you must send the existing ones too — read them with jsm_get_team_role first, or you will silently revoke everything you left out from everyone holding this role.`,
    input: roleWriteShape,
    toBody: toRoleBody,
    bodyFields: ["name", "rights"],
    render: (role) => renderTeamRole(role),
  },
  remove: {
    name: "jsm_delete_team_role",
    title: "Delete a team role",
    description: `Delete a role from a team.

Args:
  - team_id (string), role_id (string)

Returns: { "deleted": true, "role_id": string }

Anyone holding this role loses the rights it granted. Check who holds it before deleting, and prefer narrowing the role's rights with jsm_update_team_role if you only want to reduce access.

Requires delete:ops-config:jira-service-management, which Atlassian account API tokens do not carry — see the README.`,
  },
});
