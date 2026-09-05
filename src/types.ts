/**
 * Type definitions for the JSM Operations REST API.
 *
 * The alert model is inherited from Opsgenie, which JSM Operations replaced.
 * Fields are typed optional where the API omits them depending on the
 * endpoint (the list endpoint returns a thinner alert than the get endpoint).
 */

export type AlertStatus = "open" | "closed";

export type AlertPriority = "P1" | "P2" | "P3" | "P4" | "P5";

export interface AlertResponder {
  id?: string;
  type?: "user" | "team" | "escalation" | "schedule";
  name?: string;
  username?: string;
}

/** Alert as returned by the list endpoint (summary) and get endpoint (full). */
export interface Alert {
  id: string;
  /** Short human-friendly identifier, e.g. "1234". Prefer this when talking to humans. */
  tinyId?: string;
  alias?: string;
  message: string;
  status: AlertStatus;
  acknowledged: boolean;
  isSeen?: boolean;
  snoozed?: boolean;
  snoozedUntil?: string;
  /** Number of times this alert has been deduplicated into. */
  count?: number;
  tags?: string[];
  priority?: AlertPriority;
  source?: string;
  owner?: string;
  createdAt?: string;
  updatedAt?: string;
  lastOccurredAt?: string;
  /** The API's own spelling, with one "r". Not a typo here — it is theirs. */
  lastOccuredAt?: string;
  ownerTeamId?: string;
  responders?: AlertResponder[];
  teams?: AlertResponder[];
  integration?: { id?: string; name?: string; type?: string };
  /** JSM Operations returns these flat rather than under `integration`. */
  integrationName?: string;
  integrationType?: string;
  /** JSM Operations calls this `seen`; Opsgenie called it `isSeen`. */
  seen?: boolean;
  report?: {
    ackTime?: number;
    closeTime?: number;
    acknowledgedBy?: string;
    closedBy?: string;
  };
  /** JSM Operations returns these at the top level instead of under `report`. */
  ackTime?: string;
  closeTime?: string;
  /** Only present on the single-alert endpoint. */
  description?: string;
  details?: Record<string, string>;
  extraProperties?: Record<string, string>;
  actions?: string[];
  entity?: string;
}

export interface AlertNote {
  /** The API's own identifier for the note. Opsgenie called this `offset`. */
  id?: string;
  offset?: string;
  note: string;
  owner?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** A file attached to an alert. `id` is a timestamp the API sends as a string. */
export interface AlertAttachment {
  id?: string;
  attachmentName?: string;
  insertedAt?: string;
}

export interface AlertLog {
  offset?: string;
  log: string;
  owner?: string;
  /**
   * JSM Operations sends `logTime`/`logType`; `createdAt`/`type` are the
   * Opsgenie names. Reading only the latter rendered every activity-log line
   * with a timestamp of "unknown".
   */
  logTime?: string;
  logType?: string;
  createdAt?: string;
  type?: string;
}

/**
 * Every mutating alert endpoint returns this envelope rather than the updated
 * alert. The change is applied asynchronously; use the requestId with
 * jsm_get_request_status to confirm it landed.
 */
export interface AsyncActionResponse {
  result?: string;
  requestId?: string;
  took?: number;
}

export interface RequestStatus {
  action?: string;
  processedAt?: string;
  integrationId?: string;
  isSuccess?: boolean;
  status?: string;
  alertId?: string;
  alias?: string;
}

export interface Schedule {
  id: string;
  name: string;
  description?: string;
  timezone?: string;
  enabled?: boolean;
  ownerTeam?: { id?: string; name?: string };
  /** JSM Operations returns the owning team as a bare id. */
  teamId?: string;
  rotations?: unknown[];
}

export interface OnCallParticipant {
  id?: string;
  /** "user" | "team" | "escalation" | "noone". */
  type?: string;
  /** Present when the participant is an escalation/team that was expanded. */
  onCallParticipants?: OnCallParticipant[];
  /** next-on-calls nests under this name instead. */
  nextOnCallParticipants?: OnCallParticipant[];
  forwardedFrom?: OnCallParticipant;
  /**
   * Opsgenie returned a display name here. JSM Operations does not — every
   * participant arrives as a bare id, which is what makes resolveParticipants
   * (services/directory.ts) necessary rather than a nicety.
   */
  name?: string;
}

/**
 * Response from /v1/schedules/{id}/on-calls and /next-on-calls.
 *
 * The field the responders arrive under depends on `flat`:
 *   flat=true  -> onCallUsers / nextOnCallUsers   (bare account ids)
 *   flat=false -> onCallParticipants / nextOnCallParticipants
 *
 * The `*Recipients` names below are Opsgenie-era and are NOT in the JSM
 * Operations spec. Reading them cost us a real bug: the renderer looked only
 * for `onCallRecipients`, found nothing, and reported "Nobody is on-call" while
 * the JSON view showed a real person. They are retained purely so that a
 * tenant whose backend still emits the legacy shape keeps working — read the
 * documented name first and fall back, never the other way round.
 */
export interface OnCallData {
  /** Returned when flat=true. */
  onCallUsers?: string[];
  nextOnCallUsers?: string[];
  /** Returned when flat=false. */
  onCallParticipants?: OnCallParticipant[];
  nextOnCallParticipants?: OnCallParticipant[];
  /** Legacy Opsgenie names. Not documented by JSM Operations. */
  onCallRecipients?: string[];
  nextOnCallRecipients?: string[];
  /** Legacy Opsgenie fields. JSM Operations returns neither. */
  _parent?: { id?: string; name?: string; enabled?: boolean };
  exactNextOnCallTime?: string;
}

/** One responder of an on-call period, as the timeline describes it. */
export interface TimelineResponder {
  id?: string;
  /** "user" | "team" | "escalation" | "noone". */
  type?: string;
  deleted?: boolean;
}

/** A single continuous stretch of one rotation, with its real boundaries. */
export interface TimelinePeriod {
  startDate?: string;
  endDate?: string;
  /** "base" | "override" | "forwarding" | "historical". */
  type?: string;
  responder?: TimelineResponder;
  /** Present on some period types only — never rely on it being here. */
  flattenedResponders?: TimelineResponder[];
  /** Set on forwarding periods: who the shift was forwarded from. */
  from?: TimelineResponder;
}

export interface TimelineRotation {
  id?: string;
  name?: string;
  order?: number;
  deleted?: boolean;
  periods?: TimelinePeriod[];
}

/**
 * Response from /v1/schedules/{id}/timeline.
 *
 * `finalTimeline` is the one that matters: it is the schedule after overrides
 * and forwarding have been applied, which is what "who is actually on-call"
 * means. The other layers are only returned when explicitly expanded.
 */
export interface ScheduleTimeline {
  startDate?: string;
  endDate?: string;
  finalTimeline?: { rotations?: TimelineRotation[] };
  baseTimeline?: { rotations?: TimelineRotation[] };
  overrideTimeline?: { rotations?: TimelineRotation[] };
  forwardingTimeline?: { rotations?: TimelineRotation[] };
}

/** A responder id resolved to something a human can act on. */
export interface ResolvedIdentity {
  id: string;
  type?: string;
  displayName?: string;
  emailAddress?: string;
  /** Set when this person is on-call because they forwarded their shift. */
  forwarded?: boolean;
}

/**
 * Normalised envelope. The JSM Ops API is inconsistent about whether a
 * collection lands under `data` or `values`, so the client flattens both.
 */
export interface Paged<T> {
  items: T[];
  // Present-and-undefined: getCollection always sets these, from an envelope
  // that may not carry them.
  paging?: { next?: string; first?: string; last?: string } | undefined;
  totalCount?: number | undefined;
}

/** Standard pagination metadata attached to every list tool response. */
export interface PaginationMeta {
  /**
   * How many records are actually in this response. When the page was trimmed
   * to fit the character limit this is smaller than the API returned, and
   * `truncated` is set.
   */
  count: number;
  offset?: number;
  has_more: boolean;
  /**
   * Where to resume. Always `offset + count`, never `offset + limit`, so a
   * caller that follows it cannot skip records that were trimmed away.
   */
  next_offset?: number;
  /** Opaque cursor when the API returns a `next` link instead of an offset. */
  next_cursor?: string;
  /** Set when the response holds fewer records than the API returned. */
  truncated?: boolean;
  total?: number;
}

/** A rotation within an on-call schedule. */
export interface Rotation {
  id?: string;
  name?: string;
  startDate?: string;
  endDate?: string;
  /** "daily" | "weekly" | "hourly". */
  type?: string;
  length?: number;
  participants?: Array<{ id?: string; type?: string }>;
  timeRestriction?: unknown;
}

/** A one-off cover for someone else's shift. Addressed by alias, not by id. */
export interface ScheduleOverride {
  alias?: string;
  responder?: { id?: string; type?: string };
  startDate?: string;
  endDate?: string;
  rotationIds?: string[];
}

/** A team as GET /v1/teams reports it — note the teamId/teamName naming. */
export interface PlatformTeam {
  teamId?: string;
  teamName?: string;
}

/** A role within one team, granting rights on that team's operations. */
export interface TeamRole {
  id?: string;
  name?: string;
  rights?: Array<Record<string, unknown>>;
}

/** A contact method: where one person gets notified. */
export interface Contact {
  id?: string;
  /** "email" | "sms" | "voice" | "mobile". */
  method?: string;
  to?: string;
  status?: { enabled?: boolean; disabledReason?: string };
}

/** A custom user role, granting rights across the site rather than per team. */
export interface CustomUserRole {
  id?: string;
  name?: string;
  grantedRights?: string[];
  disallowedRights?: string[];
}
