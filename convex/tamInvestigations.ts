import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireCap } from "./lib";
import { accessFor } from "./permissions";
import { refuseNarrowed } from "./lib/access";
import { readIcps, type IcpRow } from "./lib/icpsInterface";
import { chargeHeldCredits, creditState, holdCredits, settleHold } from "./credits";
import { CREDIT_RATES, MICRO, creditMonth } from "./lib/creditPacks";
import { addStagedBatch, createStagedRun, readyRun } from "./staging";
import { appendEvent, creditReservation, INVESTIGATION_TRIGGERS, transition, type InvestigationStatus, type InvestigationTrigger } from "./lib/tam/investigation";
import { candidateKeys, dedupeCandidates, unionSources } from "./lib/tam/dedupe";
import { candidateFields, planSource } from "./lib/tam/investigationValidator";
import { catalogAllowsFetch } from "./lib/tam/sourceCatalog";
import { paidCallsAllowed } from "./lib/treg";
import { insertIcp } from "./icps";

const args = { investigationId: v.id("tamInvestigations") };
async function manager(ctx: QueryCtx | MutationCtx) {
  const user = await requireCap(ctx, "imports.run");
  refuseNarrowed(await accessFor(ctx, user), "Map my market");
  return user;
}
async function owned(ctx: QueryCtx | MutationCtx, id: Id<"tamInvestigations">) {
  const user = await manager(ctx), run = await ctx.db.get(id);
  if (!run || run.orgId !== user.orgId) throw new ConvexError("Investigation not found.");
  return run;
}
export const read = query({
  args: { investigationId: v.optional(v.id("tamInvestigations")) },
  handler: async (ctx, a) => {
    let user;
    try { user = await manager(ctx); } catch { return { canMap: false, run: null }; }
    const run = a.investigationId ? await owned(ctx, a.investigationId) : await ctx.db.query("tamInvestigations").withIndex("by_orgId_and_createdAt", (q) => q.eq("orgId", user.orgId)).order("desc").first();
    const candidates: Doc<"tamCandidates">[] = [];
    if (run) for (const state of ["kept", "rejected", "duplicate", "found"] as const) {
      if (candidates.length === 100) break;
      candidates.push(...await ctx.db.query("tamCandidates").withIndex("by_investigationId_and_state", (q) => q.eq("investigationId", run._id).eq("state", state)).take(100 - candidates.length));
    }
    return { canMap: true, run: run ? { ...run, candidates } : null };
  },
});
export const signupBanner = query({
  args: {},
  handler: async (ctx) => {
    let user;
    try { user = await manager(ctx); } catch { return null; }
    const org = await ctx.db.get(user.orgId);
    if (org?.signupInvestigation?.state !== "started") return null;
    const run = await ctx.db.get(org.signupInvestigation.investigationId);
    if (!run || run.orgId !== user.orgId) return null;
    return { _id: run._id, status: run.status, sourceCount: run.plan.sources.length, kept: run.counts.kept, freeOnly: run.freeOnly, spentCredits: run.spentCredits };
  },
});
export const plan = mutation({
  args: { icpId: v.optional(v.string()), capCredits: v.optional(v.number()) },
  handler: async (ctx, a) => {
    const user = await manager(ctx), capCredits = a.capCredits ?? INVESTIGATION_TRIGGERS.manual.capCredits;
    creditReservation(0, capCredits);
    const icps = await readIcps(ctx, user.orgId);
    const icp = a.icpId ? icps.find((i) => i.key === a.icpId) : icps.find((i) => i.active);
    if (!icp) throw new ConvexError("Choose an ICP before mapping your market.");
    const recent = await ctx.db.query("tamInvestigations").withIndex("by_orgId_and_createdAt", (q) => q.eq("orgId", user.orgId)).order("desc").take(20);
    const active = recent.find((r) => ["planning", "awaiting_start", "running", "paused_at_cap"].includes(r.status));
    if (active) return active._id;
    return createInvestigation(ctx, user, icp, "manual", capCredits);
  },
});
async function createInvestigation(ctx: MutationCtx, user: Pick<Doc<"users">, "_id" | "orgId">, icp: IcpRow, trigger: InvestigationTrigger, capCredits: number) {
  const now = Date.now();
  const jobId = await ctx.db.insert("backgroundJobs", { orgId: user.orgId, kind: "contact_sweep", title: `Map ${icp.name}`, href: "/dashboard/icps", status: "pending", phases: [], startedAt: now, updatedAt: now, counters: { cap_micro: capCredits * MICRO, spent_micro: 0 } });
  const id = await ctx.db.insert("tamInvestigations", { orgId: user.orgId, jobId, icpId: icp.key, trigger, freeOnly: INVESTIGATION_TRIGGERS[trigger].freeOnly, status: "planning", plan: { sources: [] }, estimateCredits: 0, capCredits, spentCredits: 0, counts: { found: 0, duplicates: 0, rejected: 0, kept: 0 }, events: [{ at: now, stage: "planning", message: trigger === "signup" ? "Started for you after signup. Finding directories from your imported accounts, then mapping your market with up to 500 free monthly credits. You can stop this run." : "Choosing sources and company-specific role phrases. Planning is free." }], progress: { phase: "source", step: 0, sourceIndex: 0, page: 1 }, createdBy: user._id, createdAt: now, updatedAt: now });
  await createStagedRun(ctx, { jobId, orgId: user.orgId, title: `Map ${icp.name}` });
  await ctx.db.patch(jobId, { href: `/dashboard/icps/investigations/${id}` });
  await ctx.scheduler.runAfter(0, trigger === "signup" ? internal.tamInvestigationWorker.signupSearch : internal.tamInvestigationWorker.makePlan, { investigationId: id });
  await ctx.scheduler.runAfter((trigger === "signup" ? 18 : 9) * 60_000, internal.tamInvestigations.expire, { investigationId: id, step: 0 });
  return id;
}

export const afterImport = internalMutation({
  args: { sessionId: v.id("researchSessions") },
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get(sessionId);
    if (!session?.claimedByOrgId || !session.claimedByUserId || session.importStatus !== "done") return null;
    const org = await ctx.db.get(session.claimedByOrgId);
    const signup = org?.signupInvestigation;
    if (!org || signup?.state !== "pending" || signup.sessionId !== sessionId) return null;
    const icps = await readIcps(ctx, org._id);
    const icp = icps.find((i) => i.source === "research" && i.sourceDomain === session.domain) ?? icps.find((i) => i.active);
    if (!icp) {
      await ctx.db.patch(org._id, { signupInvestigation: { state: "skipped", sessionId } });
      await ctx.db.patch(sessionId, { events: [...(session.events ?? []), { at: Date.now(), kind: "market", text: "Market mapping was not started because this workspace has no ICP." }].slice(-48) });
      return null;
    }
    const id = await createInvestigation(ctx, { _id: session.claimedByUserId, orgId: org._id }, icp, "signup", INVESTIGATION_TRIGGERS.signup.capCredits);
    await ctx.db.patch(org._id, { signupInvestigation: { state: "started", sessionId, investigationId: id } });
    return id;
  },
});

export const start = mutation({
  args: { ...args, capCredits: v.optional(v.number()) },
  handler: async (ctx, a) => {
    let run = await owned(ctx, a.investigationId);
    if (run.status === "running") return run._id;
    const status = transition(run.status, "running"), capCredits = a.capCredits ?? run.capCredits;
    creditReservation(run.estimateCredits, capCredits, run.spentCredits);
    if (capCredits <= run.spentCredits) throw new ConvexError("Increase the cap to continue this investigation.");
    const job = await ctx.db.get(run.jobId);
    await ctx.db.patch(run.jobId, { counters: { ...job?.counters, cap_micro: capCredits * MICRO }, status: "processing", updatedAt: Date.now() });
    run = { ...run, capCredits, freeOnly: false };
    const amount = creditReservation(Math.max(run.estimateCredits, run.spentCredits), capCredits, run.spentCredits);
    const held = amount === 0 || await reserve(ctx, run, amount);
    if (!held) throw new ConvexError("This workspace does not have enough credits for the estimate. Lower the cap or add credits.");
    await ctx.db.patch(run._id, { status, capCredits, freeOnly: false, events: appendEvent(run.events, { at: Date.now(), stage: "start", message: `Reserved ${amount} credits. Free monthly credits are spent first. Only kept companies are charged.` }), updatedAt: Date.now() });
    await schedule(ctx, run);
    return run._id;
  },
});
export const stop = mutation({ args, handler: async (ctx, a) => {
  const run = await owned(ctx, a.investigationId);
  if (["done", "failed"].includes(run.status)) return null;
  await finish(ctx, run, run.status === "planning" || run.status === "awaiting_start" ? "failed" : "done", "Stopped by you. Companies already kept remain available for staged review.");
  return null;
} });

async function reserve(ctx: MutationCtx, run: Doc<"tamInvestigations">, amount: number) {
  if (run.freeOnly) {
    const org = await ctx.db.get(run.orgId);
    amount = Math.min(amount, org ? Math.floor(creditState(org, Date.now()).freeLeftMicro / MICRO) : 0);
    if (amount < CREDIT_RATES.tamCompany) return false;
  }
  const ref = `tam:${run._id}:hold:${run.spentCredits}`;
  const result = await holdCredits(ctx, { orgId: run.orgId, spender: { jobId: run.jobId }, ref, amountMicro: amount * MICRO, note: "Map my market credit reservation", freeOnly: run.freeOnly });
  if (result.ok) await ctx.db.patch(run._id, { reservation: { ref, remaining: amount } });
  return result.ok;
}
async function schedule(ctx: MutationCtx, run: Doc<"tamInvestigations">) {
  await ctx.scheduler.runAfter(0, internal.tamInvestigationWorker.step, { investigationId: run._id, step: run.progress.step });
  await ctx.scheduler.runAfter(9 * 60_000, internal.tamInvestigations.expire, { investigationId: run._id, step: run.progress.step });
}
async function finish(ctx: MutationCtx, run: Doc<"tamInvestigations">, to: InvestigationStatus, message: string) {
  if (run.reservation) await settleHold(ctx, { ref: run.reservation.ref, chargeMicro: 0 });
  await ctx.db.patch(run._id, { status: transition(run.status, to), reservation: undefined, updatedAt: Date.now(), events: appendEvent(run.events, { at: Date.now(), stage: to, message }) });
  if (to !== "paused_at_cap") await readyRun(ctx, run.jobId);
  await ctx.db.patch(run.jobId, { status: to === "failed" ? "failed" : to === "paused_at_cap" ? "pending" : "completed", detail: message, updatedAt: Date.now(), ...(to === "done" || to === "failed" ? { completedAt: Date.now() } : {}) });
}
export const load = internalQuery({ args, handler: async (ctx, a) => {
  const run = await ctx.db.get(a.investigationId);
  if (!run) return null;
  const job = await ctx.db.get(run.jobId);
  const staged = await ctx.db.query("stagedRuns").withIndex("by_jobId", (q) => q.eq("jobId", run.jobId)).unique();
  const icp = (await readIcps(ctx, run.orgId)).find((i) => i.key === run.icpId) ?? null;
  const search = run.searchId ? await ctx.db.get(run.searchId) : await ctx.db.query("marketSourceSearches").withIndex("by_orgId_and_startedAt", (q) => q.eq("orgId", run.orgId)).order("desc").first();
  const sources = [];
  for (const key of [...new Set(search?.results.map((r) => r.sourceKey) ?? [])].slice(0, 20)) {
    const source = await ctx.db.query("marketSources").withIndex("by_key", (q) => q.eq("key", key)).unique();
    if (source && catalogAllowsFetch(source.url) && ["directory", "association", "award_list", "license_board", "registry"].includes(source.kind)) sources.push(source);
  }
  return { run, icp, sources, searchNote: search?.reason, stopped: Boolean(job?.counters?.stopped) || staged?.state !== "collecting" };
} });
export const planned = internalMutation({
  args: { ...args, sources: v.array(planSource), note: v.string() },
  handler: async (ctx, a) => {
    const run = await ctx.db.get(a.investigationId);
    if (!run || run.status !== "planning") return;
    const estimateCredits = a.sources.reduce((n, s) => n + s.estimatedCompanies * CREDIT_RATES.tamCompany, 0);
    const status = transition(run.status, INVESTIGATION_TRIGGERS[run.trigger].planned, run.trigger);
    const patch = { status, plan: { sources: a.sources }, estimateCredits, events: appendEvent(run.events, { at: Date.now(), stage: "plan", message: a.note }), updatedAt: Date.now() };
    await ctx.db.patch(run._id, patch);
    if (status === "running") {
      const planned = { ...run, ...patch };
      const amount = creditReservation(estimateCredits, run.capCredits);
      if (amount > 0 && !(await reserve(ctx, planned, amount))) {
        await finish(ctx, planned, "paused_at_cap", "Your free monthly credits have run out. Continue to use available credits, including bought credits.");
        return;
      }
      await ctx.db.patch(run.jobId, { status: "processing", updatedAt: Date.now() });
      await schedule(ctx, planned);
    }
  },
});
export const event = internalMutation({ args: { ...args, stage: v.string(), message: v.string() }, handler: async (ctx, a) => {
  const run = await ctx.db.get(a.investigationId);
  if (run && !["done", "failed"].includes(run.status)) await ctx.db.patch(run._id, { events: appendEvent(run.events, { at: Date.now(), stage: a.stage, message: a.message }), updatedAt: Date.now() });
} });
export const sourced = internalMutation({
  args: { ...args, step: v.number(), rows: v.array(v.object(candidateFields)), next: v.optional(v.string()), note: v.string() },
  handler: async (ctx, a) => {
    const run = await ctx.db.get(a.investigationId);
    if (!run || run.status !== "running" || run.progress.step !== a.step) return;
    const total = run.counts.found + a.rows.length;
    if (total > 3000) { await finish(ctx, run, "failed", "The 3,000-candidate safety limit was reached. Results so far are saved for review."); return; }
    for (const row of a.rows) await ctx.db.insert("tamCandidates", { ...row, investigationId: run._id, orgId: run.orgId, state: "found" });
    const more = Boolean(a.next) && run.progress.page < 5;
    const sourceIndex = run.progress.sourceIndex + (more ? 0 : 1);
    const progress: Doc<"tamInvestigations">["progress"] = { phase: sourceIndex >= run.plan.sources.length ? "dedupe" : "source", step: a.step + 1, sourceIndex, page: more ? run.progress.page + 1 : 1, ...(more ? { cursor: a.next } : {}) };
    await ctx.db.patch(run._id, { progress, counts: { ...run.counts, found: total }, events: appendEvent(run.events, { at: Date.now(), stage: "source", message: a.note + (a.next && !more ? " Stopped after five pages for this source." : "") }), updatedAt: Date.now() });
    await schedule(ctx, { ...run, progress });
  },
});
export const found = internalQuery({ args, handler: (ctx, a) => ctx.db.query("tamCandidates").withIndex("by_investigationId_and_state", (q) => q.eq("investigationId", a.investigationId).eq("state", "found")).take(3000) });
export const nextCandidate = internalQuery({ args, handler: (ctx, a) => ctx.db.query("tamCandidates").withIndex("by_investigationId_and_state", (q) => q.eq("investigationId", a.investigationId).eq("state", "found")).first() });
export const sourcesForDomain = internalQuery({
  args: { orgId: v.id("organizations"), domain: v.string() },
  handler: async (ctx, a) => {
    const candidates = await ctx.db.query("tamCandidates").withIndex("by_orgId_and_keys_domain_and_state", (q) => q.eq("orgId", a.orgId).eq("keys.domain", a.domain).eq("state", "kept")).take(50);
    const approved = new Set<Id<"tamInvestigations">>();
    for (const id of new Set(candidates.map((c) => c.investigationId))) {
      const run = await ctx.db.get(id);
      const staged = run && await ctx.db.query("stagedRuns").withIndex("by_jobId", (q) => q.eq("jobId", run.jobId)).unique();
      if (staged?.state === "approved") approved.add(id);
    }
    return unionSources(candidates.filter((c) => approved.has(c.investigationId)).flatMap((c) => c.sources));
  },
});
export const pause = internalMutation({ args, handler: async (ctx, a) => {
  const run = await ctx.db.get(a.investigationId);
  if (run?.status === "running") await finish(ctx, run, "paused_at_cap", "The credit cap was reached. Increase the cap and continue to keep more companies.");
} });
export const deduped = internalMutation({
  args: { ...args, step: v.number(), workspace: v.array(v.object({ domain: v.optional(v.string()), linkedinUrl: v.optional(v.string()) })) },
  handler: async (ctx, a) => {
    const run = await ctx.db.get(a.investigationId);
    if (!run || run.status !== "running" || run.progress.step !== a.step) return;
    const rows = await ctx.db.query("tamCandidates").withIndex("by_investigationId_and_state", (q) => q.eq("investigationId", run._id).eq("state", "found")).take(3000);
    let duplicates = 0;
    for (const group of dedupeCandidates(rows, a.workspace)) {
      for (const [at, index] of group.indices.entries()) {
        const duplicate = at > 0 || group.workspaceDuplicate;
        if (duplicate) duplicates++;
        await ctx.db.patch(rows[index]._id, { ...(at === 0 ? group.company : {}), state: duplicate ? "duplicate" : "found", ...(duplicate ? { reason: group.workspaceDuplicate ? "Already in your workspace" : "Same company found in this run" } : {}) });
      }
    }
    const progress = { ...run.progress, phase: "websites" as const, step: a.step + 1 };
    await ctx.db.patch(run._id, { progress, counts: { ...run.counts, duplicates }, events: appendEvent(run.events, { at: Date.now(), stage: "dedupe", message: `${duplicates} duplicates removed before website reads.` }), updatedAt: Date.now() });
    await schedule(ctx, { ...run, progress });
  },
});
export const resolved = internalMutation({
  args: { ...args, step: v.number(), candidateId: v.id("tamCandidates"), domain: v.optional(v.string()), reason: v.optional(v.string()), workspaceDuplicate: v.optional(v.boolean()) },
  handler: async (ctx, a) => {
    let run = await ctx.db.get(a.investigationId);
    const candidate = await ctx.db.get(a.candidateId);
    if (!run || run.status !== "running" || run.progress.step !== a.step || candidate?.investigationId !== run._id || candidate.state !== "found") return;
    const prior = a.domain ? await ctx.db.query("tamCandidates").withIndex("by_investigationId_and_keys_domain", (q) => q.eq("investigationId", run!._id).eq("keys.domain", a.domain)).take(3000) : [];
    const duplicate = a.workspaceDuplicate || prior.some((c) => c._id !== candidate._id && c.state === "kept");
    const state = duplicate ? "duplicate" : a.domain ? "kept" : "rejected";
    const kept = prior.find((c) => c._id !== candidate._id && c.state === "kept");
    if (duplicate && kept) {
      const sources = unionSources([...kept.sources, ...candidate.sources]);
      await ctx.db.patch(kept._id, { sources });
      await addStagedBatch(ctx, { jobId: run.jobId, source: `tam_investigation:${run._id}`, accounts: [{ name: kept.name, domain: kept.domain!, discoverySources: sources, existing: false }], contacts: [] });
    }
    if (state === "kept") {
      const staged = await ctx.db.query("stagedRuns").withIndex("by_jobId", (q) => q.eq("jobId", run!.jobId)).unique();
      if (staged?.state !== "collecting") { await finish(ctx, run, "failed", "The staged review was discarded. Unused credits were returned."); return; }
      if (run.spentCredits + CREDIT_RATES.tamCompany > run.capCredits) { await finish(ctx, run, "paused_at_cap", "The credit cap was reached. Increase the cap and continue to keep more companies."); return; }
      if (!run.reservation?.remaining) {
        if (run.reservation) await settleHold(ctx, { ref: run.reservation.ref, chargeMicro: 0 });
        if (!(await reserve(ctx, run, Math.min(100, run.capCredits - run.spentCredits)))) { await finish(ctx, run, "paused_at_cap", "The workspace needs more credits to continue. Results so far are saved."); return; }
        run = (await ctx.db.get(run._id))!;
      }
      await chargeHeldCredits(ctx, { holdRef: run.reservation!.ref, ref: `tam:${candidate._id}`, amountMicro: CREDIT_RATES.tamCompany * MICRO, note: `Map my market kept ${candidate.name}` });
      await addStagedBatch(ctx, { jobId: run.jobId, source: `tam_investigation:${run._id}`, accounts: [{ name: candidate.name, domain: a.domain!, ...(candidate.linkedinUrl ? { linkedinUrl: candidate.linkedinUrl } : {}), discoverySources: candidate.sources, existing: false }], contacts: [] });
      await ctx.db.patch(run._id, { spentCredits: run.spentCredits + CREDIT_RATES.tamCompany, reservation: { ref: run.reservation!.ref, remaining: run.reservation!.remaining - CREDIT_RATES.tamCompany } });
      await ctx.runMutation(internal.companyWebFacts.readAndEnsure, { domain: a.domain!, refresh: true });
    }
    await ctx.db.patch(candidate._id, { state, ...(a.domain ? { domain: a.domain, keys: candidateKeys({ ...candidate, domain: a.domain }) } : {}), ...(state === "kept" ? {} : { reason: duplicate ? "Already found in this run or workspace" : a.reason ?? "No confirmed website" }) });
    const counts = { ...run.counts, [state === "duplicate" ? "duplicates" : state]: run.counts[state === "duplicate" ? "duplicates" : state] + 1 };
    const progress = { ...run.progress, step: a.step + 1 };
    await ctx.db.patch(run._id, { counts, progress, events: appendEvent(run.events, { at: Date.now(), stage: "websites", message: `${candidate.name}: ${state}${a.reason ? `. ${a.reason}` : ""}` }), updatedAt: Date.now() });
    await schedule(ctx, { ...run, progress });
  },
});
export const complete = internalMutation({ args, handler: async (ctx, a) => {
  const run = await ctx.db.get(a.investigationId);
  if (run?.status === "running") await finish(ctx, run, "done", `${run.counts.kept} companies kept for review. ${run.spentCredits} credits charged. Unused reserved credits returned.`);
} });
export const fail = internalMutation({ args: { ...args, message: v.string() }, handler: async (ctx, a) => {
  const run = await ctx.db.get(a.investigationId);
  if (run && ["planning", "running"].includes(run.status)) await finish(ctx, run, "failed", a.message);
} });
export const expire = internalMutation({ args: { ...args, step: v.number() }, handler: async (ctx, a) => {
  const run = await ctx.db.get(a.investigationId);
  if (run && ["planning", "running"].includes(run.status) && run.progress.step === a.step && Date.now() - run.updatedAt >= 8 * 60_000) await finish(ctx, run, "failed", "The current step timed out. Unused credits were returned; kept companies remain available for review.");
} });
export const recordCall = internalMutation({
  args: { orgId: v.id("organizations"), provider: v.union(v.literal("treg"), v.literal("openrouter")), endpoint: v.string(), costMicro: v.number(), hit: v.boolean(), callId: v.optional(v.string()) },
  handler: async (ctx, { hit, ...a }) => { await ctx.db.insert("providerCalls", { ...a, feature: "tam_investigation", outcome: hit ? "hit" : "miss", at: Date.now() }); },
});
export const previewFixture = internalMutation({ args: {}, handler: async (ctx) => {
  if (process.env.CANONCRM_LOCAL_STACK !== "true" || paidCallsAllowed()) throw new ConvexError("Fixtures require a local stack with paid calls off.");
  const user = await manager(ctx), now = Date.now();
  const icpId = await insertIcp(ctx, { orgId: user.orgId, name: "Django development companies", description: "Software companies that build Django applications", offer: "Developer tooling for Django engineering teams", source: "manual", createdBy: user._id, active: true, spec: { market: { industries: ["software development"], countries: [], employeeBands: [] }, persona: { levels: [], departments: ["engineering"], titles: ["Django developer"] }, exclude: { industries: [], countries: [], titles: [] } } });
  const url = "https://www.djangoproject.com/foundation/corporate-members/";
  const prior = await ctx.db.query("marketSources").withIndex("by_key", (q) => q.eq("key", url)).unique();
  const source = { key: url, url, title: "Django Software Foundation corporate members", kind: "association" as const, listedCount: 30, markets: ["software development"], seedHits: 1, firstSeenAt: now, lastSeenAt: now };
  if (prior) await ctx.db.replace(prior._id, source); else await ctx.db.insert("marketSources", source);
  await ctx.db.insert("marketSourceSearches", { orgId: user.orgId, startedBy: user._id, startedAt: now, status: "done", reason: "Local source fixture. The investigation will fetch the real public directory.", seeds: [], results: [{ sourceKey: url, seedDomain: "atlascloud.example", quote: "Local source fixture", query: "Local source fixture" }], calls: 0, costMicro: 0 });
  return { icpId, source: url };
} });

export const signupPreviewFixture = internalMutation({
  args: {},
  handler: async (ctx) => {
    if (process.env.CANONCRM_LOCAL_STACK !== "true" || paidCallsAllowed()) throw new ConvexError("Fixtures require a local stack with paid calls off.");
    const user = await manager(ctx), org = await ctx.db.get(user.orgId);
    if (!org) throw new ConvexError("Workspace not found.");
    if (org.signupInvestigation) return { sessionId: org.signupInvestigation.sessionId };
    const now = Date.now();
    await insertIcp(ctx, { orgId: org._id, name: "Django development companies", description: "Synthetic signup fixture", sourceDomain: "signup.example", source: "research", active: true, createdBy: user._id, spec: { market: { industries: ["software development"], countries: [], employeeBands: [] }, persona: { titles: ["Django developer"], levels: [], departments: [] }, exclude: { industries: [], countries: [], titles: [] } } });
    const sessionId = await ctx.db.insert("researchSessions", { token: crypto.randomUUID().replaceAll("-", ""), domain: "signup.example", status: "ready", createdAt: now, updatedAt: now, claimedByOrgId: org._id, claimedByUserId: user._id, claimedAt: now, importStatus: "done", importedAccounts: 0 });
    await ctx.db.patch(org._id, { signupInvestigation: { state: "pending", sessionId }, creditUnit: "credits", creditBalanceMicro: 1000 * MICRO, freeCreditsMonth: creditMonth(now), freeCreditsUsedMicro: 1000 * MICRO });
    return { sessionId };
  },
});
