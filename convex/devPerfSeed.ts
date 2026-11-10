import { ConvexError, v } from "convex/values";
import { internalAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { DEV_USER_CLERK_ID, isDevAuthBypassEnabled } from "./lib";
import { clientFor } from "./records";
import { accountExternalIds, contactExternalIds } from "./lib/canon/identity";
import { saveDealValues, saveDeal, SYNCED_DEAL_ATTRIBUTES, saveParty } from "./canon";
import { saveAsCaller } from "./objects";
import type { DealValues } from "./lib/canon/dealLedger";

const AT = Date.parse("2026-10-01T12:00:00Z");
const DOMAIN = "perf-northwind-v2.example";
function guard() {
  // The demo flag alone is set in the self-host smoke container too; require the local stack.
  if (!isDevAuthBypassEnabled() || process.env.CANONCRM_LOCAL_STACK !== "true") throw new ConvexError("Demo workspace seeding is disabled");
}

export const seed = internalAction({
  args: {},
  handler: async (ctx): Promise<{ accountId: string; contactId: string; accountStream: string; contactStream: string; dealId: string; domain: string }> => {
    guard();
    const orgId = await ctx.runMutation(internal.devSeed.devOrgId, {});
    if (!orgId) throw new Error("Start the local stack first");
    const client = clientFor(ctx);
    if (client.mode !== "http") throw new Error("Perf requires the real local record service");
    const account = await client.upsertAccounts(orgId, { records: [{ domain: DOMAIN, name: "Northwind Analytics", industry: "Software", employees: 1250, country: "United States", linkedinUrl: "https://linkedin.com/company/northwind", status: "working" }], source: "dev-perf", idempotencyKey: "perf-account-v2" });
    const accountId = account.ids[0];
    const contacts = await client.upsertContacts(orgId, { records: Array.from({ length: 20 }, (_, i) => ({ accountId, fullName: `Northwind Stakeholder ${i.toString().padStart(2, "0")}`, title: "VP Revenue Operations", email: `stakeholder${i}@${DOMAIN}`, linkedinUrl: `https://linkedin.com/in/northwind-${i}` })), source: "dev-perf", idempotencyKey: "perf-contacts-v2" });
    return ctx.runMutation(internal.devPerfSeed.seedDb, { accountId, contactIds: contacts.ids });
  },
});

export const seedDb = internalMutation({
  args: { accountId: v.string(), contactIds: v.array(v.string()) },
  handler: async (ctx, { accountId, contactIds }) => {
    guard();
    const user = await ctx.db.query("users").withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", DEV_USER_CLERK_ID)).unique();
    if (!user) throw new Error("Seed the demo workspace first");
    if (!await ctx.db.query("companyWebFacts").withIndex("by_domain", (q) => q.eq("domain", DOMAIN)).unique()) await ctx.db.insert("companyWebFacts", { domain: DOMAIN, status: "ok", fetchedAt: AT, pages: [{ kind: "home", url: `https://${DOMAIN}` }], socials: [], addresses: [], staff: [], sizeCluesVersion: 1, emails: [] });
    const prior = await ctx.db.query("canonEntities").withIndex("by_orgId_projectionId", (q) => q.eq("orgId", user.orgId).eq("projectionId", accountId)).first();
    const seededDeal = await ctx.db.query("deals").withIndex("by_orgId_crmId", (q) => q.eq("orgId", user.orgId).eq("crmId", "perf-v2-0")).first();
    const deal = seededDeal ? await ctx.db.query("canonEntities").withIndex("by_orgId_projectionId", (q) => q.eq("orgId", user.orgId).eq("projectionId", seededDeal._id)).first() : null;
    const contact = await ctx.db.query("canonEntities").withIndex("by_orgId_projectionId", (q) => q.eq("orgId", user.orgId).eq("projectionId", contactIds[0])).first();
    if (prior && deal && contact) return { accountId, contactId: contactIds[0], accountStream: prior._id, contactStream: contact._id, dealId: deal._id, domain: DOMAIN };
    const source = { kind: "import" as const, ref: "perf-v1", actorId: user._id };
    const account = await saveParty(ctx, { orgId: user.orgId, object: "account", identity: { projectionTable: "recordAccounts", projectionId: accountId, label: "Northwind Analytics", externalIds: accountExternalIds({ domain: DOMAIN, recordId: accountId }) }, source, values: { name: "Northwind Analytics", domain: DOMAIN, industry: "Software", employees: 1250, country: "United States", status: "working", ownerId: user._id }, now: AT, seed: null });
    let contactStream = "";
    for (const [i, id] of contactIds.entries()) {
      const c = await saveParty(ctx, { orgId: user.orgId, object: "contact", identity: { projectionTable: "recordContacts", projectionId: id, label: `Northwind Stakeholder ${i.toString().padStart(2, "0")}`, externalIds: contactExternalIds({ recordId: id, email: `stakeholder${i}@${DOMAIN}` }) }, source, values: { fullName: `Northwind Stakeholder ${i.toString().padStart(2, "0")}`, email: `stakeholder${i}@${DOMAIN}`, title: "VP Revenue Operations" }, now: AT, seed: null });
      if (!i) contactStream = c.entityId;
    }
    let dealId = "";
    for (let i = 0; i < 12; i++) {
      const id = await ctx.db.insert("deals", { orgId: user.orgId, name: `Northwind enterprise ${i.toString().padStart(2, "0")}`, amount: 12500000 + i * 10000, currency: "USD", stage: "qualification", isClosed: false, isWon: false, dealType: "expansion", revenueType: "recurring", companyId: accountId, primaryRepId: user._id, crmId: `perf-v2-${i}`, crmProvider: "hubspot", products: ["Enterprise analytics"], competitorMentioned: ["Legacy BI"], rawData: {}, lastSyncAt: AT, createdAt: AT, updatedAt: AT, closeDate: "2026-12-15", forecastCategory: "pipeline", probability: 40 });
      const row = (await ctx.db.get(id))!;
      const result = await saveDeal(ctx, row, { kind: "hubspot", crmId: row.crmId!, rawData: {} }, SYNCED_DEAL_ATTRIBUTES, AT);
      const values: DealValues & { description: string } = { companyId: accountId, description: "Enterprise analytics rollout. Security and procurement review complete. ".repeat(8) };
      await saveDealValues(ctx, row, { kind: "hubspot", crmId: row.crmId!, rawData: {} }, values, { now: AT });
      if (!i) dealId = result.entityId;
    }
    for (let i = 0; i < 40; i++) {
      const result = await saveAsCaller(ctx, user, "call", { op: "create", values: { subject: `Discovery and implementation ${i.toString().padStart(2, "0")}`, notes: "Discussed stakeholders, deployment, security review and next steps. ".repeat(20), accountId, contactId: contactIds[i % 20], dealId, durationSeconds: 1800, direction: "outbound" } });
      if (result.status !== "applied") throw new Error(JSON.stringify(result));
    }
    for (let i = 0; i < 100; i++) await saveParty(ctx, { orgId: user.orgId, object: "account", identity: { entityId: account.entityId }, source: { ...source, ref: `perf-evidence-${i}` }, values: { employees: 1150 + i }, evidence: `Northwind annual report ${i}: team growth in operations and engineering.`, now: AT + i + 1, seed: null });
    return { accountId, contactId: contactIds[0], accountStream: account.entityId, contactStream, dealId, domain: DOMAIN };
  },
});
