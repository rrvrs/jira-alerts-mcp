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
  ownerTeamId?: string;
  responders?: AlertResponder[];
  teams?: AlertResponder[];
  integration?: { id?: string; name?: string; type?: string };
  report?: {
    ackTime?: number;
    closeTime?: number;
    acknowledgedBy?: string;
    closedBy?: string;
  };
  /** Only present on the single-alert endpoint. */
  description?: string;
  details?: Record<string, string>;
  extraProperties?: Record<string, string>;
  actions?: string[];
  entity?: string;
}

export interface AlertNote {
  offset?: string;
  note: string;
  owner?: string;
  createdAt?: string;
}

export interface AlertLog {
  offset?: string;
  log: string;
  owner?: string;
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
  rotations?: unknown[];
}

export interface OnCallParticipant {
  id?: string;
  name?: string;
  type?: string;
  /** Present when the participant is an escalation/team that was expanded. */
  onCallParticipants?: OnCallParticipant[];
  forwardedFrom?: { user?: OnCallParticipant };
}

export interface OnCallData {
  _parent?: { id?: string; name?: string; enabled?: boolean };
  /** Returned when flat=false. */
  onCallParticipants?: OnCallParticipant[];
  /** Returned when flat=true. */
  onCallRecipients?: string[];
  /** next-on-calls only. */
  nextOnCallParticipants?: OnCallParticipant[];
  nextOnCallRecipients?: string[];
  exactNextOnCallTime?: string;
}

/**
 * Normalised envelope. The JSM Ops API is inconsistent about whether a
 * collection lands under `data` or `values`, so the client flattens both.
 */
export interface Paged<T> {
  items: T[];
  paging?: { next?: string; first?: string; last?: string };
  totalCount?: number;
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
