/** Shared fields for the teams family. */

import { z } from "zod";

export const teamIdField = z
  .string()
  .min(1, "team_id must not be empty")
  .describe("Team id (a UUID), from jsm_list_teams. This is the teamId field, not the team name.");

export const rightsField = z
  .array(z.record(z.string(), z.unknown()))
  .describe(
    "Rights this role grants, as the API's own objects. Read an existing role with " +
      "jsm_get_team_role first and follow its shape — an empty list creates a role that grants " +
      "nothing rather than a role that grants everything.",
  );
