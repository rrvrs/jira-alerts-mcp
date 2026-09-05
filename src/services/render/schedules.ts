/**
 * Renderers for the schedule configuration family.
 *
 * The first module of the render/ split. services/format.ts holds the shared
 * primitives — ok, fail, emptyResult, pagination — and grew per-entity
 * renderers alongside them until it was 600 lines for two domains. Ten more
 * families would not fit, so entity rendering moves out one domain at a time
 * and format.ts keeps what every domain uses.
 */

import type { Rotation, Schedule, ScheduleOverride } from "../../types.js";

/** A schedule on its own page, where the list renderer's one-liner is too thin. */
export function renderSchedule(schedule: Schedule, teams?: Map<string, string>): string {
  const team =
    schedule.ownerTeam?.name ??
    (schedule.teamId ? (teams?.get(schedule.teamId) ?? schedule.teamId) : undefined);

  const lines = [
    `# ${schedule.name}${schedule.enabled === false ? " _(disabled)_" : ""}`,
    "",
    `- **id**: \`${schedule.id}\``,
  ];
  if (team) lines.push(`- **team**: ${team}`);
  if (schedule.timezone) lines.push(`- **timezone**: ${schedule.timezone}`);
  if (schedule.description) lines.push(`- **description**: ${schedule.description}`);

  const rotations = (schedule.rotations ?? []) as Rotation[];
  if (rotations.length) {
    lines.push("", `## Rotations (${rotations.length})`, "", renderRotations(rotations));
  } else {
    // A schedule with no rotations pages nobody. That is a real configuration
    // state and worth saying out loud rather than rendering an empty heading.
    lines.push("", "_This schedule has no rotations, so nobody is ever on call for it._");
  }

  return lines.join("\n");
}

/** How long each shift lasts, in the rotation's own units. */
function shiftLength(rotation: Rotation): string | undefined {
  if (!rotation.type) return undefined;
  const unit = rotation.type === "hourly" ? "hour" : rotation.type === "daily" ? "day" : "week";
  const length = rotation.length ?? 1;
  return `${length} ${unit}${length === 1 ? "" : "s"}`;
}

export function renderRotations(rotations: Rotation[]): string {
  if (!rotations.length) return "No rotations found.";
  return rotations
    .map((rotation) => {
      const bits = [`**${rotation.name ?? "(unnamed rotation)"}**`];
      const length = shiftLength(rotation);
      if (length) bits.push(`  - shift: ${length} (${rotation.type})`);
      if (rotation.startDate) {
        // An endDate is the interesting half: a rotation with one stops paging
        // when it passes, which is a common way for a schedule to go quiet.
        bits.push(
          `  - runs: ${rotation.startDate}${rotation.endDate ? ` until ${rotation.endDate}` : " (no end date)"}`,
        );
      }
      const participants = rotation.participants ?? [];
      bits.push(
        participants.length
          ? `  - participants: ${participants.map((p) => `${p.id ?? "?"}${p.type ? ` (${p.type})` : ""}`).join(", ")}`
          : "  - participants: none — this rotation pages nobody",
      );
      if (rotation.timeRestriction) bits.push("  - has a time restriction");
      if (rotation.id) bits.push(`  - id: \`${rotation.id}\``);
      return bits.join("\n");
    })
    .join("\n");
}

export function renderRotation(rotation: Rotation): string {
  return [`# ${rotation.name ?? "(unnamed rotation)"}`, "", renderRotations([rotation])].join("\n");
}

export function renderOverrides(overrides: ScheduleOverride[]): string {
  if (!overrides.length) return "No overrides found.";
  return overrides
    .map((override) => {
      const responder = override.responder;
      // type "noone" is a real value and means the opposite of a cover: it
      // deliberately leaves the shift unstaffed.
      const who =
        responder?.type === "noone"
          ? "**nobody** (shift deliberately left unstaffed)"
          : (responder?.id ?? "unknown responder");
      const bits = [
        `**${override.alias ?? "(no alias)"}** — ${who}`,
        `  - covers: ${override.startDate ?? "?"} to ${override.endDate ?? "?"}`,
      ];
      bits.push(
        override.rotationIds?.length
          ? `  - rotations: ${override.rotationIds.join(", ")}`
          : "  - rotations: all in this schedule",
      );
      return bits.join("\n");
    })
    .join("\n");
}

export function renderOverride(override: ScheduleOverride): string {
  return [`# Override \`${override.alias ?? "(no alias)"}\``, "", renderOverrides([override])].join(
    "\n",
  );
}
