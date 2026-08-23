/**
 * Tests for shift-boundary extraction.
 *
 * These are the calculations that replace probing jsm_get_on_call at guessed
 * timestamps, so the edges matter more than the happy path: a shift that
 * started yesterday, a rotation that was deleted, an unfilled slot.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ScheduleTimeline } from "../../types.js";
import { respondersOf, shiftAfter, shiftsAt, toShifts } from "./timeline.js";

/** Two consecutive daily shifts, handing over at 09:00. */
const timeline: ScheduleTimeline = {
  finalTimeline: {
    rotations: [
      {
        id: "rot-1",
        name: "Primary Rotation",
        periods: [
          {
            startDate: "2026-08-22T09:00:00Z",
            endDate: "2026-08-23T09:00:00Z",
            type: "base",
            responder: { id: "user-saket", type: "user" },
          },
          {
            startDate: "2026-08-23T09:00:00Z",
            endDate: "2026-08-24T09:00:00Z",
            type: "base",
            responder: { id: "user-ada", type: "user" },
          },
        ],
      },
    ],
  },
};

describe("toShifts", () => {
  it("flattens rotations into shifts carrying their rotation name", () => {
    const shifts = toShifts(timeline);

    assert.equal(shifts.length, 2);
    assert.equal(shifts[0]?.rotationName, "Primary Rotation");
    assert.equal(shifts[0]?.start, "2026-08-22T09:00:00Z");
    assert.equal(shifts[0]?.end, "2026-08-23T09:00:00Z");
  });

  it("prefers flattenedResponders, which expand a team into people", () => {
    const shifts = toShifts({
      finalTimeline: {
        rotations: [
          {
            id: "r",
            periods: [
              {
                startDate: "2026-08-22T09:00:00Z",
                responder: { id: "team-1", type: "team" },
                flattenedResponders: [{ id: "user-ada", type: "user" }],
              },
            ],
          },
        ],
      },
    });

    assert.deepEqual(shifts[0]?.responders, [{ id: "user-ada", type: "user" }]);
  });

  // Without flattenedResponders the single responder is all there is; dropping
  // it would report an empty shift for a rotation that is in fact covered.
  it("falls back to the single responder when nothing was flattened", () => {
    const shifts = toShifts({
      finalTimeline: {
        rotations: [
          {
            id: "r",
            periods: [
              { startDate: "2026-08-22T09:00:00Z", responder: { id: "team-1", type: "team" } },
            ],
          },
        ],
      },
    });

    assert.equal(shifts[0]?.responders[0]?.id, "team-1");
  });

  it("drops 'noone', which marks an unfilled slot rather than a person", () => {
    const shifts = toShifts({
      finalTimeline: {
        rotations: [
          {
            id: "r",
            periods: [{ startDate: "2026-08-22T09:00:00Z", responder: { id: "x", type: "noone" } }],
          },
        ],
      },
    });

    assert.deepEqual(shifts[0]?.responders, []);
  });

  it("skips deleted rotations, which linger in the timeline as history", () => {
    const shifts = toShifts({
      finalTimeline: {
        rotations: [
          {
            id: "r",
            deleted: true,
            periods: [{ startDate: "2026-08-22T09:00:00Z", responder: { id: "u", type: "user" } }],
          },
        ],
      },
    });

    assert.deepEqual(shifts, []);
  });

  it("returns nothing rather than throwing on an empty timeline", () => {
    assert.deepEqual(toShifts({}), []);
  });
});

describe("shiftsAt", () => {
  const shifts = toShifts(timeline);

  it("finds the shift covering an instant inside it", () => {
    const at = shiftsAt(shifts, new Date("2026-08-23T14:00:00Z"));

    assert.equal(at.length, 1);
    assert.equal(at[0]?.responders[0]?.id, "user-ada");
    assert.equal(at[0]?.end, "2026-08-24T09:00:00Z");
  });

  // The boundary is the question people actually ask ("when does it end?"), so
  // it has to land on exactly one side. A shift ends the instant the next begins.
  it("treats the handover instant as belonging to the incoming shift", () => {
    const at = shiftsAt(shifts, new Date("2026-08-23T09:00:00Z"));

    assert.equal(at.length, 1);
    assert.equal(at[0]?.responders[0]?.id, "user-ada");
  });

  it("returns nothing for an instant outside every period", () => {
    assert.deepEqual(shiftsAt(shifts, new Date("2026-09-01T00:00:00Z")), []);
  });
});

describe("shiftAfter", () => {
  const shifts = toShifts(timeline);

  // The old jsm_get_next_on_call could only answer "next from now". This is
  // what makes "who is on after Saket?" a single call from any reference point.
  it("finds the next shift relative to an arbitrary reference point", () => {
    const next = shiftAfter(shifts, new Date("2026-08-22T12:00:00Z"));

    assert.equal(next?.start, "2026-08-23T09:00:00Z");
    assert.equal(next?.responders[0]?.id, "user-ada");
  });

  it("does not count the shift already in progress as the next one", () => {
    const next = shiftAfter(shifts, new Date("2026-08-23T09:00:00Z"));
    assert.equal(next, undefined);
  });
});

describe("respondersOf", () => {
  it("deduplicates across shifts so one lookup covers the window", () => {
    const shifts = toShifts(timeline);
    const repeated = [...shifts, ...shifts];

    assert.deepEqual(
      respondersOf(repeated).map((r) => r.id),
      ["user-saket", "user-ada"],
    );
  });

  it("includes whoever a shift was forwarded from", () => {
    const shifts = toShifts({
      finalTimeline: {
        rotations: [
          {
            id: "r",
            periods: [
              {
                startDate: "2026-08-22T09:00:00Z",
                type: "forwarding",
                responder: { id: "user-ada", type: "user" },
                from: { id: "user-grace", type: "user" },
              },
            ],
          },
        ],
      },
    });

    assert.deepEqual(
      respondersOf(shifts).map((r) => r.id),
      ["user-ada", "user-grace"],
    );
  });
});
