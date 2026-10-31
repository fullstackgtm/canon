import { ConvexError, v } from "convex/values";
import { action, internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { callerClient, requireCaller, type ActionCaller } from "./records";
import { getCurrentUser, withRole } from "./lib";
import { accessFor, roleIn } from "./permissions";
import { can } from "./lib/capabilities";
import { permissionOf, refuseLockedWrite, refuseNarrowed } from "./lib/access";
import { companyRootDomain } from "./lib/tam/siteExtract";
import { PEOPLE_LIMIT, peopleEstimate, personCredits, type KeptPerson } from "./lib/tam/companyPeople";
import { keptPerson } from "./lib/tam/companyPeopleValidator";
import { webPersonNameKey } from "./lib/tam/webPeople";
import { paidCallsAllowed } from "./lib/treg";
import { chargeHeldCredits, holdCredits, settleHold } from "./credits";
import { CREDIT_RATES, MICRO } from "./lib/creditPacks";
import { readIcps, type IcpRow } from "./lib/icpsInterface";

const runArgs = { runId: v.id("companyPeopleRuns") };
const holdRef = (id: string) => `company-people:${id}`;
export type PeopleRead = { canFind: boolean; estimateCredits: number; limit: number; paid: boolean; run: Doc<"companyPeopleRuns"> | null; contacts: KeptPerson[] };
export type PeopleInputs = { run: Doc<"companyPeopleRuns">; caller: ActionCaller; icp: IcpRow | null; facts: Doc<"companyWebFacts"> | null; address?: string; placeId?: string };
export function requirePeopleAccess(caller: ActionCaller) {
  if (!can(caller, "imports.run") || !permissionOf(caller.access, "contact").create || !permissionOf(caller.access, "contact").edit) throw new ConvexError("Your role cannot find and add contacts.");
  refuseNarrowed(caller.access, "Find people");
  refuseLockedWrite(caller.access, "contact", ["fullName", "title", "email", "emailStatus", "linkedinUrl"]);
}
async function principal(ctx: QueryCtx, run: Doc<"companyPeopleRuns">) {
  const original = await ctx.db.get(run.userId);
  const role = original && await roleIn(ctx, original, run.orgId);
  const user = original && role && await withRole(ctx, { ...original, orgId: run.orgId, role });
  if (!user) throw new ConvexError("The run's owner is unavailable.");
  const caller = { orgId: user.orgId, userId: user._id, name: user.name, role: user.role, capabilities: user.capabilities, access: await accessFor(ctx, user) };
  requirePeopleAccess(caller);
  return caller;
}
export const read = action({
  args: { accountId: v.string() },
  handler: async (ctx, { accountId }): Promise<PeopleRead> => {
    const caller = await requireCaller(ctx, { read: true });
    const account = await callerClient(ctx, caller).get(caller.orgId, accountId);
    if (!account) throw new ConvexError("Company not found.");
    let canFind = true;
    try { requirePeopleAccess(caller); } catch { canFind = false; }
    const history = canFind ? await ctx.runQuery(internal.companyPeople.latest, { orgId: caller.orgId as Id<"organizations">, accountId, domain: companyRootDomain(account.account.domain) ?? "" }) : null;
    return { canFind, estimateCredits: paidCallsAllowed() ? peopleEstimate() : PEOPLE_LIMIT * CREDIT_RATES.contact, limit: PEOPLE_LIMIT, paid: paidCallsAllowed(), run: history?.run ?? null, contacts: (history?.contacts ?? []).filter((p) => account.contacts.some((c) => c.id === p.contactId)) };
  },
});
export const start = action({
  args: { accountId: v.string(), icpId: v.optional(v.string()) },
  handler: async (ctx, a): Promise<Id<"companyPeopleRuns">> => {
    const caller = await requireCaller(ctx);
    requirePeopleAccess(caller);
    const detail = await callerClient(ctx, caller).get(caller.orgId, a.accountId);
    const domain = detail && companyRootDomain(detail.account.domain);
    if (!domain) throw new ConvexError("This company needs a public website domain.");
    const icpId = a.icpId ?? detail?.account.icpIds?.[0];
    return ctx.runMutation(internal.companyPeople.begin, { accountId: a.accountId, domain, ...(icpId ? { icpId } : {}) });
  },
});
export const latest = internalQuery({
  args: { orgId: v.id("organizations"), accountId: v.string(), domain: v.string() },
  handler: async (ctx, a): Promise<{ run: Doc<"companyPeopleRuns"> | null; contacts: KeptPerson[] }> => {
    const runs = await ctx.db.query("companyPeopleRuns").withIndex("by_orgId_and_accountId", (q) => q.eq("orgId", a.orgId).eq("accountId", a.accountId)).order("desc").take(20);
    const contacts = new Map<string, KeptPerson>();
    for (const run of runs.filter((r) => r.domain === a.domain)) for (const person of run.people) {
      if (await ctx.db.query("webPeopleSuppressions").withIndex("by_domain_and_nameKey", (q) => q.eq("domain", a.domain).eq("nameKey", webPersonNameKey(person.fullName))).unique()) continue;
      if (!contacts.has(person.contactId)) contacts.set(person.contactId, person);
    }
    return { run: runs[0] ?? null, contacts: [...contacts.values()] };
  },
});
export const begin = internalMutation({
  args: { accountId: v.string(), domain: v.string(), icpId: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new ConvexError("Not authenticated.");
    const prior = await ctx.db.query("companyPeopleRuns").withIndex("by_orgId_and_accountId", (q) => q.eq("orgId", user.orgId).eq("accountId", a.accountId)).order("desc").first();
    if (prior && ["queued", "running"].includes(prior.status)) return prior._id;
    const icps = await readIcps(ctx, user.orgId);
    const icp = a.icpId ? icps.find((i) => i.key === a.icpId) : icps.find((i) => i.active);
    if (a.icpId && !icp) throw new ConvexError("ICP not found.");
    const now = Date.now(), cap = paidCallsAllowed() ? peopleEstimate() : PEOPLE_LIMIT * CREDIT_RATES.contact;
    const jobId = await ctx.db.insert("backgroundJobs", { orgId: user.orgId, kind: "contact_sweep", title: "Find people", detail: "Finding the company's buyers", href: `/dashboard/accounts/${encodeURIComponent(a.accountId)}`, status: "processing", phases: [], counters: { cap_micro: cap * MICRO, spent_micro: 0 }, startedAt: now, updatedAt: now });
    const runId = await ctx.db.insert("companyPeopleRuns", { accountId: a.accountId, domain: a.domain, ...(icp ? { icpId: icp.key } : {}), orgId: user.orgId, userId: user._id, jobId, status: "queued", people: [], notes: [], sourceCounts: {}, spentCredits: 0, createdAt: now });
    const run = (await ctx.db.get(runId))!;
    await principal(ctx, run);
    const held = await holdCredits(ctx, { orgId: user.orgId, spender: { jobId }, ref: holdRef(runId), amountMicro: cap * MICRO, note: "Find people reservation" });
    if (!held.ok) throw new ConvexError("This workspace needs more credits to find people.");
    await ctx.scheduler.runAfter(0, internal.companyPeopleWorker.run, { runId });
    await ctx.scheduler.runAfter(9 * 60_000, internal.companyPeople.finish, { runId, failed: true, notes: ["The run timed out. Kept contacts remain and unused credits were returned."] });
    return runId;
  },
});
export const claim = internalMutation({ args: runArgs, handler: async (ctx, { runId }) => {
  const run = await ctx.db.get(runId);
  if (!run || run.status !== "queued") return false;
  await principal(ctx, run);
  await ctx.db.patch(runId, { status: "running" });
  return true;
} });
export const inputs = internalQuery({ args: runArgs, handler: async (ctx, { runId }): Promise<PeopleInputs | null> => {
  const run = await ctx.db.get(runId);
  if (!run || run.status !== "running") return null;
  const caller = await principal(ctx, run);
  const icp = (await readIcps(ctx, run.orgId)).find((i) => i.key === run.icpId);
  const facts = await ctx.db.query("companyWebFacts").withIndex("by_domain", (q) => q.eq("domain", run.domain)).unique();
  const candidate = await ctx.db.query("tamCandidates").withIndex("by_orgId_and_keys_domain_and_state", (q) => q.eq("orgId", run.orgId).eq("keys.domain", run.domain).eq("state", "kept")).first();
  return { run, caller, icp: icp ?? null, facts, address: candidate?.address ?? facts?.addresses[0]?.text, placeId: candidate?.keys.placeId };
} });
export const suppressed = internalQuery({
  args: { domain: v.string(), name: v.string() },
  handler: async (ctx, a) => Boolean(await ctx.db.query("webPeopleSuppressions").withIndex("by_domain_and_nameKey", (q) => q.eq("domain", a.domain).eq("nameKey", webPersonNameKey(a.name))).unique()),
});
export const saved = internalMutation({
  args: { ...runArgs, person: keptPerson },
  handler: async (ctx, { runId, person }) => {
    const run = await ctx.db.get(runId);
    if (!run || run.status !== "running" || run.people.some((p) => p.contactId === person.contactId)) return;
    const credits = personCredits(person);
    await chargeHeldCredits(ctx, { holdRef: holdRef(runId), ref: `${holdRef(runId)}:${person.contactId}`, amountMicro: credits * MICRO, note: `Find people kept ${person.fullName}` });
    await ctx.db.patch(runId, { people: [...run.people, person], spentCredits: run.spentCredits + credits, sourceCounts: { ...run.sourceCounts, [person.source]: (run.sourceCounts[person.source] ?? 0) + 1 } });
  },
});
export const finish = internalMutation({
  args: { ...runArgs, failed: v.boolean(), notes: v.array(v.string()) },
  handler: async (ctx, a) => {
    const run = await ctx.db.get(a.runId);
    if (!run || !["queued", "running"].includes(run.status)) return;
    await settleHold(ctx, { ref: holdRef(run._id), chargeMicro: 0 });
    await ctx.db.patch(run._id, { status: a.failed ? "failed" : "done", notes: a.notes, completedAt: Date.now() });
    await ctx.db.patch(run.jobId, { status: a.failed ? "failed" : "completed", detail: `${run.people.length} contacts kept. ${run.spentCredits} credits charged.`, updatedAt: Date.now(), completedAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.credits.meterRun, { spender: { jobId: run.jobId }, provider: "company_people" });
  },
});
