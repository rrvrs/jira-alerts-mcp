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
    .describe("Whether schedule_id holds an id or a schedule name."),
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
