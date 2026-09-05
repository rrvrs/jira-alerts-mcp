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

/** Responder reference, as every alert endpoint that takes one spells it. */
const responderEntry = z.object({
  id: z.string().min(1).describe("Id of the user, team, escalation or schedule."),
  type: z.enum(["user", "team", "escalation", "schedule"]).describe("What `id` refers to."),
});

export const createAlertShape = {
  message: z
    .string()
    .min(1, "message must not be empty")
    .describe(
      "One-line summary of what is wrong, read first by whoever gets paged. The only required field.",
    ),
  alias: z
    .string()
    .optional()
    .describe(
      "Client-defined de-duplication key. Creating against an alias that already has an OPEN alert " +
        "does not create a second one — it increments that alert's count. This is the field that makes " +
        "creation safe to retry, and the field that makes it silently do nothing if reused carelessly.",
    ),
  description: z
    .string()
    .optional()
    .describe("Longer detail: impact, how to reproduce, what to try. Shown on the alert page."),
  priority: z
    .enum(["P1", "P2", "P3", "P4", "P5"])
    .optional()
    .describe("P1 is highest, P5 lowest. Omitted lets the routing rules decide."),
  responders: z
    .array(responderEntry)
    .optional()
    .describe(
      "Who to notify. Omit to let the team's routing rules decide, which is usually what you want — " +
        "naming responders explicitly bypasses routing.",
    ),
  visible_to: z
    .array(
      z.object({
        id: z.string().min(1),
        type: z.enum(["user", "team"]),
      }),
    )
    .max(50)
    .optional()
    .describe(
      "Restricts who can see the alert, beyond the responders. Max 50 entries. Omit for team-default visibility.",
    ),
  entity: z
    .string()
    .optional()
    .describe("What the alert is about — a host, service or application, e.g. 'payments-api'."),
  tags: z
    .array(z.string())
    .optional()
    .describe("Tags for searching and grouping, e.g. ['db', 'prod']."),
  actions: z
    .array(z.string())
    .optional()
    .describe(
      "Names of custom actions your organisation has configured for alerts. Not free text — an " +
        "unrecognised name is ignored rather than rejected.",
    ),
  extra_properties: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe("Arbitrary key/value context carried on the alert, e.g. {'region': 'us-east-1'}."),
  note: z.string().max(25_000).optional().describe("Note recorded on the new alert's timeline."),
  // No `user` here, unlike the other write shapes. CreateAlertRequest
  // enumerates its twelve fields and `user` is not among them, so offering it
  // would advertise an actor override the endpoint does not implement. The
  // creating account is the credential owner; `source` is the field that
  // records where the alert came from.
  source: sourceField,
};

/** Create returns the same receipt, but there is no alert id to echo yet. */
export const createOutputSchema = {
  requestId: z.string().optional(),
  result: z.string().optional(),
  alias: z.string().optional(),
};

export const unacknowledgeShape = {
  ...actionBaseShape,
  note: z
    .string()
    .max(25_000)
    .optional()
    .describe("Optional note explaining why the acknowledgement is being taken back."),
};

export const snoozeShape = {
  ...actionBaseShape,
  end_time: z
    .string()
    .datetime({ offset: true })
    .describe(
      "When the snooze ends, as an ISO 8601 instant with an offset, e.g. '2026-09-05T18:30:00Z'. " +
        "Must be in the future — a past instant is accepted and the alert un-snoozes immediately.",
    ),
  note: z.string().max(25_000).optional().describe("Optional note recorded with the snooze."),
};

export const assignShape = {
  ...actionBaseShape,
  account_id: z
    .string()
    .min(1)
    .describe(
      "Atlassian account id of the assignee, e.g. '712020:9ae5385e-…'. NOT an email address and " +
        "NOT a display name — both are rejected. Account ids appear in jsm_get_alert's responder " +
        "and owner fields and in jsm_get_on_call.",
    ),
  note: z.string().max(25_000).optional().describe("Optional note recorded with the assignment."),
};

export const escalateShape = {
  ...actionBaseShape,
  escalation_id: z
    .string()
    .min(1)
    .describe(
      "Id of the escalation policy to escalate through. This is an escalation id, not a team or " +
        "schedule id — the three are separate objects with separate ids.",
    ),
  note: z.string().max(25_000).optional().describe("Optional note recorded with the escalation."),
};

export const updateFieldShape = {
  // Deliberately not actionBaseShape: the three PATCH endpoints behind this
  // tool enumerate one property each and take no actor override.
  alert_id: alertIdField,
  field: z
    .enum(["priority", "message", "description"])
    .describe("Which field to overwrite. Each is a separate endpoint under the hood."),
  value: z
    .string()
    .describe(
      "The new value. For field='priority' this must be exactly one of P1, P2, P3, P4, P5. " +
        "For 'message' keep it to one line — it is the headline responders read first. " +
        "For 'description' anything goes, and an empty string clears it.",
    ),
};

export const updateNoteShape = {
  alert_id: alertIdField,
  note_id: z
    .string()
    .min(1)
    .describe("Id of the note to edit, from jsm_list_alert_notes. Not the note's text."),
  note: noteField,
};

export const deleteNoteShape = {
  alert_id: alertIdField,
  note_id: z
    .string()
    .min(1)
    .describe("Id of the note to delete, from jsm_list_alert_notes. Not the note's text."),
};

/** A note edit is synchronous and answers with the note itself. */
export const noteOutputSchema = {
  alert_id: z.string(),
  note_id: z.string().optional(),
  id: z.string().optional(),
  note: z.string().optional(),
  owner: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
};

export const deletedOutputSchema = {
  deleted: z.boolean(),
  note_id: z.string().optional(),
};
