/**
 * Enrichment when someone clicks Research (docs/credits.md): each person's profile (treg people.enrich, routed,
 * about $0.008) and the company's (treg companies.enrich, routed, about $0.002). getleadsio's free tier is 5 calls a
 * day for the whole treg team (measured 2026-10-13), so it isn't used. A profile found fills the record's empty
 * fields and adds its columns as enrichment (it ranks below a person's or a CRM's values), costs credits whatever
 * the plan at the rate card's markup on what treg charged (Ryan, 2026-10-13: enrichment always costs credits), and,
 * for a person, is saved as their profile page so research can quote it. Nothing is charged for one not found.
 */
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { clientFor, recordEditPorts } from "../records";
import { promoteContacts } from "./recordPromotion";
import type { RecordClient } from "./recordClient";
import { editPartyRecord } from "./canon/partyLedger";
import type { Access } from "./access";
import { paidCallsAllowed } from "./treg";
import { MICRO, creditsForCost } from "./creditPacks";
import { arrivalNote, departureEvidence, departureNote, readJobChange } from "./jobChange";
import { checkJobChange, enrichCompanyProfile, enrichmentReady, enrichPersonProfile } from "./providers/enrich";
import { companyDomain } from "./providers/treg";
import { companyPatch, personPatch, profilePage, readCompany, readRoutedPerson, sameEmployer, type EnrichPatch } from "./enrichProfile";

/** treg's ceiling on one company enrichment: its routed price was $0.0019 (2026-10-13). */
const COMPANY_MAX_USD = 0.003;
/**
 * treg's ceiling on one person enrichment: Ocean.io served it for $0.0081. Some providers bill a miss too (one
 * lookup that found nobody cost $0.0226 at a $0.03 ceiling, 2026-10-13), and a miss costs the workspace nothing,
 * so the ceiling keeps to the cheap ones.
 */
const PERSON_MAX_USD = 0.01;
/** People looked up at once: treg tries its providers in turn (one lookup took 12 s). */
const PERSON_CONCURRENCY = 4;
/** A profile's credits from what treg charged for it, at the rate card's markup (creditsForCost); 1 at least. */
const creditsFor = (costMicro: number | null) => creditsForCost((costMicro ?? 0) / 1_000_000);

type Caller = { orgId: string; userId: string; access: Access };
export type PersonToEnrich = { id: string; fullName: string; title?: string | null; linkedinUrl?: string | null; domain: string };
export type CompanyToEnrich = { id: string; domain: string; employees?: number | null; industry?: string | null; country?: string | null; linkedinUrl?: string | null };

const day = () => new Date().toISOString().slice(0, 10);
/** One record's enrichment for the day: its charge's ledger ref, and the key its write is made under. */
const refFor = (object: "account" | "contact", orgId: string, id: string) => `enrich:${object}:${orgId}:${id}:${day()}`;

/** Whether this record was already enriched today: a second lookup would pay treg again for the same profile. */
async function enrichedToday(ctx: ActionCtx, object: "account" | "contact", orgId: string, id: string): Promise<boolean> {
  return !!(await ctx.runQuery(internal.credits.chargeOf, { ref: refFor(object, orgId, id) }));
}

/** Whether the workspace can pay for one more profile at its most expensive (`maxUsd`, the call's ceiling). */
async function canPay(ctx: ActionCtx, orgId: string, maxUsd: number): Promise<boolean> {
  return (await ctx.runQuery(internal.credits.balanceOf, { orgId: orgId as Id<"organizations"> })).spendableMicro >= creditsForCost(maxUsd) * MICRO;
}

/**
 * Write one profile found, then charge it: a write that fails costs nothing. Its `custom.*` columns are registered
 * on the workspace first, typed by their values. False when the workspace couldn't pay (checked before the call).
 */
async function writeAndCharge(
  ctx: ActionCtx, caller: Caller, a: { object: "account" | "contact"; id: string; patch: EnrichPatch; provider: string; callId: Id<"providerCalls">; credits: number; note: string },
): Promise<boolean> {
  const ref = refFor(a.object, caller.orgId, a.id);
  const orgId = caller.orgId as Id<"organizations">;
  const custom = Object.entries(a.patch).filter(([k]) => k.startsWith("custom.")).map(([attribute, value]) => ({ attribute, value }));
  if (custom.length) await ctx.runMutation(internal.canon.ensureCustomFields, { orgId, object: a.object, fields: custom });
  if (Object.keys(a.patch).length) {
    await editPartyRecord(await recordEditPorts(ctx, caller, {
      object: a.object, id: a.id, patch: a.patch, idempotencyKey: `${ref}:write`, found: { provider: a.provider, callId: a.callId },
    }, "edit"));
  }
  if (!(await ctx.runMutation(internal.credits.charge, { orgId, ref, amountMicro: a.credits * MICRO, note: a.note }))) return false;
  await ctx.runAction(internal.credits.meterCharge, { ref, provider: a.provider }).catch((e) => console.warn(`enrich: Metronome report failed: ${e instanceof Error ? e.message.slice(0, 160) : e}`));
  return true;
}

/**
 * Enrich each person: their profile by LinkedIn URL, or by name and the company's domain. Returns how many were
 * enriched and a note on what stopped the rest (the daily cap, the workspace's credits).
 */
export async function enrichPeople(ctx: ActionCtx, caller: Caller, people: readonly PersonToEnrich[]): Promise<{ enriched: number; note: string | null }> {
  if (!enrichmentReady() || !paidCallsAllowed() || !people.length) return { enriched: 0, note: null };
  let enriched = 0;
  let broke = false;
  const queue = [...people];
  const one = async (p: PersonToEnrich) => {
    if (!(await canPay(ctx, caller.orgId, PERSON_MAX_USD))) { broke = true; return; }
    const [first, ...rest] = p.fullName.trim().split(/\s+/);
    if (!p.linkedinUrl && (!first || !rest.length)) return;
    if (await enrichedToday(ctx, "contact", caller.orgId, p.id)) return;
    try {
      // treg tries its providers cheapest first and stops at the first that finds them (Ocean.io, about $0.008).
      const res = await enrichPersonProfile(ctx, {
        orgId: caller.orgId, maxCostUsd: PERSON_MAX_USD,
        body: { ...(first && rest.length ? { first_name: first, last_name: rest.join(" ") } : {}), domain: p.domain, ...(p.linkedinUrl ? { linkedin_url: p.linkedinUrl } : {}) },
      }, (r) => {
        const profile = r.status === 200 ? readRoutedPerson(r.body) : null;
        // It must be them at this company: found by name, a namesake elsewhere isn't them.
        return profile && (!!p.linkedinUrl || sameEmployer(profile, p.domain)) ? profile : null;
      });
      const profile = res.found;
      if (!profile) return;
      if (!(await writeAndCharge(ctx, caller, { object: "contact", id: p.id, patch: personPatch(profile, p), provider: "treg", callId: res.call, credits: creditsFor(res.costMicro), note: `Profile: ${p.fullName}` }))) {
        broke = true;
        return;
      }
      const page = profilePage(profile);
      if (page) await ctx.runMutation(internal.researchAgents.savePages, { orgId: caller.orgId as Id<"organizations">, pages: [{ url: page.url, text: page.text }] });
      enriched++;
    } catch (error) {
      console.warn(`enrich: ${p.fullName} failed: ${error instanceof Error ? error.message.slice(0, 200) : error}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PERSON_CONCURRENCY, queue.length) }, async () => {
    for (let p = queue.shift(); p && !broke; p = queue.shift()) await one(p);
  }));
  return { enriched, note: broke ? "The workspace is out of credits, so the rest weren't enriched." : null };
}

/** Enrich the company by its domain. True when its profile was found and written. */
export async function enrichCompany(ctx: ActionCtx, caller: Caller, c: CompanyToEnrich): Promise<boolean> {
  if (!enrichmentReady() || !paidCallsAllowed() || !(await canPay(ctx, caller.orgId, COMPANY_MAX_USD))) return false;
  if (await enrichedToday(ctx, "account", caller.orgId, c.id)) return true;
  try {
    const res = await enrichCompanyProfile(ctx, { orgId: caller.orgId, domain: c.domain, maxCostUsd: COMPANY_MAX_USD }, (r) => (r.status === 200 ? readCompany(r.body) : null));
    if (!res.found) return false;
    return await writeAndCharge(ctx, caller, { object: "account", id: c.id, patch: companyPatch(res.found, c), provider: "treg", callId: res.call, credits: creditsFor(res.costMicro), note: `Company profile: ${c.domain}` });
  } catch (error) {
    console.warn(`enrich: ${c.domain} failed: ${error instanceof Error ? error.message.slice(0, 200) : error}`);
    return false;
  }
}

/** What a job change check costs the workspace, whatever it finds (Ryan, 2026-10-14: about cost, to run it often). */
export const JOB_CHECK_CREDITS = 8;
/** treg's ceiling on one check: LeadMagic's detector charged $0.075 (2026-10-14). */
const JOB_CHECK_MAX_USD = 0.08;
/** A person is checked again only after this long. */
const JOB_CHECK_EVERY_MS = 30 * 24 * 60 * 60_000;

export type PersonToCheck = { id: string; fullName: string; linkedinUrl: string; company: string };
export type Departure = { id: string; name: string; left: string; note: string; movedTo: string | null };

/** This month's check of a person: a person is checked at most once in 30 days (a month's key, and the last check's time). */
const checkRef = (orgId: string, id: string, at: number) => `jobcheck:${orgId}:${id}:${new Date(at).toISOString().slice(0, 7)}`;

/**
 * Check whether each person still works at `company` (lib/jobChange.ts), 8 credits a check. Someone who left gets
 * a "no longer works here" answer on the recipe's still-at-company field (`employedSlug`), a note on their
 * contact, and a new contact at their new company carrying their profile URL (the record service knows a person
 * by it, so the old contact gives it up); the old contact stays as the record of their time there.
 */
export async function checkJobChanges(
  ctx: ActionCtx, caller: Caller, sees: RecordClient, people: readonly PersonToCheck[], employedSlug: string,
): Promise<{ departures: Departure[]; note: string | null }> {
  if (!enrichmentReady() || !paidCallsAllowed() || !people.length) return { departures: [], note: null };
  const orgId = caller.orgId as Id<"organizations">;
  const departures: Departure[] = [];
  let broke = false;
  const queue = [...people];
  const one = async (p: PersonToCheck) => {
    const now = Date.now();
    if (await ctx.runQuery(internal.credits.chargeOf, { ref: checkRef(caller.orgId, p.id, now) })) return;
    // The last 30 days can reach back over two month keys (March 1 reaches January 30): read each.
    const monthStart = new Date(now).setUTCDate(1);
    const earlier = [...new Set([checkRef(caller.orgId, p.id, monthStart - 1), checkRef(caller.orgId, p.id, now - JOB_CHECK_EVERY_MS)])];
    for (const ref of earlier) {
      const last = await ctx.runQuery(internal.credits.chargeOf, { ref });
      if (last && now - last.at < JOB_CHECK_EVERY_MS) return;
    }
    if ((await ctx.runQuery(internal.credits.balanceOf, { orgId })).spendableMicro < JOB_CHECK_CREDITS * MICRO) { broke = true; return; }
    try {
      const res = await checkJobChange(ctx, { orgId: caller.orgId, profileUrl: p.linkedinUrl, company: p.company, maxCostUsd: JOB_CHECK_MAX_USD }, (r) => (r.status === 200 ? readJobChange(r.body) : null));
      const jc = res.found, callId = res.call;
      if (!jc) return;
      const ref = checkRef(caller.orgId, p.id, now);
      if (!(await ctx.runMutation(internal.credits.charge, { orgId, ref, amountMicro: JOB_CHECK_CREDITS * MICRO, note: `Job change check: ${p.fullName}` }))) { broke = true; return; }
      await ctx.runAction(internal.credits.meterCharge, { ref, provider: "leadmagic" }).catch((e) => console.warn(`job check: Metronome report failed: ${e instanceof Error ? e.message.slice(0, 160) : e}`));
      if (!jc.changed) return;
      const note = departureNote(p.company, jc);
      const [anchored] = await promoteContacts(ctx, sees, orgId, [p.id]);
      if (anchored) {
        await ctx.runMutation(internal.researchAgents.recordDeparture, {
          orgId, userId: caller.userId as Id<"users">, slug: employedSlug, recordId: p.id, entityId: anchored.entityId, evidence: departureEvidence(jc, p.linkedinUrl),
        });
      }
      // The old contact keeps the record of their time here.
      await ctx.runMutation(internal.canon.ensureCustomFields, { orgId, object: "contact", fields: [{ attribute: "custom.job_change", value: note }] });
      await editPartyRecord(await recordEditPorts(ctx, caller, {
        object: "contact", id: p.id, patch: { "custom.job_change": note }, idempotencyKey: `${ref}:left`, found: { provider: "leadmagic", callId },
      }, "edit"));
      const domain = jc.company ? await companyDomain({ name: jc.company, meta: { customer: caller.orgId, feature: "job_change" }, baseUrl: process.env.TREG_BASE_URL }).catch(() => null) : null;
      let movedTo: string | null = null;
      if (domain && jc.company) {
        const client = clientFor(ctx);
        await client.upsertAccounts(caller.orgId, { records: [{ domain, name: jc.company }], source: "job_change", idempotencyKey: `${ref}:account`, fill: "missing" });
        // Added by name, then given the profile: an upsert by profile URL would land on the old contact's id, which is the URL's.
        const added = await client.upsertContacts(caller.orgId, {
          records: [{ fullName: p.fullName, accountDomain: domain, ...(jc.title ? { title: jc.title } : {}) }],
          source: "job_change", idempotencyKey: `${ref}:contact`, fill: "missing",
        });
        const newId = added.ids[0];
        if (newId && newId !== p.id) {
          await editPartyRecord(await recordEditPorts(ctx, caller, {
            object: "contact", id: newId, patch: { linkedinUrl: p.linkedinUrl, "custom.job_change": arrivalNote(p.company, jc) },
            idempotencyKey: `${ref}:joined`, found: { provider: "leadmagic", callId },
          }, "edit"));
          // Only once the new contact holds the profile does the old one give it up. Cleared as the person's own edit:
          // a provider's value only fills a field, so it can't clear the row's.
          await editPartyRecord(await recordEditPorts(ctx, caller, { object: "contact", id: p.id, patch: { linkedinUrl: null }, idempotencyKey: `${ref}:unlink` }, "edit"));
          movedTo = jc.company;
        }
      }
      departures.push({ id: p.id, name: p.fullName, left: p.company, note, movedTo });
    } catch (error) {
      console.warn(`job check: ${p.fullName} failed: ${error instanceof Error ? error.message.slice(0, 200) : error}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PERSON_CONCURRENCY, queue.length) }, async () => {
    for (let p = queue.shift(); p && !broke; p = queue.shift()) await one(p);
  }));
  const moved = departures.map((d) => `${d.name}: ${d.note}${d.movedTo ? ` Added as a contact at ${d.movedTo}.` : ""}`);
  const short = broke ? "The workspace ran out of credits, so the rest weren't checked for job changes." : null;
  return { departures, note: [...moved, short].filter(Boolean).join(" ") || null };
}
