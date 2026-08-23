/**
 * Narrows a timeline Shift down to what the renderer needs, so format.ts does
 * not have to import the timeline types and the two stay independently testable.
 */

import type { ShiftSummary } from "../../services/format.js";
import type { Shift } from "./timeline.js";

export function toShiftSummary(shift: Shift): ShiftSummary {
  return {
    ...(shift.start ? { start: shift.start } : {}),
    ...(shift.end ? { end: shift.end } : {}),
    ...(shift.rotationName ? { rotationName: shift.rotationName } : {}),
    ...(shift.type ? { type: shift.type } : {}),
    ...(shift.forwardedFrom ? { forwardedFrom: shift.forwardedFrom } : {}),
  };
}
