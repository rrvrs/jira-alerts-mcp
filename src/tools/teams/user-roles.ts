/**
 * Custom user roles: rights held across the site, rather than within one team.
 *
 * Updated with PUT, and assignment is its own endpoint rather than a field on
 * the role — so jsm_assign_user_role is hand-written.
 */

import { z } from "zod";

import { renderUserRole, renderUserRoles } from "../../services/render/teams.js";
import type { CustomUserRole } from "../../types.js";
import { defineTool } from "../define.js";
import { executeWrite } from "../execute-write.js";
import { defineResourceFamily, type ResourceConfig } from "../family.js";

const roleIdField = z.string().min(1).describe("Custom user role id, from jsm_list_user_roles.");

const userRoleWriteShape = {
  name: z.string().min(1).describe("Name of the role."),
  granted_rights: z
    .array(z.string())
    .optional()
    .describe("Rights this role grants, by name. Read an existing role to see the vocabulary."),
  disallowed_rights: z
    .array(z.string())
    .optional()
    .describe(
      "Rights this role explicitly withholds. These subtract from what granted_rights gives, so " +
        "a role can look permissive and not be — check both before concluding someone has access.",
    ),
};

const toUserRoleBody = (params: Record<string, unknown>) => ({
  name: params.name,
  grantedRights: params.granted_rights,
  disallowedRights: params.disallowed_rights,
});

const userRoleBodyFields = ["name", "grantedRights", "disallowedRights"];

export const userRoleResource: ResourceConfig = {
  toolset: "teams",
  path: "/v1/roles",
  noun: "user_role",
  plural: "user_roles",
  idParam: "role_id",
  idField: roleIdField,
  itemToken: "identifier",
  updateMethod: "PUT",
};

export const userRoleTools = defineResourceFamily<CustomUserRole>(userRoleResource, {
  list: {
    name: "jsm_list_user_roles",
    title: "List custom user roles",
    description: `List the custom user roles defined on this site.

These are site-wide roles, distinct from the per-team roles jsm_list_team_roles returns. Someone's effective access is the combination of both.

Args:
  - limit (number): 1-100, default 20
  - offset (number): records to skip, default 0
  - response_format ('markdown' | 'json'): default 'markdown'

Returns (json format): { "user_roles": [ { "id": string, "name": string } ], "pagination": {...} }

The list carries only ids and names; read one with jsm_get_user_role to see the rights.`,
    render: (roles) => ["# Custom user roles", "", renderUserRoles(roles)].join("\n"),
    emptyMessage:
      "No custom user roles on this site, so everyone holds only the built-in ones. Create one with jsm_create_user_role.",
  },
  get: {
    name: "jsm_get_user_role",
    title: "Get one custom user role",
    description: `Read one custom user role, including the rights it grants and the ones it explicitly withholds.

Args:
  - role_id (string)
  - response_format ('markdown' | 'json'): default 'markdown'

Returns: { "user_role": { "id": string, "name": string, "grantedRights": [string], "disallowedRights": [string] } }

Read both lists before concluding what someone can do: disallowedRights subtracts from grantedRights, so a role can name a right and still not confer it.`,
    render: (role) => renderUserRole(role),
  },
  create: {
    name: "jsm_create_user_role",
    title: "Create a custom user role",
    description: `Create a site-wide custom user role.

Args:
  - name (string): required
  - granted_rights (string[], optional): rights the role confers
  - disallowed_rights (string[], optional): rights it explicitly withholds

Returns: { "user_role": { "id": string, ... } }

Synchronous. Creating a role does not give it to anyone — assign it with jsm_assign_user_role.

Right names are a fixed vocabulary the API does not publish here. Read an existing role with jsm_get_user_role and copy the spelling rather than inventing plausible names, which are accepted and then confer nothing.`,
    input: userRoleWriteShape,
    toBody: toUserRoleBody,
    bodyFields: userRoleBodyFields,
    render: (role) => renderUserRole(role),
  },
  update: {
    name: "jsm_update_user_role",
    title: "Update a custom user role",
    description: `Change a custom user role's name or rights.

Args:
  - role_id (string): the role to change
  - name (string), granted_rights (string[]), disallowed_rights (string[])

Returns: { "user_role": { "id": string, ... } }

IMPORTANT: this is a PUT — it replaces the role rather than patching it, and both rights lists replace wholesale. Read the current values with jsm_get_user_role and send them back with your change, or everyone holding this role silently loses the rights you left out.`,
    input: userRoleWriteShape,
    toBody: toUserRoleBody,
    bodyFields: userRoleBodyFields,
    render: (role) => renderUserRole(role),
  },
  remove: {
    name: "jsm_delete_user_role",
    title: "Delete a custom user role",
    description: `Delete a custom user role.

Args:
  - role_id (string)

Returns: { "deleted": true, "role_id": string }

Everyone holding this role loses the rights it granted, immediately and site-wide. Prefer narrowing the role with jsm_update_user_role if the goal is to reduce access rather than remove it.

Requires delete:ops-config:jira-service-management, which Atlassian account API tokens do not carry — see the README.`,
  },
});

export const assignUserRole = defineTool({
  name: "jsm_assign_user_role",
  toolset: "teams",
  endpoint: { method: "POST", path: "/v1/roles/assign", body: ["accountId", "roleId"] },
  title: "Assign a custom user role to someone",
  description: `Give a custom user role to an account.

Args:
  - account_id (string): the Atlassian account id receiving the role
  - role_id (string): the role to give, from jsm_list_user_roles

Returns: { "assigned": true, "account_id": string, "role_id": string }

Assignment is its own endpoint rather than a field on the role, so this is how a role reaches a person — creating a role with jsm_create_user_role gives it to nobody.

This grants access. Confirm the account id is the person the user means before calling it: account ids are opaque and two people's ids look equally plausible.`,
  inputSchema: {
    account_id: z
      .string()
      .min(1)
      .describe("Atlassian account id of the person receiving the role, e.g. '712020:9ae5385e-…'."),
    role_id: roleIdField,
  },
  outputSchema: {
    assigned: z.boolean(),
    account_id: z.string(),
    role_id: z.string(),
  },
  annotations: {
    readOnlyHint: false,
    // Granting site-wide rights is worth a prompt.
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (params, client) =>
    executeWrite(client, {
      label: "Assign user role",
      method: "POST",
      path: "/v1/roles/assign",
      body: { accountId: params.account_id, roleId: params.role_id },
      mode: "sync",
      render: () => `Role \`${params.role_id}\` assigned to account \`${params.account_id}\`.`,
      structured: () => ({
        assigned: true,
        account_id: params.account_id,
        role_id: params.role_id,
      }),
    }),
});
