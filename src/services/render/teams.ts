/**
 * Renderers for the teams family: teams, team roles, contacts and user roles.
 */

import type { Contact, PlatformTeam, TeamRole } from "../../types.js";

export function renderTeams(teams: PlatformTeam[]): string {
  if (!teams.length) return "No teams found.";
  return teams
    .map((team) => `**${team.teamName ?? "(unnamed team)"}**\n  - id: \`${team.teamId ?? "?"}\``)
    .join("\n");
}

/** Rights are free-form objects; show the count and let the detail view carry them. */
function rightsSummary(rights: Array<Record<string, unknown>> | undefined): string {
  if (!rights?.length) return "no rights — this role grants nothing";
  return `${rights.length} right${rights.length === 1 ? "" : "s"}`;
}

export function renderTeamRoles(roles: TeamRole[]): string {
  if (!roles.length) return "No roles found.";
  return roles
    .map((role) =>
      [
        `**${role.name ?? "(unnamed role)"}**`,
        `  - ${rightsSummary(role.rights)}`,
        `  - id: \`${role.id ?? "?"}\``,
      ].join("\n"),
    )
    .join("\n");
}

export function renderTeamRole(role: TeamRole): string {
  const lines = [`# ${role.name ?? "(unnamed role)"}`, "", `- **id**: \`${role.id ?? "?"}\``];
  if (role.rights?.length) {
    lines.push("", "## Rights", "", "```json", JSON.stringify(role.rights, null, 2), "```");
  } else {
    lines.push("", "_This role grants no rights._");
  }
  return lines.join("\n");
}

export function renderContacts(contacts: Contact[]): string {
  if (!contacts.length) return "No contact methods found.";
  return contacts
    .map((contact) => {
      const bits = [`**${contact.method ?? "?"}** — ${contact.to ?? "?"}`];
      // A disabled contact is the reason a notification silently goes nowhere,
      // so it is stated rather than left to the reader to notice.
      if (contact.status?.enabled === false) {
        bits.push(
          `  - **disabled**${contact.status.disabledReason ? `: ${contact.status.disabledReason}` : ""} — nothing is delivered here`,
        );
      }
      bits.push(`  - id: \`${contact.id ?? "?"}\``);
      return bits.join("\n");
    })
    .join("\n");
}

export function renderContact(contact: Contact): string {
  return [`# Contact \`${contact.id ?? "?"}\``, "", renderContacts([contact])].join("\n");
}

/**
 * A contact write receipt, which carries less than a read of the same contact.
 *
 * The four contact write endpoints answer `SimpleCreateData`/`SimpleData` — an
 * id, sometimes a name, never the method or address. Rendered through
 * renderContact those absent fields printed as `**?** — ?`, so a create whose
 * id had just been made readable still looked like it had failed, and a model
 * reading the receipt would report the destination as unknown.
 *
 * Reports what the API actually returned and names the read that carries the
 * rest. Still defers to renderContacts if a field does arrive, so an API that
 * starts answering in full needs no change here.
 */
export function renderContactReceipt(contact: Contact): string {
  const known = contact.method !== undefined || contact.to !== undefined;
  return [
    `# Contact \`${contact.id ?? "?"}\``,
    "",
    known
      ? renderContacts([contact])
      : "The API confirms this write with the contact id alone; it does not return the method " +
        "or destination. Read it back with jsm_get_contact to see where it delivers and " +
        "whether it is enabled.",
  ].join("\n");
}
