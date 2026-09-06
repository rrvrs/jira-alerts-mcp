/**
 * Shared response shaping: markdown rendering, truncation, and the
 * text+structuredContent envelope every tool returns.
 */

import { CHARACTER_LIMIT } from "../constants.js";
import { type Directory, renderIdentity } from "./directory.js";
import { ResponseFormat } from "../schemas/common.js";
import type {
  Alert,
  AlertAttachment,
  AlertLog,
  AlertNote,
  AsyncActionResponse,
  OnCallData,
  OnCallParticipant,
  PaginationMeta,
  ResolvedIdentity,
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
export function ok(text: string, structured?: Record<string, unknown>): ToolResult {
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
    text += `\n\n_Truncated: showing ${kept} of ${items.length} records to stay within the response size limit. ${hint}_`;
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
  // Present-and-undefined: callers spread a whole pagination object in, keys
  // included, whether or not the API returned a value for them.
  offset?: number | undefined;
  totalCount?: number | undefined;
  nextCursor?: string | undefined;
  /**
   * The `links.next` the API returned for this page, if any. Authoritative:
   * the API knows whether more records exist and we do not.
   */
  nextLink?: string | undefined;
  /**
   * True when the endpoint accepts no paging parameters, so there is no later
   * page to fetch however full this one looks.
   */
  unpaged?: boolean | undefined;
}

/**
 * Pulls one query parameter out of an API `links.next` value.
 *
 * The API returns a whole relative URL there — "/v1/alerts/{id}/notes?after=149…"
 * — not a bare cursor. Handing that straight back as `next_cursor` invites the
 * caller to send the entire URL as their `after` parameter, so extract the part
 * that is actually re-sendable.
 */
export function extractLinkParam(link: string | undefined, name: string): string | undefined {
  if (!link) return undefined;
  try {
    // Base is irrelevant and never used; it only makes a relative URL parseable.
    return new URL(link, "https://api.atlassian.com").searchParams.get(name) ?? undefined;
  } catch {
    return undefined;
  }
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
  nextLink,
  unpaged,
}: PaginationInput): PaginationMeta {
  const truncated = returned < fetched;

  // Prefer what the API said. The `fetched === limit` heuristic below is only
  // sound when the API honoured the page size we asked for, and it silently
  // did not for a long time: the page-size parameter is `size`, we were sending
  // `limit`, so a capped 20-record page never equalled a requested 100 and
  // every full page reported has_more: false. A caller that trusted that
  // stopped paging while records remained.
  // An endpoint that takes no paging parameters returns its whole collection,
  // so a full-looking page means nothing. Left to the heuristic below, one that
  // happens to hold exactly `limit` records would advertise a next page forever.
  const hasMore = unpaged
    ? truncated
    : nextCursor || nextLink
      ? true
      : truncated || (fetched > 0 && fetched >= limit);

  return {
    count: returned,
    ...(offset !== undefined ? { offset } : {}),
    has_more: hasMore,
    // Never on an unpaged endpoint, even if the caller handed us an offset:
    // it has no way to serve a later page, so the next_offset would point back
    // at the same first records and a caller following it would loop forever.
    ...(hasMore && offset !== undefined && !unpaged ? { next_offset: offset + returned } : {}),
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
export function emptyResult(text: string, key: string, limit: number, offset?: number): ToolResult {
  return ok(text, {
    [key]: [],
    pagination: buildPagination({ returned: 0, fetched: 0, limit, offset }),
  });
}

/**
 * Result envelope for a write that removed something and got 204 back.
 *
 * Exists for the same reason emptyResult does: the tool declares an
 * outputSchema, so `ok(text)` with no structuredContent is rejected outright by
 * the SDK. A body-less success still has to ship a structured payload.
 */
export function renderDeleted(
  label: string,
  subject?: { key: string; value?: string | undefined; noun: string },
): ToolResult {
  const target = subject?.value ? ` for ${subject.noun} \`${subject.value}\`` : "";
  return ok(`${label} succeeded${target}. The API confirmed it with no response body.`, {
    deleted: true,
    ...(subject?.value !== undefined ? { [subject.key]: subject.value } : {}),
  });
}

/**
 * Confirms a 204 that changed something without removing it.
 *
 * Deliberately not renderDeleted with a different word: the structured payload
 * carries `confirmed`, not `deleted`, because a model reading `deleted: true`
 * after a reorder will say the thing was deleted.
 */
export function renderConfirmed(
  label: string,
  subject?: { key: string; value?: string | undefined; noun: string },
): ToolResult {
  const target = subject?.value ? ` for ${subject.noun} \`${subject.value}\`` : "";
  return ok(`${label} succeeded${target}. The API confirmed it with no response body.`, {
    confirmed: true,
    ...(subject?.value !== undefined ? { [subject.key]: subject.value } : {}),
  });
}

function timestamp(value?: string): string {
  if (!value) return "unknown";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toISOString().replace("T", " ").replace(".000Z", "Z");
}

/** The API spells this with one "r"; Opsgenie used two. Accept either. */
function lastOccurred(alert: Alert): string | undefined {
  return alert.lastOccurredAt ?? alert.lastOccuredAt;
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
      lastOccurred(alert) && lastOccurred(alert) !== alert.createdAt
        ? ` | last seen: ${timestamp(lastOccurred(alert))}`
        : ""
    }`,
  ];
  if (alert.owner) parts.push(`  - owner: ${alert.owner}`);
  if (alert.tags?.length) parts.push(`  - tags: ${alert.tags.join(", ")}`);
  parts.push(`  - id: \`${alert.id}\``);
  return parts.join("\n");
}

/** Full detail view used by jsm_get_alert. */
export function renderAlertDetail(alert: Alert, directory?: Directory): string {
  const lines = [
    `# Alert #${alert.tinyId ?? "?"}: ${alert.message}`,
    "",
    `- **State**: ${alertStateLabel(alert)}`,
    `- **Priority**: ${alert.priority ?? "not set"}`,
    `- **Created**: ${timestamp(alert.createdAt)}`,
    `- **Updated**: ${timestamp(alert.updatedAt)}`,
  ];

  if (lastOccurred(alert)) lines.push(`- **Last occurred**: ${timestamp(lastOccurred(alert))}`);
  if (alert.count !== undefined) lines.push(`- **Deduplicated count**: ${alert.count}`);
  if (alert.source) lines.push(`- **Source**: ${alert.source}`);
  if (alert.owner) lines.push(`- **Owner**: ${alert.owner}`);
  if (alert.alias) lines.push(`- **Alias**: \`${alert.alias}\``);
  if (alert.entity) lines.push(`- **Entity**: ${alert.entity}`);
  // JSM Operations returns these flat; Opsgenie nested them under `integration`.
  const integrationName = alert.integration?.name ?? alert.integrationName;
  const integrationType = alert.integration?.type ?? alert.integrationType;
  if (integrationName)
    lines.push(
      `- **Integration**: ${integrationName}${integrationType ? ` (${integrationType})` : ""}`,
    );
  if (alert.tags?.length) lines.push(`- **Tags**: ${alert.tags.join(", ")}`);

  // Alert responders arrive as {id, type} with no name, exactly like on-call
  // participants — so they go through the same resolution.
  const responders = [...(alert.responders ?? []), ...(alert.teams ?? [])]
    .filter((r) => r.id ?? r.name ?? r.username)
    .map((r) => {
      const resolved = r.id ? directory?.names.get(r.id) : undefined;
      const fallbackName = r.name ?? r.username;
      return renderIdentity({
        id: r.id ?? fallbackName ?? "unknown",
        ...(r.type ? { type: r.type } : {}),
        ...(fallbackName ? { displayName: fallbackName } : {}),
        ...resolved,
      });
    });
  if (responders.length) lines.push(`- **Responders**: ${responders.join(", ")}`);

  if (alert.report?.acknowledgedBy)
    lines.push(`- **Acknowledged by**: ${alert.report.acknowledgedBy}`);
  if (alert.report?.closedBy) lines.push(`- **Closed by**: ${alert.report.closedBy}`);
  // The API reports the times without the actor, at the top level.
  if (alert.ackTime) lines.push(`- **Acknowledged at**: ${timestamp(alert.ackTime)}`);
  if (alert.closeTime) lines.push(`- **Closed at**: ${timestamp(alert.closeTime)}`);

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
    .map(
      (n) =>
        `- **${timestamp(n.createdAt)}** — ${n.owner ?? "unknown"}\n  ${n.note.replace(/\n/g, "\n  ")}`,
    )
    .join("\n");
}

/** Single-note view, used after an edit so the caller sees what the note now says. */
export function renderNote(note: AlertNote): string {
  return [
    `Note \`${note.id ?? note.offset ?? "unknown"}\` on the alert now reads:`,
    "",
    note.note,
    "",
    `- **Author**: ${note.owner ?? "unknown"}`,
    `- **Created**: ${timestamp(note.createdAt)}`,
    ...(note.updatedAt ? [`- **Updated**: ${timestamp(note.updatedAt)}`] : []),
  ].join("\n");
}

export function renderAttachments(attachments: AlertAttachment[]): string {
  if (!attachments.length) return "No attachments on this alert.";
  return attachments
    .map(
      (attachment) =>
        `- **${attachment.attachmentName ?? "unnamed"}** — added ${timestamp(attachment.insertedAt)}\n` +
        `  - id: \`${attachment.id ?? "unknown"}\``,
    )
    .join("\n");
}

export function renderLogs(logs: AlertLog[]): string {
  if (!logs.length) return "No activity logs on this alert.";
  // logTime is the field the API actually sends; reading only createdAt
  // rendered every line as "unknown".
  return logs
    .map((l) => `- **${timestamp(l.logTime ?? l.createdAt)}** — ${l.owner ?? "system"}: ${l.log}`)
    .join("\n");
}

export function renderSchedules(schedules: Schedule[], teams?: Map<string, string>): string {
  if (!schedules.length) return "No schedules found.";
  return schedules
    .map((s) => {
      const bits = [`**${s.name}**${s.enabled === false ? " _(disabled)_" : ""}`];
      // The API returns a bare teamId, not an ownerTeam object, so the team
      // never rendered at all until it was resolved through /v1/teams.
      const team = s.ownerTeam?.name ?? (s.teamId ? (teams?.get(s.teamId) ?? s.teamId) : undefined);
      if (team) bits.push(`  - team: ${team}`);
      if (s.timezone) bits.push(`  - timezone: ${s.timezone}`);
      if (s.description) bits.push(`  - ${s.description}`);
      bits.push(`  - id: \`${s.id}\``);
      return bits.join("\n");
    })
    .join("\n");
}

/**
 * The spec types `forwardedFrom` as a participant; Opsgenie wrapped it in
 * `{ user: … }`. Accept either rather than silently dropping the forward.
 */
function unwrapForward(
  forwardedFrom: OnCallParticipant | undefined,
): OnCallParticipant | undefined {
  const legacy = (forwardedFrom as { user?: OnCallParticipant } | undefined)?.user;
  return legacy ?? forwardedFrom;
}

/**
 * Walks the nested participant tree into a flat list of {id, type}.
 *
 * `noone` is the API's sentinel for an unfilled slot in a rotation — it is a
 * real enum value, not a responder, and rendering it would put a uuid where a
 * person should be.
 */
export function flattenParticipants(participants: OnCallParticipant[]): Responder[] {
  const out: Responder[] = [];

  for (const p of participants) {
    if (p.id && p.type !== "noone" && p.type !== "none") {
      out.push({
        id: p.id,
        ...(p.type ? { type: p.type } : {}),
        ...(p.name ? { name: p.name } : {}),
      });
    }

    // next-on-calls nests its children under a different key than on-calls.
    const children = p.onCallParticipants ?? p.nextOnCallParticipants;
    if (children?.length) out.push(...flattenParticipants(children));

    const forwarded = unwrapForward(p.forwardedFrom);
    if (forwarded?.id) {
      out.push({
        id: forwarded.id,
        type: forwarded.type ?? "user",
        forwarded: true,
        ...(forwarded.name ? { name: forwarded.name } : {}),
      });
    }
  }

  return out;
}

/**
 * Pulls the responders out of an on-call response, whichever shape it arrived in.
 *
 * `flat=true` returns bare ids under `onCallUsers`/`nextOnCallUsers`;
 * `flat=false` returns the participant tree. The `*Recipients` fallbacks are
 * the Opsgenie names — reading ONLY those is what made this tool report
 * "Nobody is on-call" for a schedule that had someone on it, so the documented
 * name is read first and the legacy one is a fallback, never the reverse.
 */
export function extractOnCall(data: OnCallData, next: boolean): Responder[] {
  const users = next
    ? (data.nextOnCallUsers ?? data.nextOnCallRecipients)
    : (data.onCallUsers ?? data.onCallRecipients);

  if (users?.length) return users.map((id) => ({ id, type: "user" }));

  const participants = next
    ? (data.nextOnCallParticipants ?? data.onCallParticipants)
    : data.onCallParticipants;

  return dedupe(flattenParticipants(participants ?? []));
}

/**
 * Collapses repeated ids, keeping the first mention.
 *
 * One person routinely appears twice in an unflattened tree — once directly and
 * again inside an escalation that expands to them. Listing them twice reads as
 * two responders, which is the wrong answer to "how many people are on call".
 */
function dedupe(responders: Responder[]): Responder[] {
  const seen = new Map<string, Responder>();
  for (const responder of responders) {
    if (!seen.has(responder.id)) seen.set(responder.id, responder);
  }
  return [...seen.values()];
}

/**
 * One responder as the API described it, before any directory lookup.
 *
 * `name` is only ever populated by a legacy Opsgenie-shaped response; JSM
 * Operations sends ids alone, which is why resolution exists.
 */
export interface Responder {
  id: string;
  type?: string;
  name?: string;
  /**
   * Set when this person is listed because they forwarded their shift. Kept
   * separate from `type` so the responder is still a *user* for lookup
   * purposes — overloading `type` with "forwarded" meant the forwarding
   * person was the one name on the page that never got resolved.
   */
  forwarded?: boolean;
}

/**
 * Merges what the API said about a responder with what the directory lookup
 * found, so the markdown and the structured payload cannot disagree.
 *
 * A name the API itself supplied is used when the lookup found nothing —
 * dropping it would be a regression for any tenant still on the legacy shape.
 */
export function identifyResponders(
  responders: Responder[],
  directory?: Directory,
): ResolvedIdentity[] {
  return responders.map((responder) => {
    const resolved = directory?.names.get(responder.id);
    const forwarded = responder.forwarded ? { forwarded: true } : {};

    if (resolved) {
      return { ...resolved, ...(responder.type ? { type: responder.type } : {}), ...forwarded };
    }

    return {
      id: responder.id,
      ...(responder.type ? { type: responder.type } : {}),
      ...(responder.name ? { displayName: responder.name } : {}),
      ...forwarded,
    };
  });
}

export interface OnCallRenderOptions {
  /** What to call the schedule in the heading. The API returns no name here. */
  scheduleLabel: string;
  /** Resolved responder names, where the directory lookup found any. */
  directory?: Directory;
  /**
   * The shift these responders are covering. Its absence is why the on-call
   * tools could not answer "when does this end?" before.
   */
  shift?: ShiftSummary;
  /** Anything the reader needs to know about what could not be determined. */
  notes?: string[];
  /** Opsgenie's `exactNextOnCallTime`, when a tenant still sends it. */
  legacyShiftStart?: string | undefined;
}

/** The boundary information a shift contributes to an answer. */
export interface ShiftSummary {
  start?: string;
  end?: string;
  rotationName?: string;
  type?: string;
  forwardedFrom?: { id?: string };
}

/**
 * Renders a shift's boundaries.
 *
 * Both ends are stated explicitly rather than as a duration: "until 09:00 UTC
 * tomorrow" is what a handover message needs, and a relative figure goes stale
 * the moment it is written down.
 */
export function renderShift(shift: ShiftSummary, next: boolean): string[] {
  const lines: string[] = [];
  const rotation = shift.rotationName ? ` (${shift.rotationName})` : "";

  if (shift.start && shift.end) {
    lines.push(
      `${next ? "Shift" : "Current shift"}: ${timestamp(shift.start)} → ${timestamp(shift.end)}${rotation}`,
    );
  } else if (shift.start) {
    lines.push(`Shift starts: ${timestamp(shift.start)}${rotation}`);
  } else if (shift.end) {
    lines.push(`Shift ends: ${timestamp(shift.end)}${rotation}`);
  }

  // An override or a forward explains why the person on-call is not who the
  // base rotation would suggest — worth surfacing rather than burying.
  if (shift.type === "override") lines.push("This period is an override.");
  if (shift.type === "forwarding") lines.push("This period is forwarded.");

  return lines;
}

/**
 * Renders an on-call answer.
 *
 * Takes the responders rather than the raw payload on purpose: they may have
 * come from the timeline rather than the on-call endpoint, and re-deriving them
 * here from a payload the caller might not have used would quietly disagree
 * with the structured output sitting beside it.
 */
export function renderOnCall(
  responders: Responder[],
  next: boolean,
  options: OnCallRenderOptions,
): string {
  const heading = next
    ? `# Next on-call for ${options.scheduleLabel}`
    : `# Currently on-call for ${options.scheduleLabel}`;

  const lines = [heading, ""];

  if (!responders.length) {
    lines.push("_Nobody is on-call for this schedule at the requested time._");
    return lines.join("\n");
  }

  for (const identity of identifyResponders(responders, options.directory)) {
    lines.push(`- ${renderIdentity(identity)}`);
  }

  if (options.shift) {
    const shiftLines = renderShift(options.shift, next);
    if (shiftLines.length) lines.push("", ...shiftLines);
  } else if (next && options.legacyShiftStart) {
    // Opsgenie returned this; JSM Operations does not. Kept so a tenant that
    // still sends it does not lose the information.
    lines.push("", `Shift starts: ${timestamp(options.legacyShiftStart)}`);
  }

  for (const note of options.notes ?? []) lines.push("", `_${note}_`);
  if (options.directory?.note) lines.push("", `_${options.directory.note}_`);

  return lines.join("\n");
}

export interface TimelineRenderOptions {
  scheduleLabel: string;
  directory?: Directory;
}

/** One period of a rotation, as the timeline tool renders it. */
export interface RenderableShift extends ShiftSummary {
  responders: Array<{ id?: string; type?: string }>;
}

export function renderTimeline(shifts: RenderableShift[], options: TimelineRenderOptions): string {
  const lines = [`# On-call timeline for ${options.scheduleLabel}`, ""];

  if (!shifts.length) {
    lines.push(
      "_No rotation periods in this window. The schedule may have no rotations configured, or none covering these dates._",
    );
    return lines.join("\n");
  }

  for (const shift of shifts) {
    const rotation = shift.rotationName ? `**${shift.rotationName}** — ` : "";
    // Both ends on one line: reading a rota means scanning boundaries, and a
    // shift split across lines makes that scan much harder.
    lines.push(`- ${rotation}${timestamp(shift.start)} → ${timestamp(shift.end)}`);

    const names = shift.responders
      .map((responder) =>
        renderIdentity({
          id: responder.id ?? "unknown",
          ...(responder.type ? { type: responder.type } : {}),
          ...options.directory?.names.get(responder.id ?? ""),
        }),
      )
      .join(", ");

    lines.push(`  - ${names || "_nobody_"}`);
    if (shift.type && shift.type !== "base") lines.push(`  - _${shift.type}_`);
  }

  if (options.directory?.note) lines.push("", `_${options.directory.note}_`);

  return lines.join("\n");
}

/**
 * Mutating endpoints return an async receipt rather than the updated alert.
 * Every write tool renders it the same way so the agent learns the pattern.
 */
export function renderAsyncReceipt(
  action: string,
  subject: { noun: string; id?: string | undefined },
  response: AsyncActionResponse,
): string {
  // A create has no id yet — the receipt is all there is until the request
  // resolves — so say "a new alert" rather than printing an empty backtick pair.
  const target = subject.id ? `${subject.noun} \`${subject.id}\`` : `a new ${subject.noun}`;
  // Not every async endpoint returns a request id: POST /v1/alerts/{id}/notes
  // answers `{result: "queued"}` and nothing else, verified against a live
  // tenant. Printing "Request id: not returned" and then telling the model to
  // confirm "using the request id above" sends it to call
  // jsm_get_request_status with the literal string "not returned".
  const followUp = response.requestId
    ? "Confirm with jsm_get_request_status using the request id above, or re-read the " +
      `${subject.noun} after a moment.`
    : `This endpoint returned no request id to poll, so re-read the ${subject.noun} after a ` +
      "moment to confirm the change landed.";
  return [
    `${action} request accepted for ${target}.`,
    "",
    ...(response.requestId ? [`- **Request id**: \`${response.requestId}\``] : []),
    `- **Result**: ${response.result ?? "queued"}`,
    "",
    `JSM applies these actions asynchronously, so the ${subject.noun} may not reflect this change ` +
      `immediately. ${followUp}`,
  ].join("\n");
}

export function renderFormat(
  format: ResponseFormat,
  markdown: string,
  structured: Record<string, unknown>,
): ToolResult {
  const text = format === ResponseFormat.JSON ? JSON.stringify(structured, null, 2) : markdown;
  return ok(text, structured);
}
