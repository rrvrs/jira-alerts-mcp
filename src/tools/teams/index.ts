/** The teams toolset: teams, team roles, site-wide user roles, contact methods. */

import type { AnyToolDefinition } from "../define.js";
import { contactSwitchTools, contactTools } from "./contacts.js";
import { teamRoleTools } from "./roles.js";
import { listTeams } from "./teams.js";
import { assignUserRole, userRoleTools } from "./user-roles.js";

export const teamTools: AnyToolDefinition[] = [
  listTeams,
  ...teamRoleTools,
  ...userRoleTools,
  assignUserRole,
  ...contactTools,
  ...contactSwitchTools,
];
