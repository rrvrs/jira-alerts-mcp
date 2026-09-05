/** Renderers for the routing family: escalations, routing, forwarding, notification rules. */

import type {
  Escalation,
  ForwardingRule,
  NotificationRule,
  NotificationRuleStep,
  RoutingRule,
} from "../../types.js";

export function renderEscalations(items: Escalation[]): string {
  if (!items.length) return "No escalations found.";
  return items
    .map((e) => {
      const bits = [`**${e.name ?? "(unnamed)"}**${e.enabled === false ? " _(disabled)_" : ""}`];
      const rules = e.rules ?? [];
      if (!rules.length) {
        // An escalation with no rules escalates to nobody, which is the
        // failure this whole family exists to prevent.
        bits.push("  - **no rules — this escalation notifies nobody**");
      }
      for (const rule of rules) {
        bits.push(
          `  - after ${rule.delay ?? 0} min, ${rule.condition ?? "?"}: notify ` +
            `${rule.recipient?.type ?? "?"} ${rule.recipient?.id ?? "?"} (${rule.notifyType ?? "default"})`,
        );
      }
      if (e.description) bits.push(`  - ${e.description}`);
      if (e.id) bits.push(`  - id: \`${e.id}\``);
      return bits.join("\n");
    })
    .join("\n");
}

export function renderEscalation(item: Escalation): string {
  return [`# ${item.name ?? "Escalation"}`, "", renderEscalations([item])].join("\n");
}

export function renderRoutingRules(items: RoutingRule[]): string {
  if (!items.length) return "No routing rules found.";
  return items
    .map((r) => {
      const bits = [`**${r.name ?? "(unnamed)"}**${r.order !== undefined ? ` — #${r.order}` : ""}`];
      // type "none" is a real value: the rule matches and then routes nowhere,
      // which is how alerts get silently dropped by configuration.
      bits.push(
        r.notify?.type === "none"
          ? "  - notifies: **nobody** — matching alerts are routed nowhere"
          : `  - notifies: ${r.notify?.type ?? "?"} ${r.notify?.id ?? "?"}`,
      );
      if (r.criteria) bits.push("  - has match criteria");
      if (r.timezone) bits.push(`  - timezone: ${r.timezone}`);
      if (r.id) bits.push(`  - id: \`${r.id}\``);
      return bits.join("\n");
    })
    .join("\n");
}

export function renderRoutingRule(item: RoutingRule): string {
  return [`# ${item.name ?? "Routing rule"}`, "", renderRoutingRules([item])].join("\n");
}

export function renderForwardingRules(items: ForwardingRule[]): string {
  if (!items.length) return "No forwarding rules found.";
  return items
    .map((f) => {
      const from = f.fromUser?.username ?? f.fromUser?.id ?? f.fromUserId ?? "?";
      const to = f.toUser?.username ?? f.toUser?.id ?? f.toUserId ?? "?";
      return [
        `**${from}** → **${to}**`,
        `  - ${f.startDate ?? "?"} to ${f.endDate ?? "?"}`,
        `  - id: \`${f.id ?? "?"}\``,
      ].join("\n");
    })
    .join("\n");
}

export function renderForwardingRule(item: ForwardingRule): string {
  return [`# Forwarding rule \`${item.id ?? "?"}\``, "", renderForwardingRules([item])].join("\n");
}

export function renderNotificationRules(items: NotificationRule[]): string {
  if (!items.length) return "No notification rules found.";
  return items
    .map((n) => {
      const bits = [
        `**${n.name ?? "(unnamed)"}**${n.enabled === false ? " _(disabled — this rule notifies nobody)_" : ""}`,
      ];
      if (n.actionType) bits.push(`  - fires on: ${n.actionType}`);
      if (n.steps?.length) bits.push(`  - ${n.steps.length} step(s)`);
      if (n.id) bits.push(`  - id: \`${n.id}\``);
      return bits.join("\n");
    })
    .join("\n");
}

export function renderNotificationRule(item: NotificationRule): string {
  return [`# ${item.name ?? "Notification rule"}`, "", renderNotificationRules([item])].join("\n");
}

export function renderNotificationSteps(steps: NotificationRuleStep[]): string {
  if (!steps.length) return "No steps found.";
  return steps
    .map((s) =>
      [
        `**after ${s.sendAfter ?? 0} min** — ${s.contact?.method ?? "?"} to ${s.contact?.to ?? "?"}` +
          (s.enabled === false ? " _(disabled — this step sends nothing)_" : ""),
        `  - id: \`${s.id ?? "?"}\``,
      ].join("\n"),
    )
    .join("\n");
}

export function renderNotificationStep(step: NotificationRuleStep): string {
  return [`# Notification step \`${step.id ?? "?"}\``, "", renderNotificationSteps([step])].join(
    "\n",
  );
}
