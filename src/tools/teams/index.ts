/** The teams toolset: teams, team roles, contact methods. */

import type { AnyToolDefinition } from "../define.js";
import { contactSwitchTools, contactTools } from "./contacts.js";
import { teamRoleTools } from "./roles.js";
import { listTeams } from "./teams.js";

export const teamTools: AnyToolDefinition[] = [
  listTeams,
  ...teamRoleTools,
  ...contactTools,
  ...contactSwitchTools,
];
