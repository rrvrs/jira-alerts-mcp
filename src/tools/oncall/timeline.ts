/**
 * Shift boundaries, from the schedule timeline.
 *
 * The /on-calls endpoint answers "who" and nothing else. It cannot say when the
 * current shift ends, and its "next" is always relative to now — which is why
 * answering "when does Saket hand over?" used to mean probing timestamps by
 * hand, one call per guess. The timeline endpoint returns every rotation period
 * with real start and end times, so one call answers who, until when, and who
 * is next.
 */

import type { JsmClient } from "../../services/client.js";
import type { ScheduleTimeline, TimelinePeriod, TimelineResponder } from "../../types.js";
import { TIMELINE_LOOKBACK_MS, TIMELINE_WEEKS } from "../../constants.js";

/** One period, tagged with the rotation it belongs to. */
export interface Shift {
  rotationId?: string;
  rotationName?: string;
  start?: string;
  end?: string;
  /** "base" | "override" | "forwarding" | "historical". */
  type?: string;
  responders: TimelineResponder[];
  /** Set when the shift is covered because someone forwarded it. */
  forwardedFrom?: TimelineResponder;
}

/**
 * Fetches the timeline window containing `instant`.
 *
 * The window is deliberately not centred on the requested day. The API starts
 * the range at the beginning of the `intervalUnit` containing `date`, so asking
 * for the current week would clip a shift that began last night — reporting a
 * handover time of midnight that never happened. Asking for a multi-week window
 * that starts a week earlier keeps the instant we care about interior, so the
 * boundaries we read are the real ones.
 */
export async function fetchTimeline(
  client: JsmClient,
  scheduleId: string,
  instant: Date,
): Promise<ScheduleTimeline> {
  const windowStart = new Date(instant.getTime() - TIMELINE_LOOKBACK_MS);

  return client.getOne<ScheduleTimeline>(
    `/v1/schedules/${encodeURIComponent(scheduleId)}/timeline`,
    {
      date: windowStart.toISOString(),
      interval: TIMELINE_WEEKS,
      intervalUnit: "weeks",
    },
  );
}

/** "noone" is an unfilled slot in the rotation, not a person. */
function realResponders(period: TimelinePeriod): TimelineResponder[] {
  // flattenedResponders is only populated for some period types, so fall back
  // to the single responder rather than reporting an empty shift.
  const responders = period.flattenedResponders?.length
    ? period.flattenedResponders
    : period.responder
      ? [period.responder]
      : [];

  return responders.filter((responder) => responder.id && responder.type !== "noone");
}

/** Flattens every rotation's periods into one list of shifts, oldest first. */
export function toShifts(timeline: ScheduleTimeline): Shift[] {
  const shifts: Shift[] = [];

  for (const rotation of timeline.finalTimeline?.rotations ?? []) {
    // A deleted rotation still appears in the timeline, carrying history.
    if (rotation.deleted) continue;

    for (const period of rotation.periods ?? []) {
      shifts.push({
        ...(rotation.id ? { rotationId: rotation.id } : {}),
        ...(rotation.name ? { rotationName: rotation.name } : {}),
        ...(period.startDate ? { start: period.startDate } : {}),
        ...(period.endDate ? { end: period.endDate } : {}),
        ...(period.type ? { type: period.type } : {}),
        ...(period.from ? { forwardedFrom: period.from } : {}),
        responders: realResponders(period),
      });
    }
  }

  return shifts.sort((a, b) => (a.start ?? "").localeCompare(b.start ?? ""));
}

function startsBefore(shift: Shift, instant: Date): boolean {
  return !shift.start || new Date(shift.start).getTime() <= instant.getTime();
}

function endsAfter(shift: Shift, instant: Date): boolean {
  return !shift.end || new Date(shift.end).getTime() > instant.getTime();
}

/** Every shift covering `instant` — more than one when rotations overlap. */
export function shiftsAt(shifts: Shift[], instant: Date): Shift[] {
  return shifts.filter(
    (shift) => shift.responders.length && startsBefore(shift, instant) && endsAfter(shift, instant),
  );
}

/**
 * The next shift to begin strictly after `instant`.
 *
 * Shifts whose responders are the same as the current ones are still returned:
 * "the same person continues" is a real and useful answer to "who is next".
 */
export function shiftAfter(shifts: Shift[], instant: Date): Shift | undefined {
  return shifts.find(
    (shift) =>
      shift.responders.length && shift.start && new Date(shift.start).getTime() > instant.getTime(),
  );
}

/** Every distinct responder across a set of shifts, for one batched lookup. */
export function respondersOf(shifts: Shift[]): Array<{ id: string; type?: string }> {
  const seen = new Map<string, { id: string; type?: string }>();

  for (const shift of shifts) {
    for (const responder of shift.responders) {
      if (responder.id && !seen.has(responder.id)) {
        seen.set(responder.id, {
          id: responder.id,
          ...(responder.type ? { type: responder.type } : {}),
        });
      }
    }
    if (shift.forwardedFrom?.id && !seen.has(shift.forwardedFrom.id)) {
      seen.set(shift.forwardedFrom.id, { id: shift.forwardedFrom.id, type: "user" });
    }
  }

  return [...seen.values()];
}

/**
 * Whether a shift needs the /on-calls endpoint to be readable.
 *
 * The timeline hands back a team or escalation id unexpanded when it has no
 * flattenedResponders for that period. A team id is not something anyone can
 * page, so this is the signal to spend one extra call getting real people.
 */
export function needsFlattening(shifts: Shift[]): boolean {
  return shifts.some((shift) =>
    shift.responders.some(
      (responder) => responder.type === "team" || responder.type === "escalation",
    ),
  );
}
