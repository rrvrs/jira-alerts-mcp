/**
 * Shared fields for the schedule configuration family.
 */

import { z } from "zod";

export const scheduleIdField = z
  .string()
  .min(1, "schedule_id must not be empty")
  .describe(
    "Schedule id (a UUID), from jsm_list_schedules. This is an id, not a name — every schedule " +
      "endpoint takes the id in the path and a name sent there returns 404.",
  );

export const rotationIdField = z
  .string()
  .min(1)
  .describe("Rotation id (a UUID), from jsm_list_rotations.");

export const overrideAliasField = z
  .string()
  .min(1)
  .describe(
    "The override's alias — the API addresses overrides by alias, not by id, and it is the " +
      "`alias` field jsm_list_overrides returns.",
  );

/** Participants and override responders are both {id, type} references. */
export const participantField = z
  .array(
    z.object({
      id: z.string().min(1).describe("Atlassian account id of the participant."),
      type: z
        .enum(["user", "team", "escalation"])
        .describe("What `id` refers to. Most rotations are made of users."),
    }),
  )
  .describe(
    "Who is in the rotation, in order. Order is the rotation order, so this is not a set — " +
      "re-sending it in a different order changes who is on call when.",
  );

export const rotationTypeField = z
  .enum(["daily", "weekly", "hourly"])
  .describe("How often the rotation hands over. Combined with `length` to give the shift length.");

export const startDateField = z
  .string()
  .describe("ISO 8601 instant the rotation starts, e.g. '2026-09-01T09:00:00Z'.");

export const endDateField = z
  .string()
  .describe(
    "ISO 8601 instant this ends. A rotation with an end date stops paging anyone once it " +
      "passes, which is a common way for a schedule to go quiet without anyone noticing.",
  );
