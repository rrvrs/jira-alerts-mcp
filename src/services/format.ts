/**
 * Shared response shaping: markdown rendering, truncation, and the
 * text+structuredContent envelope every tool returns.
 */

import { CHARACTER_LIMIT } from "../constants.js";
import { ResponseFormat } from "../schemas/common.js";
import type {
  Alert,
  AlertLog,
  AlertNote,
  AsyncActionResponse,
  OnCallData,
  OnCallParticipant,
  PaginationMeta,
  Schedule,
} from "../types.js";

/**
 * NOTE: a type alias, not an interface. The SDK's CallToolResult carries an
 * index signature, and TypeScript only grants an implicit one to type
 * aliases — declaring this as an interface makes every registerTool callback
 * fail to typecheck.
 */
export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/** Success envelope: text for the model to read, structured data for the client. */
export function ok(
  text: string,
  structured?: Record<string, unknown>,
): ToolResult {
  return {
    content: [{ type: "text", text }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

/** Error envelope. Reported in-result (not as a protocol error) per MCP guidance. */
export function fail(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Guards against dumping a huge payload into the context window. Trims the
 * item list in half until it fits, and says how to get the rest.
 */
export function withCharacterLimit<T>(
  items: T[],
  render: (items: T[]) => string,
  hint: string,
): { text: string; truncated: boolean; kept: number } {
  let kept = items.length;
  let text = render(items);

  while (text.length > CHARACTER_LIMIT && kept > 1) {
    kept = Math.floor(kept / 2);
    text = render(items.slice(0, kept));
  }

  if (kept < items.length) {
    text +=
      `\n\n_Truncated: showing ${kept} of ${items.length} records to stay within the response size limit. ${hint}_`;
    return { text, truncated: true, kept };
  }

  return { text, truncated: false, kept };
}

export interface PaginationInput {
  /** Records actually included in the response, after any truncation. */
  returned: number;
  /** Records the API returned for this page, before truncation. */
  fetched: number;
  limit: number;
  offset?: number;
  totalCount?: number;
  nextCursor?: string;
}

/**
 * Builds the standard pagination block returned by every list tool.
 *
 * Takes `returned` and `fetched` separately on purpose. Reporting the fetched
 * count while shipping the truncated list would make `next_offset` skip past
 * every record that truncation dropped, losing them silently — so `count` and
 * `next_offset` are both derived from what the caller actually received.
 */
export function buildPagination({
  returned,
  fetched,
  limit,
  offset,
  totalCount,
  nextCursor,
}: PaginationInput): PaginationMeta {
  const truncated = returned < fetched;
  // A full page means the API probably has more. So does a truncated one — by
  // definition we are holding back records the API already handed us.
  const hasMore = nextCursor ? true : truncated || fetched === limit;

  return {
    count: returned,
    ...(offset !== undefined ? { offset } : {}),
    has_more: hasMore,
    ...(hasMore && offset !== undefined ? { next_offset: offset + returned } : {}),
    ...(nextCursor ? { next_cursor: nextCursor } : {}),
    ...(truncated ? { truncated: true } : {}),
    ...(totalCount !== undefined ? { total: totalCount } : {}),
  };
}

/**
 * Result envelope for a list tool that found nothing.
 *
 * Exists because `ok(text)` alone is a trap: every list tool declares an
 * outputSchema, and the SDK rejects a non-error result that carries no
 * structuredContent. An empty page is an ordinary answer, not an error, so it
 * has to ship a valid — but empty — structured payload.
 */
export function emptyResult(
  text: string,
  key: string,
  limit: number,
  offset?: number,
): ToolResult {
  return ok(text, {
    [key]: [],
    pagination: buildPagination({ returned: 0, fetched: 0, limit, offset }),
  });
}

function timestamp(value?: string): string {
  if (!value) return "unknown";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString().replace("T", " ").replace(".000Z", "Z");
}

function alertStateLabel(alert: Alert): string {
  if (alert.status === "closed") return "closed";
  if (alert.snoozed) return `open, snoozed until ${timestamp(alert.snoozedUntil)}`;
  return alert.acknowledged ? "open, acked" : "open, UNACKED";
}

/** One-line summary used in list views. */
export function renderAlertLine(alert: Alert): string {
  const parts = [
    `**#${alert.tinyId ?? "?"}** ${alert.message}`,
    `  - state: ${alertStateLabel(alert)}${alert.priority ? ` | priority: ${alert.priority}` : ""}${
      alert.count && alert.count > 1 ? ` | count: ${alert.count}` : ""
    }`,
    `  - created: ${timestamp(alert.createdAt)}${
      alert.lastOccurredAt && alert.lastOccurredAt !== alert.createdAt
        ? ` | last seen: ${timestamp(alert.lastOccurredAt)}`
        : ""
    }`,
  ];
  if (alert.owner) parts.push(`  - owner: ${alert.owner}`);
  if (alert.tags?.length) parts.push(`  - tags: ${alert.tags.join(", ")}`);
  parts.push(`  - id: \`${alert.id}\``);
  return parts.join("\n");
}

/** Full detail view used by jsm_get_alert. */
export function renderAlertDetail(alert: Alert): string {
  const lines = [
    `# Alert #${alert.tinyId ?? "?"}: ${alert.message}`,
    "",
    `- **State**: ${alertStateLabel(alert)}`,
    `- **Priority**: ${alert.priority ?? "not set"}`,
    `- **Created**: ${timestamp(alert.createdAt)}`,
    `- **Updated**: ${timestamp(alert.updatedAt)}`,
  ];

  if (alert.lastOccurredAt) lines.push(`- **Last occurred**: ${timestamp(alert.lastOccurredAt)}`);
  if (alert.count !== undefined) lines.push(`- **Deduplicated count**: ${alert.count}`);
  if (alert.source) lines.push(`- **Source**: ${alert.source}`);
  if (alert.owner) lines.push(`- **Owner**: ${alert.owner}`);
  if (alert.alias) lines.push(`- **Alias**: \`${alert.alias}\``);
  if (alert.entity) lines.push(`- **Entity**: ${alert.entity}`);
  if (alert.integration?.name)
    lines.push(`- **Integration**: ${alert.integration.name}${alert.integration.type ? ` (${alert.integration.type})` : ""}`);
  if (alert.tags?.length) lines.push(`- **Tags**: ${alert.tags.join(", ")}`);

  const responders = [...(alert.responders ?? []), ...(alert.teams ?? [])]
    .map((r) => r.name ?? r.username ?? r.id)
    .filter(Boolean);
  if (responders.length) lines.push(`- **Responders**: ${responders.join(", ")}`);

  if (alert.report?.acknowledgedBy)
    lines.push(`- **Acknowledged by**: ${alert.report.acknowledgedBy}`);
  if (alert.report?.closedBy) lines.push(`- **Closed by**: ${alert.report.closedBy}`);

  lines.push(`- **Id**: \`${alert.id}\``);

  if (alert.description) {
    lines.push("", "## Description", "", alert.description);
  }

  const details = { ...(alert.details ?? {}), ...(alert.extraProperties ?? {}) };
  const detailKeys = Object.keys(details);
  if (detailKeys.length) {
    lines.push("", "## Details", "");
    for (const key of detailKeys) lines.push(`- **${key}**: ${details[key]}`);
  }

  return lines.join("\n");
}

export function renderNotes(notes: AlertNote[]): string {
  if (!notes.length) return "No notes on this alert.";
  return notes
    .map((n) => `- **${timestamp(n.createdAt)}** — ${n.owner ?? "unknown"}\n  ${n.note.replace(/\n/g, "\n  ")}`)
    .join("\n");
}

export function renderLogs(logs: AlertLog[]): string {
  if (!logs.length) return "No activity logs on this alert.";
  return logs
    .map((l) => `- **${timestamp(l.createdAt)}** — ${l.owner ?? "system"}: ${l.log}`)
    .join("\n");
}

export function renderSchedules(schedules: Schedule[]): string {
  if (!schedules.length) return "No schedules found.";
  return schedules
    .map((s) => {
      const bits = [`**${s.name}**${s.enabled === false ? " _(disabled)_" : ""}`];
      if (s.ownerTeam?.name) bits.push(`  - team: ${s.ownerTeam.name}`);
      if (s.timezone) bits.push(`  - timezone: ${s.timezone}`);
      if (s.description) bits.push(`  - ${s.description}`);
      bits.push(`  - id: \`${s.id}\``);
      return bits.join("\n");
    })
    .join("\n");
}

function flattenParticipants(participants: OnCallParticipant[]): string[] {
  const names: string[] = [];
  for (const p of participants) {
    const label = p.name ?? p.id;
    if (label && p.type !== "none") names.push(p.type ? `${label} (${p.type})` : label);
    if (p.onCallParticipants?.length) names.push(...flattenParticipants(p.onCallParticipants));
    if (p.forwardedFrom?.user) {
      const from = p.forwardedFrom.user.name ?? p.forwardedFrom.user.id;
      if (from) names.push(`${from} (forwarded)`);
    }
  }
  return names;
}

export function renderOnCall(data: OnCallData, next: boolean): string {
  const scheduleName = data._parent?.name ?? "schedule";
  const recipients = next ? data.nextOnCallRecipients : data.onCallRecipients;
  const participants = next ? data.nextOnCallParticipants : data.onCallParticipants;

  const names = recipients?.length
    ? recipients
    : flattenParticipants(participants ?? []);

  const heading = next
    ? `# Next on-call for ${scheduleName}`
    : `# Currently on-call for ${scheduleName}`;

  const lines = [heading, ""];
  if (!names.length) {
    lines.push("_Nobody is on-call for this schedule at the requested time._");
    return lines.join("\n");
  }

  for (const name of names) lines.push(`- ${name}`);
  if (next && data.exactNextOnCallTime)
    lines.push("", `Shift starts: ${timestamp(data.exactNextOnCallTime)}`);
  return lines.join("\n");
}

/**
 * Mutating endpoints return an async receipt rather than the updated alert.
 * Every write tool renders it the same way so the agent learns the pattern.
 */
export function renderAsyncReceipt(
  action: string,
  alertId: string,
  response: AsyncActionResponse,
): string {
  return [
    `${action} request accepted for alert \`${alertId}\`.`,
    "",
    `- **Request id**: \`${response.requestId ?? "not returned"}\``,
    `- **Result**: ${response.result ?? "queued"}`,
    "",
    "JSM applies alert actions asynchronously, so the alert may not reflect this change immediately. " +
      "Confirm with jsm_get_request_status using the request id above, or re-read the alert after a moment.",
  ].join("\n");
}

export function renderFormat(
  format: ResponseFormat,
  markdown: string,
  structured: Record<string, unknown>,
): ToolResult {
  const text =
    format === ResponseFormat.JSON ? JSON.stringify(structured, null, 2) : markdown;
  return ok(text, structured);
}
