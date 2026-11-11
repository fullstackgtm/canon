/**
 * Finding a deal's missing company and people (convex/dealGaps.ts records them, lib/deals/gaps.ts plans them).
 *
 * `check` reads only what Canon holds, at no cost: the CRM and the owner's conversations and meetings. It runs on
 * its own when a deal is created or loses its company, from a deal page's "Check again", and over a person's open
 * deals from "Find missing companies and people". `search` looks outside, through treg's free CompanyEnrich and
 * QuickEnrich lookups ($0 ceiling), and runs only when a person presses Search on a deal: never in the background.
 */
import { ConvexError, v } from "convex/values";
import { action, internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { principalClient, requireCaller } from "./records";
import type { RecordClient } from "./lib/recordClient";
import { may, type Access } from "./lib/access";
import { peopleOfCompany, rowsById } from "./associations";
import { coreName, GAP_PEOPLE_MAX, namesMatch, planGaps, sourceMatches, type GapProposal } from "./lib/deals/gaps";
import { isOurSide, nameFromDomain, teamOf } from "./lib/calls/suggestions";
import { companyDomain, peoplePage, tregKey } from "./lib/providers/treg";
import { LIST_LIMIT_MAX } from "./lib/objects/listSpec";

/** Conversations and meetings about one deal that its proposals read. */
const SOURCES_MAX = 20;
/** Deals one "Find missing companies and people" checks. */
const SCAN_MAX = 100;

const str = (x: unknown) => (typeof x === "string" && x ? x : null);

/** Register rows whose `field` is one of `values` (lowercased), by that value. */
async function byField(client: RecordClient, orgId: string, object: "account" | "contact", field: "domain" | "email", values: string[]) {
  const out = new Map<string, { id: string; title: string; accountId: string | null }>();
  const unique = [...new Set(values)].slice(0, LIST_LIMIT_MAX);
  if (!unique.length) return out;
  const page = await client.listRegister(orgId, object, { filter: [{ field, op: "in", value: unique }], limit: unique.length });
  for (const r of page.rows) {
    const value = str(r.values[field])?.toLowerCase();
    if (value) out.set(value, { id: r.id, title: r.title, accountId: r.accountId ?? str(r.values.accountId) });
  }
  return out;
}

/** Look for one deal's missing company and people in the CRM and its owner's conversations; record what is found. */
async function checkDeal(ctx: ActionCtx, orgId: Id<"organizations">, streamId: string): Promise<number> {
  const deal = await ctx.runQuery(internal.dealGaps.dealOf, { orgId, streamId });
  if (!deal) return 0;
  const onDeal = await ctx.runQuery(internal.dealCommittee.dealPeople, { orgId, userId: deal.ownerId, streamId });
  const memberIds = (onDeal?.members ?? []).map((m) => m.contactId);
  if (deal.companyId && memberIds.length) return 0;
  const client = principalClient(ctx, orgId, [deal.ownerAccess as Access]);
  const people = [...(await rowsById(client, orgId, "contact", memberIds)).values()]
    .map((r) => ({ id: r.id, name: r.title || r.id, accountId: r.accountId ?? str(r.values.accountId) }));
  const own = deal.companyId ? (await rowsById(client, orgId, "account", [deal.companyId])).get(deal.companyId) : undefined;
  const companyDomain = own ? str(own.values.domain)?.toLowerCase() ?? null : null;

  const team = await ctx.runQuery(internal.conversations.emailTeam, { orgId });
  const ourTeam = teamOf(team.memberEmails, team.ourTeam);
  const ourSide = (email: string) => isOurSide(ourTeam, email);
  const all = await ctx.runQuery(internal.dealGaps.sourcesOf, { orgId, userId: deal.ownerId, dealId: deal.dealId });
  const sources = all.filter((s) => sourceMatches({ name: deal.name, contactIds: memberIds, companyDomain }, s)).slice(0, SOURCES_MAX);
  const emails = sources.flatMap((s) => s.people.flatMap((p) => (p.email && !ourSide(p.email) ? [p.email.toLowerCase()] : [])));
  const domains = emails.map((e) => e.slice(e.lastIndexOf("@") + 1));

  // A company named like the deal: the register's search, held to the same name rule as a conversation's domain.
  const namedLike = deal.companyId ? [] : (await client.searchObjects(orgId, { q: coreName(deal.name), objects: ["account"], limit: 5 }))
    .hits.filter((h) => namesMatch(deal.name, h.title)).map((h) => h.id);
  const [knownDomains, knownEmails] = await Promise.all([
    deal.companyId ? Promise.resolve(new Map<string, { id: string }>()) : byField(client, orgId, "account", "domain", domains),
    memberIds.length ? Promise.resolve(new Map<string, { id: string; title: string }>()) : byField(client, orgId, "contact", "email", emails),
  ]);
  const companyIds = [...people.map((p) => p.accountId).filter((x): x is string => Boolean(x)), ...namedLike, ...[...knownDomains.values()].map((r) => r.id)];
  const companies = new Map([...(await rowsById(client, orgId, "account", companyIds)).values()]
    .map((r) => [r.id, { name: r.title || r.id, domain: str(r.values.domain) }] as const));
  const companyPeople = deal.companyId && !memberIds.length
    ? (await peopleOfCompany(ctx, client, orgId, deal.companyId)).slice(0, GAP_PEOPLE_MAX).map((p) => ({ id: p.id, name: p.name, title: p.title }))
    : [];

  const proposals = planGaps({
    deal: { name: deal.name, companyId: deal.companyId, companyName: own?.title ?? null },
    people, companies, namedLike,
    knownDomains: new Map([...knownDomains].map(([d, r]) => [d, r.id])),
    knownEmails: new Map([...knownEmails].map(([e, r]) => [e, { id: r.id, name: r.title }])),
    companyPeople, sources, ourSide,
  });
  if (!proposals.length) return 0;
  return ctx.runMutation(internal.dealGaps.record, { orgId, userId: deal.ownerId, streamId, proposals });
}

/** The scheduled check after a deal is created or loses its company. */
export const check = internalAction({
  args: { orgId: v.id("organizations"), streamId: v.string() },
  handler: (ctx, args): Promise<number> => checkDeal(ctx, args.orgId, args.streamId),
});

/** A deal the caller sees, and its owner's id: what checking or searching it from the deal page needs. */
async function visibleDeal(ctx: ActionCtx, streamId: string) {
  const caller = await requireCaller(ctx);
  const orgId = caller.orgId as Id<"organizations">;
  const seen = await ctx.runQuery(internal.dealCommittee.dealPeople, { orgId, userId: caller.userId as Id<"users">, streamId, access: caller.access });
  const deal = seen ? await ctx.runQuery(internal.dealGaps.dealOf, { orgId, streamId }) : null;
  if (!seen || !deal) throw new ConvexError("Deal not found, or it is closed");
  return { caller, orgId, deal, canEdit: seen.canEdit };
}

/** "Check again" on a deal page: look through the CRM and conversations now. */
export const checkNow = action({
  args: { streamId: v.string() },
  handler: async (ctx, args): Promise<number> => {
    const { orgId } = await visibleDeal(ctx, args.streamId);
    return checkDeal(ctx, orgId, args.streamId);
  },
});

/** "Find missing companies and people": every open deal of the caller's with a gap, reported in the background tray. */
export const scanMine = action({
  args: {},
  handler: async (ctx): Promise<{ deals: number; proposals: number }> => {
    const caller = await requireCaller(ctx);
    const orgId = caller.orgId as Id<"organizations">;
    const userId = caller.userId as Id<"users">;
    const deals = (await ctx.runQuery(internal.dealGaps.gapDealsOf, { orgId, userId })).slice(0, SCAN_MAX);
    const phase = (status: "processing" | "completed" | "failed", done: number) => [{ key: "deals", label: "Deals checked", status, done, total: deals.length }];
    const jobId = await ctx.runMutation(internal.backgroundJobs.create, {
      orgId, userId, kind: "deal_gaps", title: "Finding deals' missing companies and people", href: "/dashboard/deals", phases: phase("processing", 0),
    });
    let proposals = 0;
    try {
      for (const [i, streamId] of deals.entries()) {
        proposals += await checkDeal(ctx, orgId, streamId).catch((cause) => {
          console.log(`deal-gaps: ${streamId} failed (${cause instanceof Error ? cause.message.slice(0, 160) : "error"})`);
          return 0;
        });
        if (i % 5 === 4) await ctx.runMutation(internal.backgroundJobs.update, { jobId, phases: phase("processing", i + 1), detail: `${proposals} proposals so far` });
      }
      await ctx.runMutation(internal.backgroundJobs.update, { jobId, status: "completed", phases: phase("completed", deals.length), detail: `${proposals} proposals from ${deals.length} deals` });
    } catch (cause) {
      await ctx.runMutation(internal.backgroundJobs.update, { jobId, status: "failed", phases: phase("failed", 0), error: cause instanceof Error ? cause.message : "failed" });
      throw cause;
    }
    return { deals: deals.length, proposals };
  },
});

/**
 * Search on a deal's card: the company by the deal's name (CompanyEnrich), or people at the deal's company or its
 * proposed one (QuickEnrich). Both are treg's free lookups, run only because a person pressed the button.
 */
export const search = action({
  args: { streamId: v.string(), kind: v.union(v.literal("account"), v.literal("contact")) },
  handler: async (ctx, args): Promise<{ added: number; message: string }> => {
    const { caller, orgId, deal } = await visibleDeal(ctx, args.streamId);
    if (!may(caller.access, args.kind, "create")) throw new ConvexError(`Your role cannot create ${args.kind === "account" ? "company" : "person"} records`);
    if (!tregKey("people.search")) throw new ConvexError("Search is not configured on this deployment (TREG_TOKEN is missing)");
    const meta = { customer: orgId, feature: "deal_gaps" };
    const baseUrl = process.env.TREG_BASE_URL;
    const name = coreName(deal.name);
    const proposals: GapProposal[] = [];
    if (args.kind === "account") {
      if (deal.companyId) return { added: 0, message: "This deal has a company" };
      const domain = await companyDomain({ name, meta, baseUrl, timeoutMs: 20_000 });
      if (!domain) return { added: 0, message: `No company named “${name}” found. Add its website on the deal instead.` };
      const known = (await byField(principalClient(ctx, orgId, [deal.ownerAccess as Access]), orgId, "account", "domain", [domain])).get(domain);
      proposals.push({
        kind: "account", key: known ? `match:${known.id}` : `domain:${domain}`, ...(known ? { matchId: known.id } : {}),
        values: { name: known?.title ?? name, domain }, via: "search", evidence: `Company search: “${name}” is ${domain}`,
      });
    } else {
      const domain = await ctx.runQuery(internal.dealGaps.companyDomainOf, { orgId, streamId: args.streamId })
        ?? (deal.companyId ? str((await rowsById(principalClient(ctx, orgId, [deal.ownerAccess as Access]), orgId, "account", [deal.companyId])).get(deal.companyId)?.values.domain) : null);
      if (!domain) return { added: 0, message: "Find the deal's company first: people are searched at its website" };
      const page = await peoplePage({ query: { company_url: { include: [domain], exclude: [] } }, meta, baseUrl, countryName: () => undefined });
      for (const p of page.people.slice(0, GAP_PEOPLE_MAX)) {
        if (!p.linkedinUrl) continue;
        proposals.push({
          kind: "contact", key: `linkedin:${p.linkedinUrl}`, via: "search", evidence: `People search at ${domain}`,
          values: { name: p.fullName, domain, companyName: p.company.name ?? nameFromDomain(domain), linkedinUrl: p.linkedinUrl, ...(p.title ? { title: p.title } : {}) },
        });
      }
      if (!proposals.length) return { added: 0, message: `No one found at ${domain}` };
    }
    const added = await ctx.runMutation(internal.dealGaps.record, { orgId, userId: deal.ownerId, streamId: args.streamId, proposals });
    return { added, message: added ? `Found ${added} to review` : "Nothing new: already proposed, accepted or dismissed" };
  },
});
