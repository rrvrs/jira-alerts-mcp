/**
 * Input shapes for the alert write tools.
 */

import { z } from "zod";

import { alertIdField, noteField, sourceField, userField } from "../../schemas/common.js";

/** Fields shared by every alert action. */
const actionBaseShape = {
  alert_id: alertIdField,
  user: userField,
  source: sourceField,
};

/**
 * Every mutating endpoint returns this same receipt rather than the updated
 * alert, so every write tool declares the same output.
 */
export const asyncOutputSchema = {
  requestId: z.string().optional(),
  result: z.string().optional(),
  alert_id: z.string(),
};

export const acknowledgeShape = {
  ...actionBaseShape,
  note: z
    .string()
    .max(25_000)
    .optional()
    .describe("Optional note recorded alongside the acknowledgement."),
};

export const closeShape = {
  ...actionBaseShape,
  note: z
    .string()
    .max(25_000)
    .optional()
    .describe(
      "Optional note explaining the resolution. Strongly recommended — it's the record future responders will read.",
    ),
};

export const addNoteShape = {
  ...actionBaseShape,
  note: noteField,
};

export const addResponderShape = {
  ...actionBaseShape,
  responder_id: z
    .string()
    .min(1)
    .describe("Id of the user, team, escalation or schedule to add as a responder."),
  responder_type: z
    .enum(["user", "team", "escalation", "schedule"])
    .describe("What kind of entity responder_id refers to."),
  note: z.string().max(25_000).optional().describe("Optional note recorded with the change."),
};
