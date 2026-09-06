/** Renderers for maintenance windows and heartbeats. */

import type { Heartbeat, Maintenance } from "../../types.js";

/** The window, wherever the API happened to put it. */
function window(maintenance: Maintenance): string {
  const start = maintenance.startDate ?? maintenance.time?.startDate;
  const end = maintenance.endDate ?? maintenance.time?.endDate;
  return start || end ? `${start ?? "?"} to ${end ?? "?"}` : "no window recorded";
}

export function renderMaintenances(items: Maintenance[]): string {
  if (!items.length) return "No maintenance windows found.";
  return items
    .map((m) => {
      const bits = [
        `**${m.description ?? "(no description)"}**${m.status ? ` — ${m.status}` : ""}`,
      ];
      bits.push(`  - window: ${window(m)}`);
      const rules = m.rules ?? [];
      // A window with no rules suppresses nothing, which is the state that
      // makes someone believe alerting is paused when it is not.
      bits.push(
        rules.length
          ? `  - silences: ${rules.map((r) => `${r.entity?.type ?? "?"} ${r.entity?.id ?? "?"} (${r.state ?? "?"})`).join(", ")}`
          : "  - silences nothing — this window has no rules",
      );
      if (m.id) bits.push(`  - id: \`${m.id}\``);
      return bits.join("\n");
    })
    .join("\n");
}

export function renderMaintenance(item: Maintenance): string {
  return [
    `# Maintenance ${item.id ? `\`${item.id}\`` : ""}`.trim(),
    "",
    renderMaintenances([item]),
  ].join("\n");
}

export function renderHeartbeats(beats: Heartbeat[]): string {
  if (!beats.length) return "No heartbeats found.";
  return beats
    .map((b) => {
      const bits = [`**${b.name ?? "(unnamed)"}**${b.status ? ` — ${b.status}` : ""}`];
      if (b.interval) bits.push(`  - expects a ping every ${b.interval} ${b.intervalUnit ?? ""}`);
      // "Unresponsive" means the alert has already fired; "Off" means the
      // switch is not armed at all. Both look like a status field and mean
      // very different things.
      if (b.status === "Unresponsive") {
        bits.push("  - **no ping arrived in time — this heartbeat has already alerted**");
      }
      if (b.enabled === false || b.status === "Off") {
        bits.push("  - **disabled — a missed ping raises nothing**");
      }
      if (b.alertPriority) bits.push(`  - alerts at ${b.alertPriority}`);
      if (b.description) bits.push(`  - ${b.description}`);
      return bits.join("\n");
    })
    .join("\n");
}

export function renderHeartbeat(beat: Heartbeat): string {
  return [`# Heartbeat ${beat.name ?? ""}`.trim(), "", renderHeartbeats([beat])].join("\n");
}
