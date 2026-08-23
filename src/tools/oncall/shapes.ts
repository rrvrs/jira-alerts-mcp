/**
 * Input shapes for the on-call tools.
 */

import { z } from "zod";

import { limitField, offsetField, responseFormatField } from "../../schemas/common.js";

export const listSchedulesShape = {
  limit: limitField,
  offset: offsetField,
  response_format: responseFormatField,
};

/** Shared by both on-call lookups. jsm_get_on_call extends it with `date`. */
export const onCallShape = {
  schedule_id: z
    .string()
    .min(1)
    .describe("Schedule id, or the schedule name when schedule_identifier_type='name'."),
  schedule_identifier_type: z
    .enum(["id", "name"])
    .default("id")
    .describe(
      "Whether schedule_id holds an id or a schedule name. A name costs one extra lookup, because every schedule endpoint takes an id.",
    ),
  flat: z
    .boolean()
    .default(true)
    .describe(
      "true (default) returns a flat list of on-call user identifiers. false returns the nested structure showing which rotation or escalation each person came from.",
    ),
  response_format: responseFormatField,
};

export const currentOnCallShape = {
  ...onCallShape,
  date: z
    .string()
    .optional()
    .describe(
      "ISO 8601 timestamp to evaluate the rotation at, e.g. '2026-08-21T18:30:00Z'. Defaults to now. Use this to answer 'who was on-call when this fired?'",
    ),
};

/**
 * next-on-calls takes a `date` too — "next" is computed relative to it rather
 * than to now, which is what makes "who is on after this shift?" answerable
 * for any reference point instead of only the present moment.
 */
export const nextOnCallShape = {
  ...onCallShape,
  date: z
    .string()
    .optional()
    .describe(
      "ISO 8601 reference timestamp. The next shift is computed relative to this instant rather than to now, e.g. '2026-08-21T18:30:00Z'. Defaults to now.",
    ),
};

/** jsm_get_schedule_timeline: a schedule, and a window to centre on. */
export const timelineShape = {
  schedule_id: onCallShape.schedule_id,
  schedule_identifier_type: onCallShape.schedule_identifier_type,
  date: z
    .string()
    .optional()
    .describe(
      "ISO 8601 instant the returned window should cover, e.g. '2026-08-27T12:00:00Z'. Defaults to now.",
    ),
  response_format: responseFormatField,
};
