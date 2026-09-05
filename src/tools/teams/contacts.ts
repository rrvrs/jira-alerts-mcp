/**
 * Contact methods: where one person actually gets notified.
 *
 * activate/deactivate are hand-written rather than generated: they are PATCHes
 * to an action sub-path with no request body, which is not one of the five
 * shapes the factory covers. This is the escape hatch working as intended.
 */

import { z } from "zod";

import { renderContact, renderContacts } from "../../services/render/teams.js";
import type { Contact } from "../../types.js";
import { defineTool } from "../define.js";
import { executeWrite } from "../execute-write.js";
import { defineResourceFamily, type ResourceConfig } from "../family.js";

const contactIdField = z.string().min(1).describe("Contact method id, from jsm_list_contacts.");

export const contactResource: ResourceConfig = {
  toolset: "teams",
  path: "/v1/users/contacts",
  noun: "contact",
  plural: "contacts",
  idParam: "contact_id",
  idField: contactIdField,
};

export const contactTools = defineResourceFamily<Contact>(contactResource, {
  list: {
    name: "jsm_list_contacts",
    title: "List a user's contact methods",
    description: `List the contact methods on an account — the addresses and numbers JSM will actually notify.

When someone says they were not paged, this is where the answer usually is: a disabled contact method delivers nothing, silently.

Args:
  - target_account_id (string, optional): whose contacts to read; omit for the account the credentials belong to
  - limit (number): 1-100, default 20
  - offset (number): records to skip, default 0
  - response_format ('markdown' | 'json'): default 'markdown'

Returns (json format): { "contacts": [ { "id": string, "method": "email" | "sms" | "voice" | "mobile", "to": string, "status": { "enabled": boolean, "disabledReason": string } } ], "pagination": {...} }

Disabled methods are called out explicitly rather than left for the reader to spot in the status field.

Examples:
  - "Why didn't Priya get paged?" -> target_account_id=<her account id>, then look for disabled methods`,
    query: {
      target_account_id: z
        .string()
        .optional()
        .describe(
          "Atlassian account id whose contacts to read. Omit for the credentials' own account.",
        ),
    },
    toParams: (params) => ({ targetAccountId: params.target_account_id }),
    queryFields: ["targetAccountId"],
    render: (contacts) => ["# Contact methods", "", renderContacts(contacts)].join("\n"),
    emptyMessage:
      "No contact methods on this account, which means JSM has nowhere to notify this person. Add one with jsm_create_contact.",
  },
  get: {
    name: "jsm_get_contact",
    title: "Get one contact method",
    description: `Read one contact method, including whether it is enabled.

Args:
  - contact_id (string)
  - response_format ('markdown' | 'json'): default 'markdown'

Returns: { "contact": { "id": string, "method": string, "to": string, "status": {...} } }`,
    render: (contact) => renderContact(contact),
  },
  create: {
    name: "jsm_create_contact",
    title: "Add a contact method",
    description: `Add a contact method to the account the credentials belong to.

Args:
  - method ('email' | 'sms' | 'voice'): how to reach them
  - to (string): the address or number — an email address for 'email', an E.164 number for 'sms' and 'voice'

Returns: { "contact": { "id": string, ... } }

Synchronous. Note that 'mobile' appears when reading contacts but cannot be created here — mobile is registered by the JSM mobile app itself.

A new contact method usually needs verifying before it delivers anything; read it back with jsm_get_contact to see its status rather than assuming it is live.`,
    input: {
      method: z
        .enum(["email", "sms", "voice"])
        .describe(
          "How to reach this person. 'mobile' is not creatable here — the mobile app registers itself.",
        ),
      to: z
        .string()
        .min(1)
        .describe("Email address for 'email'; an E.164 phone number for 'sms' and 'voice'."),
    },
    toBody: (params) => ({ method: params.method, to: params.to }),
    bodyFields: ["method", "to"],
    render: (contact) => renderContact(contact),
  },
  update: {
    name: "jsm_update_contact",
    title: "Change a contact method's destination",
    description: `Change where a contact method delivers.

Args:
  - contact_id (string): the method to change
  - to (string): the new address or number

Returns: { "contact": { "id": string, ... } }

Only the destination can be changed — the method itself ('email', 'sms', 'voice') is fixed at creation, so switching someone from SMS to email means creating a new contact and deleting the old one.

Changing the destination may reset the method's verified status, so read it back rather than assuming it keeps delivering.`,
    input: {
      to: z.string().min(1).describe("The new address or number."),
    },
    toBody: (params) => ({ to: params.to }),
    bodyFields: ["to"],
    render: (contact) => renderContact(contact),
  },
  remove: {
    name: "jsm_delete_contact",
    title: "Delete a contact method",
    description: `Permanently remove a contact method from an account.

Args:
  - contact_id (string)

Returns: { "deleted": true, "contact_id": string }

If this is the account's only contact method, that person can no longer be notified by anything — check with jsm_list_contacts first. jsm_deactivate_contact is the reversible way to stop delivery.

Requires delete:ops-config:jira-service-management, which Atlassian account API tokens do not carry — see the README.`,
  },
});

/** activate and deactivate: PATCH to an action sub-path, no body. */
function contactSwitch(name: string, action: "activate" | "deactivate") {
  const activating = action === "activate";
  return defineTool({
    name,
    toolset: "teams",
    endpoint: { method: "PATCH", path: `/v1/users/contacts/{id}/${action}` },
    title: `${activating ? "Activate" : "Deactivate"} a contact method`,
    description: `${
      activating
        ? "Turn a contact method back on, so JSM delivers notifications to it again."
        : "Stop a contact method delivering, without deleting it."
    }

Args:
  - contact_id (string): the method to ${action}

Returns: { "contact": { "id": string, ... } }

${
  activating
    ? "Use this to undo a deactivation. It does not create a contact method or re-verify one — if the method was never verified, activating it does not make it deliver."
    : "This is the reversible alternative to jsm_delete_contact, and the right tool when someone is on leave. The method keeps its address and can be turned back on with jsm_activate_contact. While deactivated it delivers nothing, silently — which is exactly why jsm_list_contacts calls disabled methods out."
}`,
    inputSchema: { contact_id: contactIdField },
    outputSchema: { contact: z.object({}).passthrough() },
    annotations: {
      readOnlyHint: false,
      // Deactivating stops notifications reaching a person; that is a change
      // worth prompting on, and it is not what "destructive" would suggest if
      // only deletes carried the hint.
      destructiveHint: !activating,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (params, client) =>
      executeWrite<Contact>(client, {
        label: `${activating ? "Activate" : "Deactivate"} contact`,
        method: "PATCH",
        path: `/v1/users/contacts/${encodeURIComponent(params.contact_id)}/${action}`,
        mode: "sync",
        subject: { key: "contact_id", value: params.contact_id, noun: "contact" },
        render: (contact) => renderContact(contact),
        structured: (contact) => ({ contact: contact as Record<string, unknown> }),
      }),
  });
}

export const contactSwitchTools = [
  contactSwitch("jsm_activate_contact", "activate"),
  contactSwitch("jsm_deactivate_contact", "deactivate"),
];
