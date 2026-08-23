/**
 * The shared body of jsm_get_on_call and jsm_get_next_on_call.
 *
 * Both answer two questions that come from different places. **Who** comes from
 * /on-calls and /next-on-calls, which flatten teams and escalations down to
 * real people server-side — something the timeline does not reliably do, and
 * getting it wrong means handing someone a team uuid when they asked who to
 * page. **When** comes from the schedule timeline, which is the only endpoint
 * that exposes shift boundaries at all.
 *
 * The two calls are issued in parallel, so carrying boundaries costs the caller
 * no extra round-trip in wall-clock terms.
 */

import type { JsmClient } from "../../services/client.js";
import { extractOnCall, type Responder } from "../../services/format.js";
import type { OnCallData } from "../../types.js";
import { fetchTimeline, type Shift, shiftAfter, shiftsAt, toShifts } from "./timeline.js";

export interface OnCallAnswer {
  responders: Responder[];
  /** The shift these responders are covering, when the timeline agreed. */
  shift?: Shift;
  /** The raw API payload, preserved unmodified for callers that read it. */
  raw: OnCallData;
  /** Things the reader needs to know about what could not be determined. */
  notes: string[];
}

export interface OnCallRequest {
  scheduleId: string;
  /** The instant to evaluate at. "Next" is computed relative to this too. */
  instant: Date;
  next: boolean;
  flat: boolean;
  /** The caller's raw date string, passed to the API untouched. */
  date?: string | undefined;
}

/**
 * Picks the shift that belongs to the people we are about to name.
 *
 * Matching on responders rather than just taking the first candidate matters
 * when a schedule has overlapping rotations: reporting one rotation's handover
 * time next to another rotation's responder would be a confidently wrong
 * answer, which is the failure mode this whole change exists to remove.
 */
function matchingShift(candidates: Shift[], responderIds: Set<string>): Shift | undefined {
  if (!responderIds.size) return candidates[0];

  return (
    candidates.find((shift) =>
      shift.responders.some((responder) => responder.id && responderIds.has(responder.id)),
    ) ?? undefined
  );
}

export async function answerOnCall(
  client: JsmClient,
  request: OnCallRequest,
): Promise<OnCallAnswer> {
  const path = request.next ? "next-on-calls" : "on-calls";

  const [whoResult, timelineResult] = await Promise.allSettled([
    client.getOne<OnCallData>(`/v1/schedules/${encodeURIComponent(request.scheduleId)}/${path}`, {
      flat: request.flat,
      date: request.date,
    }),
    fetchTimeline(client, request.scheduleId, request.instant),
  ]);

  const notes: string[] = [];
  const raw = whoResult.status === "fulfilled" ? whoResult.value : {};
  let responders = whoResult.status === "fulfilled" ? extractOnCall(raw, request.next) : [];

  const shifts = timelineResult.status === "fulfilled" ? toShifts(timelineResult.value) : [];

  if (timelineResult.status === "rejected") {
    notes.push(
      "Shift boundaries are unavailable: the schedule timeline could not be read. The responders above are still authoritative.",
    );
  }

  // The timeline is also the safety net. If the on-call endpoint failed, an
  // answer derived from shift periods beats no answer at all.
  if (whoResult.status === "rejected") {
    if (!shifts.length) throw whoResult.reason;

    const fallback = request.next
      ? [shiftAfter(shifts, request.instant)].filter((shift): shift is Shift => Boolean(shift))
      : shiftsAt(shifts, request.instant);

    responders = fallback.flatMap((shift) =>
      shift.responders.map((responder) => ({
        id: responder.id!,
        ...(responder.type ? { type: responder.type } : {}),
      })),
    );

    notes.push(
      "Derived from the schedule timeline: the on-call endpoint could not be reached, so teams and escalations may not be expanded to individual people.",
    );
  }

  const responderIds = new Set(responders.map((responder) => responder.id));
  const candidates = request.next
    ? [shiftAfter(shifts, request.instant)].filter((shift): shift is Shift => Boolean(shift))
    : shiftsAt(shifts, request.instant);

  const shift = matchingShift(candidates, responderIds);

  if (shifts.length && !shift && responders.length) {
    notes.push(
      "No timeline period matched these responders, so no shift boundary is reported. They may be covering through an escalation rather than a rotation.",
    );
  }

  return { responders, ...(shift ? { shift } : {}), raw, notes };
}
