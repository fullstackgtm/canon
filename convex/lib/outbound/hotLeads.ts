/**
 * Explee hot leads into Canon: each lead becomes a contact at its company (fill
 * missing only, so nothing a rep typed is overwritten) and a `hot_lead`
 * observation on that contact carrying the reply verbatim. The poll's cursor is
 * the newest `became_hot_at` seen; Explee's `since` is inclusive, so the lead on
 * the boundary comes back and its observation key keeps it from logging twice.
 * The stores are ports, so the same code runs in an action and in a test.
 *
 * Pure: no database access, no Node-only imports.
 */
import { normalizeDomain } from "../recordClient.ts";
import type { AccountInput, ContactInput } from "../recordContract.ts";
import type { PlannedObservation } from "../signals/observations.ts";
import type { ExpleeClient, ExpleeHotLead } from "./explee.ts";

/** Pages read per run: 25 × 200 leads. A backlog past that continues on the next run. */
export const HOT_LEAD_PAGES_MAX = 25;
/** The integration card lists this many of the latest imports. */
export const RECENT_MAX = 10;

const FREEMAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "hotmail.com", "outlook.com", "live.com", "msn.com",
  "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "comcast.net",
]);

export const hotLeadKey = (lead: Pick<ExpleeHotLead, "campaignId" | "personId">) => `explee:${lead.campaignId}:${lead.personId}`;

export type HotLeadPlan =
  | { kind: "write"; account: AccountInput; contact: ContactInput; observation: PlannedObservation }
  | { kind: "skip"; reason: string };

/** The company a lead belongs to: Explee's domain, else its work email's. A personal mailbox names no company. */
function domainOf(lead: ExpleeHotLead, email: string): string | null {
  const given = lead.companyDomain ? normalizeDomain(lead.companyDomain) : "";
  if (given && given.includes(".") && !FREEMAIL.has(given)) return given;
  const fromEmail = email.split("@")[1] ?? "";
  return fromEmail && !FREEMAIL.has(fromEmail) ? fromEmail : null;
}

export function planHotLead(lead: ExpleeHotLead, observedAt: number): HotLeadPlan {
  const email = lead.email?.toLowerCase();
  if (!email || !email.includes("@")) return { kind: "skip", reason: "no email" };
  const domain = domainOf(lead, email);
  if (!domain) return { kind: "skip", reason: "no company domain" };
  const occurredAt = lead.becameHotAt ? Date.parse(lead.becameHotAt) : NaN;
  return {
    kind: "write",
    account: { domain, name: lead.companyName ?? domain },
    contact: {
      accountDomain: domain,
      fullName: lead.name ?? email.split("@")[0],
      email,
      ...(lead.jobTitle ? { title: lead.jobTitle } : {}),
      ...(lead.linkedinUrl ? { linkedinUrl: lead.linkedinUrl } : {}),
    },
    observation: {
      body: { type: "hot_lead", key: hotLeadKey(lead), provider: "explee", campaignId: lead.campaignId, personId: lead.personId, reply: lead.whyHot ?? "" },
      observedAt,
      ...(Number.isFinite(occurredAt) ? { occurredAt } : {}),
    },
  };
}

export type HotLeadPorts = {
  /** Writes the company and the person; returns the contact's id, or null when the record service refused it. Repeating it for the same key changes nothing. */
  upsert(key: string, account: AccountInput, contact: ContactInput): Promise<string | null>;
  /** Appends the observation unless the contact already has one with its key. Returns whether it appended. */
  log(contactId: string, observation: PlannedObservation): Promise<boolean>;
};

export type RecentHotLead = { contactId: string; name: string; company: string; at: number };

export type HotLeadSync = {
  imported: number;
  /** Leads already in Canon from an earlier run. */
  already: number;
  skipped: Array<{ personId: string; reason: string }>;
  /** The next poll's `since`: the newest `became_hot_at` seen, or the one passed in. */
  cursor: string | null;
  recent: RecentHotLead[];
};

const later = (a: string | null, b: string | null) => (!a ? b : !b ? a : Date.parse(b) > Date.parse(a) ? b : a);

/** Read every lead that went hot since the cursor and bring each one into Canon. */
export async function syncHotLeads(opts: { client: ExpleeClient; since: string | null; ports: HotLeadPorts; now: number }): Promise<HotLeadSync> {
  const { client, ports, now } = opts;
  const out: HotLeadSync = { imported: 0, already: 0, skipped: [], cursor: opts.since, recent: [] };
  let offset: number | null = 0;
  for (let page = 0; page < HOT_LEAD_PAGES_MAX && offset !== null; page++) {
    const r = await client.hotLeads({ ...(opts.since ? { since: opts.since } : {}), offset });
    for (const lead of r.leads) {
      out.cursor = later(out.cursor, lead.becameHotAt);
      const plan = planHotLead(lead, now);
      if (plan.kind === "skip") {
        out.skipped.push({ personId: lead.personId, reason: plan.reason });
        continue;
      }
      const contactId = await ports.upsert(hotLeadKey(lead), plan.account, plan.contact);
      if (!contactId) {
        out.skipped.push({ personId: lead.personId, reason: "the record service refused the contact" });
        continue;
      }
      if (!(await ports.log(contactId, plan.observation))) {
        out.already++;
        continue;
      }
      out.imported++;
      out.recent.push({ contactId, name: plan.contact.fullName, company: plan.account.name, at: plan.observation.occurredAt ?? now });
    }
    offset = r.nextOffset;
  }
  out.recent.sort((a, b) => b.at - a.at).splice(RECENT_MAX);
  return out;
}
