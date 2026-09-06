# Tools

Every tool this server can register, with the endpoint behind it and whether it
reads, writes, or is marked destructive. For what this server is, how to install
it, and how to choose which of these load, see the [README](README.md).

## Alerts and on-call

Registered by default:

| Tool | Endpoint | Read/Write |
|---|---|---|
| `jsm_list_alerts` | `GET /v1/alerts` | read |
| `jsm_get_alert` | `GET /v1/alerts/{id}` or `GET /v1/alerts/alias` | read |
| `jsm_list_alert_notes` | `GET /v1/alerts/{id}/notes` | read |
| `jsm_list_alert_logs` | `GET /v1/alerts/{id}/logs` | read |
| `jsm_get_request_status` | `GET /v1/alerts/requests/{id}` | read |
| `jsm_create_alert` | `POST /v1/alerts` | write |
| `jsm_acknowledge_alert` | `POST /v1/alerts/{id}/acknowledge` | write |
| `jsm_close_alert` | `POST /v1/alerts/{id}/close` | write |
| `jsm_add_alert_note` | `POST /v1/alerts/{id}/notes` | write |
| `jsm_unacknowledge_alert` | `POST /v1/alerts/{id}/unacknowledge` | write |
| `jsm_snooze_alert` | `POST /v1/alerts/{id}/snooze` | write |
| `jsm_assign_alert` | `POST /v1/alerts/{id}/assign` | write |
| `jsm_escalate_alert` | `POST /v1/alerts/{id}/escalate` | write |
| `jsm_add_alert_responder` | `POST /v1/alerts/{id}/responders` | write |
| `jsm_update_alert_field` | `PATCH /v1/alerts/{id}/{priority,message,description}` | write |
| `jsm_update_alert_note` | `PATCH /v1/alerts/{id}/notes/{id}` | write |
| `jsm_delete_alert_note` | `DELETE /v1/alerts/{id}/notes/{id}` | **destructive** |
| `jsm_add_alert_tags` | `POST /v1/alerts/{id}/tags` | write |
| `jsm_remove_alert_tags` | `DELETE /v1/alerts/{id}/tags` | **destructive** |
| `jsm_add_alert_extra_properties` | `POST /v1/alerts/{id}/extra-properties` | **destructive** |
| `jsm_remove_alert_extra_properties` | `DELETE /v1/alerts/{id}/extra-properties` | **destructive** |
| `jsm_execute_alert_action` | `POST /v1/alerts/{id}/action` | **destructive** |
| `jsm_delete_alert` | `DELETE /v1/alerts/{id}` | **destructive** |
| `jsm_list_schedules` | `GET /v1/schedules` | read |
| `jsm_get_on_call` | `GET /v1/schedules/{id}/on-calls` | read |
| `jsm_get_next_on_call` | `GET /v1/schedules/{id}/next-on-calls` | read |
| `jsm_get_schedule_timeline` | `GET /v1/schedules/{id}/timeline` | read |
| `jsm_list_capabilities` | — (answers from configuration) | read |

## Schedule configuration

The `schedules` toolset, **not** registered by default:

| Tool | Endpoint | Read/Write |
|---|---|---|
| `jsm_get_schedule` | `GET /v1/schedules/{id}` | read |
| `jsm_create_schedule` | `POST /v1/schedules` | write |
| `jsm_update_schedule` | `PATCH /v1/schedules/{id}` | **destructive** |
| `jsm_delete_schedule` | `DELETE /v1/schedules/{id}` | **destructive** |
| `jsm_list_rotations` | `GET /v1/schedules/{id}/rotations` | read |
| `jsm_get_rotation` | `GET /v1/schedules/{id}/rotations/{id}` | read |
| `jsm_create_rotation` | `POST /v1/schedules/{id}/rotations` | write |
| `jsm_update_rotation` | `PATCH /v1/schedules/{id}/rotations/{id}` | **destructive** |
| `jsm_delete_rotation` | `DELETE /v1/schedules/{id}/rotations/{id}` | **destructive** |
| `jsm_list_overrides` | `GET /v1/schedules/{id}/overrides` | read |
| `jsm_get_override` | `GET /v1/schedules/{id}/overrides/{alias}` | read |
| `jsm_create_override` | `POST /v1/schedules/{id}/overrides` | write |
| `jsm_update_override` | `PUT /v1/schedules/{id}/overrides/{alias}` | **destructive** |
| `jsm_delete_override` | `DELETE /v1/schedules/{id}/overrides/{alias}` | **destructive** |

## Teams and permissions

The `teams` toolset, **not** registered by default:

| Tool | Endpoint | Read/Write |
|---|---|---|
| `jsm_list_teams` | `GET /v1/teams` | read |
| `jsm_list_team_roles` | `GET /v1/teams/{id}/roles` | read |
| `jsm_get_team_role` | `GET /v1/teams/{id}/roles/{identifier}` | read |
| `jsm_create_team_role` | `POST /v1/teams/{id}/roles` | write |
| `jsm_update_team_role` | `PATCH /v1/teams/{id}/roles/{identifier}` | **destructive** |
| `jsm_delete_team_role` | `DELETE /v1/teams/{id}/roles/{identifier}` | **destructive** |
| `jsm_list_contacts` | `GET /v1/users/contacts` | read |
| `jsm_get_contact` | `GET /v1/users/contacts/{id}` | read |
| `jsm_create_contact` | `POST /v1/users/contacts` | write |
| `jsm_update_contact` | `PATCH /v1/users/contacts/{id}` | **destructive** |
| `jsm_delete_contact` | `DELETE /v1/users/contacts/{id}` | **destructive** |
| `jsm_activate_contact` | `PATCH /v1/users/contacts/{id}/activate` | write |
| `jsm_deactivate_contact` | `PATCH /v1/users/contacts/{id}/deactivate` | **destructive** |

## Maintenance windows

The `maintenance` toolset, **not** registered by default:

| Tool | Endpoint | Read/Write |
|---|---|---|
| `jsm_list_maintenances` | `GET /v1/maintenances` or `GET /v1/teams/{id}/maintenances` | read |
| `jsm_get_maintenance` | `GET /v1/maintenances/{id}` or the team twin | read |
| `jsm_create_maintenance` | `POST /v1/maintenances` or the team twin | write |
| `jsm_update_maintenance` | `PATCH /v1/maintenances/{id}` or the team twin | **destructive** |
| `jsm_delete_maintenance` | `DELETE /v1/maintenances/{id}` or the team twin | **destructive** |
| `jsm_cancel_maintenance` | `POST /v1/maintenances/{id}/cancel` or the team twin | write |

Each of these is one tool over two endpoints: pass `team_id` for a team's
windows, omit it for site-wide ones. They are separate collections, so omitting
`team_id` does not return both — worth knowing when you are trying to explain
why alerting has gone quiet.

The three quarantined toolsets below load only when named explicitly — no
profile includes them, `all` included. See
[What has and has not been verified](README.md#what-has-and-has-not-been-verified).

## Heartbeats

The `heartbeats` toolset:

| Tool | Endpoint | Read/Write |
|---|---|---|
| `jsm_list_heartbeats` | `GET /v1/teams/{id}/heartbeats` | read |
| `jsm_ping_heartbeat` | `GET /v1/teams/{id}/heartbeats/ping` | **destructive** |
| `jsm_create_heartbeat` | `POST /v1/teams/{id}/heartbeats` | write |
| `jsm_update_heartbeat` | `PATCH /v1/teams/{id}/heartbeats?name=` | **destructive** |
| `jsm_delete_heartbeat` | `DELETE /v1/teams/{id}/heartbeats?name=` | **destructive** |

Heartbeats are identified by `name` in the query string rather than by an id in
the path — there is no item URL for them. They are a paid feature: on a plan
without them every heartbeat endpoint answers `402 Please upgrade your pricing
plan for Heartbeat Monitoring`, which the error handler reports as a plan limit
rather than as something to retry. `jsm_ping_heartbeat` is marked
destructive because sending a ping by hand asserts, on the monitored job's
behalf, that it is alive: it resets the timer and clears a firing alert.

## Alert attachments

The `attachments` toolset:

| Tool | Endpoint | Read/Write |
|---|---|---|
| `jsm_list_alert_attachments` | `GET /v1/alerts/{id}/attachments` | read |
| `jsm_get_alert_attachment` | `GET /v1/alerts/{id}/attachments/{id}` | read |
| `jsm_delete_alert_attachment` | `DELETE /v1/alerts/{id}/attachments/{id}` | **destructive** |

Uploading is not implemented — see the note at the end of this page. These
three answer `403 Feature not available in your plan` on a site whose plan
excludes attachments, whatever the token holds.

## Forwarding rules

The `forwarding` toolset:

| Tool | Endpoint | Read/Write |
|---|---|---|
| `jsm_list_forwarding_rules` | `GET /v1/forwarding-rules` | read |
| `jsm_get_forwarding_rule` | `GET /v1/forwarding-rules/{id}` | read |
| `jsm_create_forwarding_rule` | `POST /v1/forwarding-rules` | write |
| `jsm_update_forwarding_rule` | `PUT /v1/forwarding-rules/{id}` | **destructive** |
| `jsm_delete_forwarding_rule` | `DELETE /v1/forwarding-rules/{id}` | **destructive** |

Forwarding sends one person's notifications to another for a window. The API
refuses to forward a user back to themselves, so verifying these needs a site
with two users — which is the only reason they are quarantined.

## Who gets notified

The `routing` toolset, **not** registered by default:

| Tool | Endpoint | Read/Write |
|---|---|---|
| `jsm_list_escalations` | `GET /v1/teams/{id}/escalations` | read |
| `jsm_get_escalation` | `GET /v1/teams/{id}/escalations/{id}` | read |
| `jsm_create_escalation` | `POST /v1/teams/{id}/escalations` | write |
| `jsm_update_escalation` | `PATCH /v1/teams/{id}/escalations/{id}` | **destructive** |
| `jsm_delete_escalation` | `DELETE /v1/teams/{id}/escalations/{id}` | **destructive** |
| `jsm_list_routing_rules` | `GET /v1/teams/{id}/routing-rules` | read |
| `jsm_get_routing_rule` | `GET /v1/teams/{id}/routing-rules/{id}` | read |
| `jsm_create_routing_rule` | `POST /v1/teams/{id}/routing-rules` | write |
| `jsm_update_routing_rule` | `PATCH /v1/teams/{id}/routing-rules/{id}` | **destructive** |
| `jsm_delete_routing_rule` | `DELETE /v1/teams/{id}/routing-rules/{id}` | **destructive** |
| `jsm_change_routing_rule_order` | `PATCH /v1/teams/{id}/routing-rules/{id}/change-order` | **destructive** |
| `jsm_list_notification_rules` | `GET /v1/notification-rules` | read |
| `jsm_get_notification_rule` | `GET /v1/notification-rules/{id}` | read |
| `jsm_create_notification_rule` | `POST /v1/notification-rules` | write |
| `jsm_update_notification_rule` | `PATCH /v1/notification-rules/{id}` | **destructive** |
| `jsm_delete_notification_rule` | `DELETE /v1/notification-rules/{id}` | **destructive** |
| `jsm_list_notification_steps` | `GET /v1/notification-rules/{id}/steps` | read |
| `jsm_get_notification_step` | `GET /v1/notification-rules/{id}/steps/{id}` | read |
| `jsm_create_notification_step` | `POST /v1/notification-rules/{id}/steps` | write |
| `jsm_update_notification_step` | `PATCH /v1/notification-rules/{id}/steps/{id}` | **destructive** |
| `jsm_delete_notification_step` | `DELETE /v1/notification-rules/{id}/steps/{id}` | **destructive** |

These are the tools that change who gets paged, which is why so many of them
carry `destructiveHint`. `jsm_change_routing_rule_order` deletes nothing and is
marked destructive because order *is* behaviour: routing rules are evaluated top
down and the first match wins, so moving one can silently redirect alerts that
were reaching the right people.

Notification rules belong to the account the credentials authenticate as. There
is no parameter for reading somebody else's, so a shared token cannot answer
"why wasn't Priya notified?" from that endpoint.

Alert and notification policies and custom user roles were **removed in 2.0.0**.
Seventeen tools across `/v1/alerts/policies`, `/v1/teams/{id}/policies` and
`/v1/roles` answered `403 You are not authorized` under two separate
credentials, one of them holding Jira `ADMINISTER` — custom user roles is an
Opsgenie Enterprise feature and the policy refusal looks like the same class of
limit. They were never once seen to work, so they no longer ship. The endpoints
are still in the vendored spec and the drift guard still reads them, so
restoring the tools is a revert rather than a rewrite.

Enable them with `JSM_TOOLSETS=responder,schedules,teams`, or `JSM_TOOLSETS=admin` for
on-call reads plus schedule and team configuration. They are separate from
`responder` on purpose: editing a rotation or granting a role is not something a
responder working an incident should be one tool call away from, and the write
scopes are a different grant.

## Reading these tables

`jsm_deactivate_contact` and `jsm_change_routing_rule_order` are marked
destructive without deleting anything. Deactivating a contact method stops a
person being notified — silently, which is the failure mode worth prompting on —
and reordering a routing rule changes which alerts reach whom.

Only the **Alerts and on-call** table above is registered by default. Narrow
that surface further, or widen it to the families below, with `JSM_TOOLSETS`
and `JSM_READ_ONLY` — see
[Choosing your toolsets](README.md#choosing-your-toolsets).

`jsm_create_alert` pages people. A created alert enters the team's routing and
escalation rules exactly as one raised by a monitoring integration would. Its
`alias` is the de-duplication key: creating against an alias that already has an
open alert increments that alert's count instead of raising a second one, which
is what makes a retried create safe — and what makes a carelessly reused alias
quietly do nothing.

Tools marked **destructive** carry `destructiveHint: true`, which is what MCP
clients read to decide whether to prompt before running something. They are
registered like any other tool — the annotation is the guardrail, not absence —
and several of them need `delete:ops-alert:jira-service-management`, a separate
grant from `write:ops-alert`. A token that can close alerts may well not be able
to delete them, and that is a sensible configuration rather than something to
work around.

`jsm_delete_alert` is included and is almost never the right tool. Closing an
alert takes it out of the open queue and keeps the record of who was paged and
what they tried; deleting throws that away for everyone, with no undo.

Not implemented: `POST /v1/alerts/{id}/attachments` (uploading a file). It is the
only endpoint in the API with a non-JSON body, and the only one that would
require this server to read your local filesystem — a capability worth deciding
on deliberately rather than acquiring as a side effect. Open an issue if you need
it.
