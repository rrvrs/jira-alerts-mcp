/** Renderer for alert and notification policies. */

import type { Policy } from "../../types.js";

export function renderPolicies(items: Policy[]): string {
  if (!items.length) return "No policies found.";
  return items
    .map((p) => {
      const bits = [
        `**${p.name ?? "(unnamed)"}**${p.order !== undefined ? ` — #${p.order}` : ""}` +
          (p.enabled === false ? " _(disabled)_" : ""),
      ];
      if (p.type) bits.push(`  - type: ${p.type}`);
      // A notification policy that suppresses is the quietest possible
      // configuration: matching alerts notify nobody at all.
      if (p.suppress) bits.push("  - **suppresses notifications — matching alerts page nobody**");
      if (p.updatePriority && p.priorityValue) {
        bits.push(`  - rewrites priority to ${p.priorityValue}`);
      }
      if (p.message) bits.push(`  - rewrites message to: ${p.message}`);
      if (!p.filter || Object.keys(p.filter).length === 0) {
        // No filter means every alert matches, which is rarely intended
        // anywhere but the bottom of the list.
        bits.push("  - **no filter — this policy matches every alert**");
      }
      if (p.description) bits.push(`  - ${p.description}`);
      if (p.id) bits.push(`  - id: \`${p.id}\``);
      return bits.join("\n");
    })
    .join("\n");
}

export function renderPolicy(item: Policy): string {
  return [`# ${item.name ?? "Policy"}`, "", renderPolicies([item])].join("\n");
}
