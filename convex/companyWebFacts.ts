import { v } from "convex/values";
import { action, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { callerClient, requireCaller } from "./records";
import { companyRootDomain, type CompanyWebFacts } from "./lib/tam/siteExtract";
import { companyWebFactsFields } from "./lib/tam/companyWebFactsValidator";
import { webPersonNameKey } from "./lib/tam/webPeople";
import type { CandidateSource } from "./lib/tam/dedupe";

const MAX_AGE = 90 * 24 * 60 * 60 * 1000;
export type WebsiteFactsRead = { domain: string; reading: boolean; facts: CompanyWebFacts | null; discoverySources?: CandidateSource[]; recordSize?: { employees?: number; url: string } };

/** Account access is checked on every read, including each poll while extraction runs. */
export const forAccount = action({
  args: { accountId: v.string() },
  handler: async (ctx, { accountId }): Promise<WebsiteFactsRead | null> => {
    const caller = await requireCaller(ctx, { read: true });
    const detail = await callerClient(ctx, caller).get(caller.orgId, accountId);
    if (!detail) return null;
    const domain = companyRootDomain(detail.account.domain);
    if (!domain) return null;
    const result = await ctx.runMutation(internal.companyWebFacts.readAndEnsure, { domain, refresh: !caller.access.preview });
    const discoverySources = await ctx.runQuery(internal.tamInvestigations.sourcesForDomain, { orgId: caller.orgId as Id<"organizations">, domain });
    return { ...result, discoverySources, recordSize: { ...(detail.account.employees !== undefined ? { employees: detail.account.employees } : {}), url: `/dashboard/accounts/${encodeURIComponent(accountId)}` } };
  },
});

export const readAndEnsure = internalMutation({
  args: { domain: v.string(), refresh: v.boolean() },
  handler: async (ctx, { domain, refresh }): Promise<WebsiteFactsRead> => {
    const facts = await ctx.db.query("companyWebFacts").withIndex("by_domain", (q) => q.eq("domain", domain)).unique();
    let marker = await ctx.db.query("companyWebFactReads").withIndex("by_domain", (q) => q.eq("domain", domain)).unique();
    if (refresh && !marker && (!facts || facts.staff === undefined || (facts.status === "ok" && facts.sizeCluesVersion !== 1) || Date.now() - facts.fetchedAt > MAX_AGE)) {
      const startedAt = Date.now();
      const id = await ctx.db.insert("companyWebFactReads", { domain, startedAt });
      marker = await ctx.db.get(id);
      await ctx.scheduler.runAfter(0, internal.companyWebFactsFetch.extract, { domain, startedAt });
      // A killed action cannot leave every later viewer stuck on "Reading".
      await ctx.scheduler.runAfter(5 * 60_000, internal.companyWebFacts.expire, { domain, startedAt });
    }
    return { domain, reading: Boolean(marker), facts };
  },
});

export const finish = internalMutation({
  args: { facts: v.object(companyWebFactsFields), startedAt: v.number() },
  handler: async (ctx, { facts, startedAt }) => {
    const marker = await ctx.db.query("companyWebFactReads").withIndex("by_domain", (q) => q.eq("domain", facts.domain)).unique();
    if (!marker || marker.startedAt !== startedAt) return;
    const staff = [];
    for (const person of (facts.staff ?? []).slice(0, 25)) {
      const suppressed = await ctx.db.query("webPeopleSuppressions").withIndex("by_domain_and_nameKey", (q) => q.eq("domain", facts.domain).eq("nameKey", webPersonNameKey(person.fullName))).unique();
      if (!suppressed) staff.push(person);
    }
    facts = { ...facts, staff };
    const old = await ctx.db.query("companyWebFacts").withIndex("by_domain", (q) => q.eq("domain", facts.domain)).unique();
    if (old) await ctx.db.replace(old._id, facts);
    else await ctx.db.insert("companyWebFacts", facts);
    await ctx.db.delete(marker._id);
  },
});

export const expire = internalMutation({
  args: { domain: v.string(), startedAt: v.number() },
  handler: async (ctx, { domain, startedAt }) => {
    const marker = await ctx.db.query("companyWebFactReads").withIndex("by_domain", (q) => q.eq("domain", domain)).unique();
    if (!marker || marker.startedAt !== startedAt) return;
    const facts: CompanyWebFacts = { domain, status: "error", error: "The website read timed out.", fetchedAt: Date.now(), pages: [], socials: [], addresses: [], emails: [], staff: [] };
    const old = await ctx.db.query("companyWebFacts").withIndex("by_domain", (q) => q.eq("domain", domain)).unique();
    if (old) await ctx.db.replace(old._id, facts);
    else await ctx.db.insert("companyWebFacts", facts);
    await ctx.db.delete(marker._id);
  },
});

export const erasePerson = internalMutation({
  args: { domain: v.string(), fullName: v.string(), reason: v.string() },
  handler: async (ctx, { domain: rawDomain, fullName, reason }) => {
    const domain = companyRootDomain(rawDomain), nameKey = webPersonNameKey(fullName);
    if (!domain || !nameKey || !reason.trim()) throw new Error("Domain, name and deletion reason are required.");
    const existing = await ctx.db.query("webPeopleSuppressions").withIndex("by_domain_and_nameKey", (q) => q.eq("domain", domain).eq("nameKey", nameKey)).unique();
    if (!existing) await ctx.db.insert("webPeopleSuppressions", { domain, nameKey, reason, createdAt: Date.now() });
    const facts = await ctx.db.query("companyWebFacts").withIndex("by_domain", (q) => q.eq("domain", domain)).unique();
    const staff = (facts?.staff ?? []).filter((person) => webPersonNameKey(person.fullName) !== nameKey);
    const removed = (facts?.staff?.length ?? 0) - staff.length;
    if (facts) await ctx.db.patch(facts._id, { staff });
    return { domain, removed };
  },
});
