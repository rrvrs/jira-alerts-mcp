/**
 * The schedule configuration toolset.
 *
 * Schedule discovery (jsm_list_schedules) is deliberately not here — it sits in
 * the `oncall` toolset, because finding a schedule id is the first step of
 * answering "who is on call?" and that should not require loading the whole
 * configuration family.
 */

import type { AnyToolDefinition } from "../define.js";
import { overrideTools } from "./overrides.js";
import { rotationTools } from "./rotations.js";
import { scheduleTools } from "./schedules.js";

export const scheduleConfigTools: AnyToolDefinition[] = [
  ...scheduleTools,
  ...rotationTools,
  ...overrideTools,
];
