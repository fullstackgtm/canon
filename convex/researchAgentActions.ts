"use node";
import { siteUrl } from "./lib/siteUrl";

/**
 * Research agent runs (convex/researchAgents.ts): page through a TAM scope by
 * fit, give each account Canon identity, research it (convex/lib/research),
 * save the pages read, and submit answers to the write gate as proposed facts.
 * Reschedules itself between slices, like the TAM explorer's runs.
 */
import { integrationEnabled } from "./lib/integrationsAvailable.ts";

import { ConvexError, v } from "convex/values";
import { action, internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { DEFAULT_MODELS, chatgptWebSearch, forcedToolCall } from "../engine/src/llm.ts";
import { publicHttpGet } from "../engine/src/publicHttp.ts";
import { resolveLlm } from "./lib/llmResolver";
import { canonResearchLlm } from "./lib/canonModel";
import { principalClient, requireCaller } from "./records";
import { promoteContacts } from "./lib/recordPromotion";
import type { Access } from "./lib/access";
import { filterValidator, runScopeOf, type ContactScope } from "./lib/scopeValidators";
import { runtimeExtractor, factualModel } from "./lib/research/factualExtraction";
import { estimateRun, recordsAffordable, type RunEstimate } from "./lib/research/runPlan";
import { MICRO } from "./lib/creditPacks";
import { JEV_INFER_MIN, PROBE_SIZE, inferredEvidence, inferredValue, jevGrounded, jevQuestionFor, jevReadOf, jevStateFor, pickSample, type JevRead, type ProbeStatus, type ProbeVerdict } from "./lib/research/probe";
import { jevSystemOne } from "./lib/segments/jev";
import { makeWebSearch, serpRows, unreadable, type SerpRow } from "./lib/research/webSearch";
import { paidCallsAllowed, tregCall } from "./lib/treg";
import { normalizeDomain, type RecordClient } from "./lib/recordClient";
import type { AccountRow, AccountsFilter, ContactRow } from "./lib/recordContract";
import { contactScopeValidator } from "./researchAgents";
import { fetchHomepage, MIN_TEXT } from "./lib/homepageFetch";
import { profileUrl } from "./lib/enrichProfile";
import {
  ACCOUNT_MS,
  MAX_TRACE_STEPS,
  PROMPT_VERSION,
  factualPromptVersion,
  RESEARCH_CONCURRENCY,
  RESEARCH_PAGE,
  attributeFor,
  evidenceText,
  RUN_CAP,
  htmlText,
  pageFromHtml,
  researchCompany,
  isFactualField,
  saveBatches,
  type FetchedPage,
  type Finding,
  type PageFetcher,
  type Subject,
  type TraceStep,
} from "./lib/research/agentLoop";

const PAGE = RESEARCH_PAGE;
/** Records one page reads while a probe collects the records a run would touch. */
const POOL_PAGE = 50;
/** Pages a probe reads at most looking for them (a scope mostly answered already ends early). */
const POOL_PAGES = 20;
/** Most a Google search through treg may cost; above it treg refuses rather than reach a pricier provider. */
const GOOGLE_MAX_USD = 0.002;
/** Jev requests a probe page makes at once. */
const JEV_CONCURRENCY = 8;
const CONCURRENCY = RESEARCH_CONCURRENCY;
/** Reschedule well inside the 10-minute action limit. */
const SLICE_MS = 4 * 60_000;
// ACCOUNT_MS (agentLoop.ts) caps one account's research. With PAGE accounts over CONCURRENCY workers
// (3 waves), a page started just before SLICE_MS still ends well inside Convex's 10-minute action limit.

const direct = (url: string) =>
  publicHttpGet(url, {
    timeoutMs: 12_000, maxRedirects: 4, maxBytes: 3_000_000,
    headers: { "User-Agent": `canoncrm-research/1 (+${siteUrl()})`, Accept: "text/html,*/*;q=0.5" },
  }).then((r) => (r.status >= 200 && r.status < 300 ? { text: new TextDecoder().decode(r.body), finalUrl: r.finalUrl } : null)).catch(() => null);

/** Plain fetch of any public page; the homepage also falls back to the fetch Worker (text only, no links). */
export const fetchPage: PageFetcher = async (url) => {
  const res = await direct(url);
  if (res) {
    const page = pageFromHtml(res.text, res.finalUrl || url);
    if (page.text.length >= MIN_TEXT || !isHomepage(url)) return page.text ? page : null;
  }
  if (!isHomepage(url)) return null;
  const home = await fetchHomepage(new URL(url).hostname, {
    direct, workerUrl: process.env.FETCH_URL, workerToken: process.env.FETCH_TOKEN,
  }).catch(() => null);
  if (!home) return null;
  const page = home.via === "worker" ? { url: home.finalUrl, text: htmlText(home.text), links: [] } : pageFromHtml(home.text, home.finalUrl);
  return page.text ? page : null;
};

function isHomepage(url: string): boolean {
  try { return new URL(url).pathname === "/"; } catch { return false; }
}

/**
 * Run `work` with an abort signal that fires after `ms`, and reject then. The
 * signal cancels in-flight model requests and stops further rounds, so
 * abandoned research doesn't keep spending. The account counts as an error
 * and a later run retries it.
 */
function withDeadline<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Timed out after ${ms / 1000}s`));
    }, ms);
  });
  return Promise.race([work(controller.signal), deadline]).finally(() => clearTimeout(timer));
}

/** Google results through treg for workspace `ws`, or undefined where paid calls are off or treg isn't configured. */
export function googleSearch(ws: string): ((q: string) => Promise<SerpRow[]>) | undefined {
  const tregToken = process.env.TREG_TOKEN;
  if (!tregToken || !paidCallsAllowed()) return undefined;
  return async (q) => serpRows((await tregCall({
    token: tregToken, endpoint: "treg.google.serp.organic", body: { q }, meta: { customer: ws, feature: "research_search" },
    maxCostUsd: GOOGLE_MAX_USD, baseUrl: process.env.TREG_BASE_URL, timeoutMs: 20_000,
  })).body);
}

async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

export const runSlice = internalAction({
  args: { runId: v.id("researchRuns") },
  handler: async (ctx, args): Promise<null> => {
    if (!integrationEnabled("chatgpt") && !integrationEnabled("openrouter")) return null;
    try {
      return await slice(ctx, args.runId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`research: run ${args.runId} failed: ${message}`);
      await ctx.runMutation(internal.researchAgents.progressRun, { runId: args.runId, set: { status: "failed", error: message.slice(0, 500) } });
      return null;
    }
  },
});

/** A paused or archived agent's run stops here; the mutation re-checks and latches in its own transaction. */
async function stoppedForStanding(ctx: ActionCtx, loaded: { run: { _id: Id<"researchRuns"> }; standing: { status: string } | null }): Promise<boolean> {
  if (!loaded.standing || loaded.standing.status === "active") return false;
  return ctx.runMutation(internal.researchAgents.stopIfInactive, { runId: loaded.run._id });
}

/** One record a run researches: an account, or a contact with the company they work at. */
type Target = { id: string; label: string; subject: Subject; profileUrl?: string };

type Batch = {
  todo: Target[];
  entityOf: Map<string, Id<"canonEntities">>;
  skipped: number;
  nextCursor: string | null;
};

const accountTarget = (r: AccountRow): Target => {
  const domain = normalizeDomain(r.domain);
  return { id: r.id, label: domain, subject: { name: r.name, domain } };
};

type Client = RecordClient;
type Scoped = { orgId: Id<"organizations">; agentId: Id<"researchAgents">; attribute: string; remaining: number };

/** The next page of a TAM scope, by fit: give each account Canon identity, then drop those already answered or recently tried. */
async function scopeBatch(
  ctx: ActionCtx,
  client: Client,
  a: Scoped & { filter: AccountsFilter; cursor: string | undefined; limit?: number },
): Promise<Batch> {
  const page = await client.list(a.orgId as string, { filter: a.filter, sort: { field: "fit", dir: "desc" }, cursor: a.cursor, limit: a.limit ?? PAGE });
  const rows = page.rows.filter((r) => r.domain);
  // Canon identity first: facts attach to entities, and the skip check reads them.
  const promoted = rows.length
    ? await ctx.runMutation(internal.canonEntities.anchorAccounts, {
        orgId: a.orgId,
        accounts: rows.map((r) => ({ recordId: r.id, domain: normalizeDomain(r.domain), name: r.name })),
      })
    : [];
  const entityOf = new Map(promoted.map((p) => [p.recordId, p.entityId]));
  const answered = new Set<string>(promoted.length
    ? await ctx.runQuery(internal.researchAgents.skippedEntities, { agentId: a.agentId, entityIds: promoted.map((p) => p.entityId), attribute: a.attribute })
    : []);
  const todo = rows.filter((r) => entityOf.has(r.id) && !answered.has(entityOf.get(r.id)!)).slice(0, a.remaining);
  return { todo: todo.map(accountTarget), entityOf, skipped: page.rows.length - todo.length, nextCursor: page.nextCursor };
}

/** The next accounts a scheduled refresh re-asks: the field's oldest accepted answers (researchAgents.staleBatch), read back from the record service. */
async function staleBatch(ctx: ActionCtx, client: Client, orgId: Id<"organizations">, runId: Id<"researchRuns">, remaining: number): Promise<Batch> {
  const found = await ctx.runQuery(internal.researchAgents.staleBatch, { runId, numItems: Math.min(PAGE, remaining) });
  const todo: Target[] = [];
  const entityOf = new Map<string, Id<"canonEntities">>();
  for (const e of found.entities) {
    const got = await client.get(orgId as string, e.recordId);
    if (!got?.account.domain) continue; // the record is gone, or has no site to read
    todo.push(accountTarget(got.account));
    entityOf.set(got.account.id, e.entityId);
  }
  return { todo, entityOf, skipped: found.scanned - todo.length, nextCursor: found.nextCursor };
}

/** Mailbox providers: an address there says nothing about the person's company. */
const FREE_MAIL = new Set(["gmail.com", "googlemail.com", "yahoo.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com"]);

/**
 * Contacts by record-service id, each with the company whose site is read: their account's, else their work
 * email's domain. One with neither has nothing to read and is left out.
 */
async function contactTargets(client: Client, ws: string, ids: string[]) {
  const accounts = new Map<string, Promise<AccountRow | null>>();
  const out: Array<{ target: Target; contact: ContactRow }> = [];
  for (const id of ids) {
    const contact = await client.getContact(ws, id);
    if (!contact) continue;
    if (contact.accountId && !accounts.has(contact.accountId)) accounts.set(contact.accountId, client.get(ws, contact.accountId).then((r) => r?.account ?? null));
    const account = contact.accountId ? await accounts.get(contact.accountId)! : null;
    const mailDomain = normalizeDomain(contact.email?.split("@")[1] ?? "");
    const domain = account?.domain ? normalizeDomain(account.domain) : mailDomain && !FREE_MAIL.has(mailDomain) ? mailDomain : "";
    if (!domain) continue;
    out.push({
      contact,
      target: {
        id: contact.id, label: `${contact.fullName} · ${domain}`, ...(contact.linkedinUrl ? { profileUrl: contact.linkedinUrl } : {}),
        subject: { name: account?.name || domain, domain, person: { name: contact.fullName, ...(contact.title ? { title: contact.title } : {}) } },
      },
    });
  }
  return out;
}

/**
 * Contacts to research from their record ids. With `entityOf` (a refresh, whose contacts are known) they are used as they
 * are; otherwise each gets Canon identity and those already answered or recently tried are dropped, as for accounts.
 */
async function contactBatch(
  ctx: ActionCtx,
  client: Client,
  a: Scoped & { ids: string[]; nextCursor: string | null; entityOf?: Map<string, Id<"canonEntities">>; picked?: boolean },
): Promise<Batch> {
  let found = await contactTargets(client, a.orgId as string, a.ids);
  let entityOf = a.entityOf;
  if (!entityOf) {
    const anchored = found.length ? await promoteContacts(ctx, client, a.orgId, found.map((f) => f.contact.id)) : [];
    entityOf = new Map(anchored.map((p) => [p.recordId, p.entityId] as const));
    const answered = new Set<string>(entityOf.size
      ? await ctx.runQuery(internal.researchAgents.skippedEntities, { agentId: a.agentId, entityIds: [...entityOf.values()], attribute: a.attribute, ...(a.picked ? { picked: true } : {}) })
      : []);
    found = found.filter((f) => entityOf!.has(f.target.id) && !answered.has(entityOf!.get(f.target.id)!));
  }
  const todo = found.slice(0, a.remaining).map((f) => f.target);
  return { todo, entityOf, skipped: a.ids.length - todo.length, nextCursor: a.nextCursor };
}

/** The next page of a contact scope: chosen rows in order, or the register's list (all contacts, or a view's filter). */
export async function contactScopeBatch(ctx: ActionCtx, client: Client, a: Scoped & { scope: ContactScope; cursor: string | undefined; limit?: number }): Promise<Batch> {
  const limit = a.limit ?? PAGE;
  if ("ids" in a.scope) {
    const at = Number(a.cursor ?? 0);
    return contactBatch(ctx, client, { ...a, ids: a.scope.ids.slice(at, at + limit), nextCursor: at + limit < a.scope.ids.length ? String(at + limit) : null, picked: true });
  }
  const page = await client.listRegister(a.orgId as string, "contact", { filter: a.scope.filter, limit, ...(a.cursor ? { cursor: a.cursor } : {}) });
  return contactBatch(ctx, client, { ...a, ids: page.rows.map((r) => r.id), nextCursor: page.nextCursor });
}

async function contactStaleBatch(ctx: ActionCtx, client: Client, a: Scoped & { runId: Id<"researchRuns"> }): Promise<Batch> {
  const found = await ctx.runQuery(internal.researchAgents.staleBatch, { runId: a.runId, numItems: Math.min(PAGE, a.remaining) });
  const batch = await contactBatch(ctx, client, {
    ...a, ids: found.entities.map((e) => e.recordId), nextCursor: found.nextCursor, entityOf: new Map(found.entities.map((e) => [e.recordId, e.entityId])),
  });
  return { ...batch, skipped: found.scanned - batch.todo.length };
}

async function contactScopeTotal(client: Client, ws: string, scope: ContactScope): Promise<number> {
  return "ids" in scope ? scope.ids.length : (await client.listRegister(ws, "contact", { filter: scope.filter, limit: 1 })).total;
}

type SampleRow = { recordId: string; entityId: Id<"canonEntities">; label: string };

/**
 * A probe's records: a random PROBE_SIZE of those a run of this scope would research, i.e. the first
 * RUN_CAP not yet answered or recently tried, in the run's order (accounts by fit).
 */
async function chooseSample(ctx: ActionCtx, client: Client, base: Omit<Scoped, "remaining">, scope: NonNullable<ReturnType<typeof runScopeOf>>): Promise<SampleRow[]> {
  const pool: SampleRow[] = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < POOL_PAGES && pool.length < RUN_CAP; pages++) {
    const a = { ...base, remaining: RUN_CAP - pool.length, cursor, limit: POOL_PAGE };
    const b = scope.entity === "contact" ? await contactScopeBatch(ctx, client, { ...a, scope: scope.scope }) : await scopeBatch(ctx, client, { ...a, filter: scope.filter });
    for (const t of b.todo) pool.push({ recordId: t.id, entityId: b.entityOf.get(t.id)!, label: t.label });
    if (!b.nextCursor) break;
    cursor = b.nextCursor;
  }
  return pickSample(pool, PROBE_SIZE);
}

/** The next page of a probe's sample, read back from the record service; a record deleted since is skipped. */
async function sampleBatch(client: Client, ws: string, contacts: boolean, sample: SampleRow[], cursor: string | undefined, limit = PAGE): Promise<Batch> {
  const at = Number(cursor ?? 0);
  const rows = sample.slice(at, at + Math.min(PAGE, limit));
  const entityOf = new Map(rows.map((r) => [r.recordId, r.entityId] as const));
  const todo: Target[] = [];
  if (contacts) todo.push(...(await contactTargets(client, ws, rows.map((r) => r.recordId))).map((f) => f.target));
  else {
    for (const r of rows) {
      const got = await client.get(ws, r.recordId);
      if (got?.account.domain) todo.push(accountTarget(got.account));
    }
  }
  return { todo, entityOf, skipped: rows.length - todo.length, nextCursor: at + rows.length < sample.length ? String(at + rows.length) : null };
}

/** A contact's profile page, read along with the company site. LinkedIn and the like often refuse; then there is none. */
/** How long a saved profile stands in for a page that refuses our fetch: a role or employer changes. */
const SAVED_PROFILE_MS = 90 * 24 * 60 * 60_000;

async function profilePages(ctx: ActionCtx, orgId: Id<"organizations">, url: string | undefined): Promise<FetchedPage[]> {
  if (!url) return [];
  const full = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  // A site that refuses our fetches (LinkedIn) answers with a sign-in wall at best: it isn't fetched.
  const page = unreadable(full) ? null : await fetchPage(full).catch(() => null);
  if (page) return [page];
  // A recent saved copy (an enrichment's profile, lib/researchEnrich.ts) stands in for a page we can't read.
  const saved = await ctx.runQuery(internal.researchAgents.savedPage, { orgId, url: profileUrl(full) ?? full });
  return saved && Date.now() - saved.fetchedAt < SAVED_PROFILE_MS ? [{ url: saved.url, text: saved.text, links: [] }] : [];
}

async function slice(ctx: ActionCtx, runId: Id<"researchRuns">): Promise<null> {
  const started = Date.now();
  const loaded = await ctx.runQuery(internal.researchAgents.getRun, { runId });
  if (!loaded || loaded.run.status !== "running") return null;
  const { run, agent, spec } = loaded;
  const fail = async (error: string): Promise<null> => {
    await ctx.runMutation(internal.researchAgents.progressRun, { runId, set: { status: "failed", error } });
    return null;
  };
  if (!agent || !spec) return fail("The field was deleted.");
  if (await stoppedForStanding(ctx, loaded)) return null;
  // It reads only what its owner and its starter both see (CP14); without them it reads nothing.
  if (!loaded.principals) return fail("The person who started this run, or the field's owner, is no longer a member of this workspace.");
  // A manual run bills its starter; a scheduled refresh is created with the agent's owner as its starter, so it
  // bills the owner's plan; without one the field is held (only a run a person starts falls back to Canon's model).
  const refresh = run.trigger === "refresh";
  // A run started without a ChatGPT plan uses Canon's research model and is paid in credits; any other uses the
  // starter's plan, free.
  const billed = run.onCredits === true;
  const llm = billed ? canonResearchLlm() : await resolveLlm(ctx, run.createdBy);
  if (!llm) {
    if (billed) return fail("Canon's research model isn't configured on this deployment.");
    if (refresh) await ctx.runMutation(internal.researchAgents.holdRefresh, { runId, message: "The agent's owner's ChatGPT sign-in is missing or expired. Refresh resumes once they sign in under Integrations → ChatGPT." });
    return fail("No AI model is connected. Sign in with ChatGPT under Integrations → ChatGPT.");
  }
  const model = llm.model ?? DEFAULT_MODELS[llm.provider];
  // Per account: model requests carry the account's abort signal, so a deadline stops them. `counted`
  // tallies the record's model calls outside its deadline, so a record that times out keeps its count.
  const callWith = (signal: AbortSignal, counted: () => void) => (prompt: string, tool: string, schema: object) => {
    counted();
    return forcedToolCall(prompt, tool, schema, model, { ...llm, fetchImpl: (input, init) => fetch(input, { ...init, signal }) });
  };
  const ws = run.orgId as string;
  // Web search per record: ChatGPT's (on the same plan) first, Google through treg as the fallback where paid calls are on.
  const google = googleSearch(ws);
  const searchWith = (signal: AbortSignal, counted: () => void) => makeWebSearch({
    fetchPage,
    ...(llm.provider === "chatgpt" ? { chatgpt: (q: string) => { counted(); return chatgptWebSearch(q, model, { ...llm, signal }); } } : {}),
    ...(google ? { google } : {}),
  });
  const client = principalClient(ctx, ws, loaded.principals);
  const attribute = attributeFor(agent.slug);
  const contacts = agent.entityType === "contact";

  const scope = refresh ? null : runScopeOf(run, agent.entityType);
  const probe = run.trigger === "probe";
  if (scope && !run.cursor && run.planned === 0) {
    const total = scope.entity === "contact" ? await contactScopeTotal(client, ws, scope.scope) : (await client.countSegment(ws, scope.filter)).total;
    if (!probe) await ctx.runMutation(internal.researchAgents.progressRun, { runId, set: { inScope: total, planned: Math.min(total, RUN_CAP) } });
    else {
      const sample = await chooseSample(ctx, client, { orgId: run.orgId, agentId: agent._id, attribute }, scope);
      const state = await ctx.runMutation(internal.researchAgents.progressRun, {
        runId, set: { inScope: total, planned: sample.length, sample, ...(sample.length ? { cursor: "0" } : { status: "done" as const }) },
      });
      if (state === "stopped") return null;
    }
  }

  let cursor = run.cursor;
  for (;;) {
    const current = await ctx.runQuery(internal.researchAgents.getRun, { runId });
    if (!current || current.run.status !== "running" || await stoppedForStanding(ctx, current)) return null;
    const remaining = current.run.planned - current.run.done - current.run.errors;
    if (remaining <= 0) break;
    // A page researches only the records both what is left of the run's cap (a refresh has none) and the
    // workspace's balance pay for; the hold below re-checks the balance against concurrent spending.
    const byCap = !billed || current.run.capMicro === undefined ? remaining : recordsAffordable(current.run.capMicro, current.run.spentMicro ?? 0);
    const byBalance = billed ? recordsAffordable((await ctx.runQuery(internal.credits.balanceOf, { orgId: run.orgId })).spendableMicro, 0) : remaining;
    if (byCap <= 0 || byBalance <= 0) {
      await ctx.runMutation(internal.researchAgents.stopForCredits, { runId, reason: byCap <= 0 ? "cap" : "credits" });
      return null;
    }
    const affordable = Math.min(byCap, byBalance);
    const scoped = { orgId: run.orgId, agentId: agent._id, attribute, remaining: Math.min(remaining, affordable) };
    const { todo, entityOf, skipped, nextCursor } = probe
      ? await sampleBatch(client, ws, contacts, current.run.sample ?? [], cursor, scoped.remaining)
      : !scope
      ? (contacts ? await contactStaleBatch(ctx, client, { ...scoped, runId }) : await staleBatch(ctx, client, run.orgId, runId, scoped.remaining))
      : (scope.entity === "contact"
        ? await contactScopeBatch(ctx, client, { ...scoped, scope: scope.scope, cursor })
        : await scopeBatch(ctx, client, { ...scoped, filter: scope.filter, cursor }));

    // Nothing is held: progressRun charges the page's answers as it records them, so research that finds nothing,
    // or a page that is stopped or crashes, never touches the balance.
    const ref = `research:${runId}:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      // A record's steps are collected outside its deadline, so one that times out keeps how far it got.
      const steps = todo.map((): TraceStep[] => []);
      const ms = todo.map(() => 0);
      const calls = todo.map(() => 0);
      const results = await pool(todo.map((row, i) => ({ row, i })), CONCURRENCY, async ({ row, i }) => {
        const t0 = Date.now();
        const counted = () => { calls[i]++; };
        const onStep = (s: TraceStep) => { if (steps[i].length < MAX_TRACE_STEPS) steps[i].push(s.kind === "read" ? { ...s, url: s.url.slice(0, 500) } : s); };
        try {
          return await withDeadline(ACCOUNT_MS, async (signal) =>
            researchCompany(spec, row.subject, { fetchPage, call: callWith(signal, counted), ...(isFactualField(spec) ? { extract: runtimeExtractor({ signal, chargeBeforeDispatch: counted }) } : {}), search: searchWith(signal, counted), signal, seedPages: await profilePages(ctx, run.orgId, row.profileUrl), onStep }));
        } catch (error) {
          console.warn(`research: ${row.label} failed: ${error instanceof Error ? error.message : error}`);
          return { error: error instanceof Error ? error.message : String(error) };
        } finally {
          ms[i] = Date.now() - t0;
        }
      });

      const add = { done: 0, skipped, answered: 0, unknown: 0, noEvidence: 0, inferred: 0, errors: 0, pagesRead: 0, llmCalls: 0 };
      const pages: FetchedPage[] = [];
      // Accounts later runs skip for now: those answered with nothing and, in a refresh, every account asked (an unchanged answer adds no fact).
      const unanswered: Array<Id<"canonEntities">> = [];
      const facts: Array<{ entityType: "account" | "contact"; entityId: string; attribute: string; value: string | number | boolean; evidence: string; confidence: number }> = [];
      // Per fact: Jev's read when the answer is its inference, null for a quoted answer.
      const reads: Array<number | null> = [];
      // Every record's outcome: its trace, and for a probe its sample row (lib/research/probe.ts).
      const outcomes: Array<{ recordId: string; status: ProbeStatus; value?: string | number | boolean; quote?: string; sourceUrl?: string; reason?: string; jev?: JevRead; inferred?: boolean }> = [];
      todo.forEach((row, i) => {
        const r = results[i];
        if ("error" in r) {
          add.errors++;
          outcomes.push({ recordId: row.id, status: "error", reason: r.error.slice(0, 200) });
          return;
        }
        add.done++;
        if (refresh) unanswered.push(entityOf.get(row.id)!);
        add.pagesRead += r.pages.length;
        add.llmCalls += r.calls;
        pages.push(...r.pages);
        const f: Finding = r.finding;
        if (f.status === "answered") {
          if (f.value === null) return void add.unknown++; // never: an answer has a value
          add.answered++;
          facts.push({ entityType: agent.entityType, entityId: entityOf.get(row.id)!, attribute, value: f.value, evidence: evidenceText(f), confidence: f.confidence });
          reads.push(null);
          outcomes.push({ recordId: row.id, status: "answered", value: f.value, quote: f.quote.slice(0, 300), sourceUrl: f.sourceUrl.slice(0, 500) });
        } else {
          if (f.status === "unknown") add.unknown++;
          else add.noEvidence++;
          if (!refresh) unanswered.push(entityOf.get(row.id)!);
          outcomes.push({ recordId: row.id, status: f.status, reason: f.reason.slice(0, 200) });
        }
      });

      // A classify or yes/no field asks Jev for its read of a record no page answered, from what was read
      // (a probe asks for every record, for the distribution). A confident read is proposed as the answer
      // with what Jev read as its evidence; the write gate still decides, as for a quoted answer.
      const jevQuestion = jevQuestionFor(spec);
      const jevKey = integrationEnabled("jev") ? process.env.JEV_API_KEY : undefined;
      if (jevQuestion && jevKey) {
        await pool(todo.map((row, i) => ({ row, r: results[i] })), JEV_CONCURRENCY, async ({ row, r }) => {
          const o = outcomes.find((x) => x.recordId === row.id);
          if ("error" in r || !o || (!probe && o.status === "answered") || !jevGrounded(row.subject, r.pages)) return;
          try {
            const res = await jevSystemOne(jevKey, jevStateFor(row.subject, r.pages), { field: jevQuestion });
            if (res.answers.field) o.jev = jevReadOf(res.answers.field);
          } catch (error) {
            console.warn(`research: jev read of ${row.label} failed: ${error instanceof Error ? error.message : error}`);
          }
        });
        todo.forEach((row, i) => {
          const r = results[i];
          const o = outcomes.find((x) => x.recordId === row.id);
          if ("error" in r || !o?.jev || (o.status !== "unknown" && o.status !== "no_evidence") || o.jev.confidence < JEV_INFER_MIN) return;
          const value = inferredValue(spec, o.jev.choice);
          if (value === null) return;
          facts.push({ entityType: agent.entityType, entityId: entityOf.get(row.id)!, attribute, value, evidence: inferredEvidence(row.subject, r.pages, o.jev), confidence: o.jev.confidence });
          reads.push(o.jev.confidence);
          if (o.status === "unknown") add.unknown--;
          else add.noEvidence--;
          add.inferred++;
          o.inferred = true;
        });
      }

      for (const batch of saveBatches(pages)) {
        await ctx.runMutation(internal.researchAgents.savePages, { orgId: run.orgId, pages: batch });
      }
      if (unanswered.length) await ctx.runMutation(internal.researchAgents.recordAttempts, { runId, entityIds: unanswered });
      if (facts.length) {
        const res = await ctx.runMutation(internal.researchAgents.submitAnswers, { runId, facts, admitted: todo.map((t) => t.id), ...(reads.some((r) => r !== null) ? { reads } : {}) });
        if (!res) return null; // stopped or deleted while researching: nothing lands
        for (const rej of res.rejected) {
          const row = todo.find((t) => entityOf.get(t.id) === facts[rej.index]?.entityId);
          const o = row && outcomes.find((x) => x.recordId === row.id);
          if (o) Object.assign(o, { status: "rejected", reason: rej.reason.slice(0, 200) });
        }
      }

      cursor = nextCursor ?? undefined;
      const finished = !nextCursor;
      const state = await ctx.runMutation(internal.researchAgents.progressRun, {
        runId,
        set: { ...(cursor ? { cursor } : {}), ...(finished ? { status: "done" as const } : {}) },
        add,
        // Only an answer costs a credit: a quoted one or Jev's inference, that the write gate took. Unknowns,
        // errors and rejected answers are free (Ryan, 2026-10-13).
        ...(billed && todo.length ? { chargeRef: ref, charged: outcomes.filter((o) => o.status !== "rejected" && (o.status === "answered" || o.inferred)).length } : {}),
        traces: todo.flatMap((row, i) => {
          const o = outcomes.find((x) => x.recordId === row.id);
          return o ? [{ ...o, label: row.label.slice(0, 300), steps: steps[i], ms: ms[i], calls: calls[i], model: isFactualField(spec) ? factualModel(model) : model, promptVersion: isFactualField(spec) ? factualPromptVersion() : PROMPT_VERSION }] : [];
        }),
      });
      if (state === "stopped") return null;
    } finally {
      if (billed && todo.length) {
        await ctx.runAction(internal.credits.meterRun, { spender: { researchRunId: runId }, provider: "research" })
          .catch(async (error) => {
            console.warn(`research: Metronome report failed, retried in a minute: ${error instanceof Error ? error.message.slice(0, 160) : error}`);
            await ctx.scheduler.runAfter(60_000, internal.credits.meterRun, { spender: { researchRunId: runId }, provider: "research" });
          });
      }
    }
    if (Date.now() - started > SLICE_MS) {
      await ctx.scheduler.runAfter(0, internal.researchAgentActions.runSlice, { runId });
      return null;
    }
  }
  await ctx.runMutation(internal.researchAgents.progressRun, { runId, set: { status: "done" } });
  return null;
}

/** The field's most recent probe, shown next to Start. */
type LatestProbe = { at: number; status: "running" | "done" | "failed" | "cancelled"; verdict: ProbeVerdict } | null;

/**
 * Before a run: how many accounts or contacts it may touch, a time ceiling and what Canon
 * pays (convex/lib/research/runPlan.ts).
 */
export const previewRun = action({
  args: { slug: v.string(), filter: v.optional(filterValidator), contacts: v.optional(contactScopeValidator) },
  handler: async (ctx, args): Promise<{ label: string; entityType: "account" | "contact"; chatgptConnected: boolean; canonModel: boolean; inScope: number; estimate: RunEstimate; latestProbe: LatestProbe; spendable: number }> => {
    const caller = await requireCaller(ctx, { read: true });
    const info: { ownerAccess: Access[] | null; userId: Id<"users">; orgId: string; label: string; entityType: "account" | "contact"; scope: ContactScope | null; autoAccept: boolean; jevReads: boolean; factual: boolean; chatgptConnected: boolean; latestProbe: LatestProbe } | null =
      await ctx.runQuery(internal.researchAgents.previewContext, { slug: args.slug, contacts: args.contacts });
    if (!info) throw new ConvexError("Unknown field");
    // The count is of the records the caller and the field's owner both see, as the run will read (CP14).
    if (!info.ownerAccess) throw new ConvexError("This field's owner is no longer a member of this workspace; ask an admin to reassign it.");
    const client = principalClient(ctx, info.orgId, [caller.access, ...info.ownerAccess]);
    const contacts = info.entityType === "contact";
    if (contacts && !info.scope) throw new ConvexError("Choose which contacts to research.");
    const total = contacts ? await contactScopeTotal(client, info.orgId, info.scope!) : (await client.countSegment(info.orgId, args.filter ?? {})).total;
    // Load the sign-in as the run will (resolveLlm refreshes a token near expiry), so one that can no longer
    // refresh shows here instead of failing the run. A network error leaves the stored status as the answer.
    const chatgptConnected = info.chatgptConnected && await resolveLlm(ctx, info.userId).then((llm) => !!llm, () => true);
    // Credits the workspace can spend now: the cap's default and its warning.
    const { spendableMicro } = await ctx.runQuery(internal.credits.balanceOf, { orgId: info.orgId as Id<"organizations"> });
    return {
      spendable: spendableMicro / MICRO,
      // Without a ChatGPT plan the run can still go, on Canon's research model and credits.
      canonModel: !!canonResearchLlm(),
      label: info.label, entityType: info.entityType, chatgptConnected, inScope: total,
      estimate: estimateRun({ inScope: total, autoAccept: info.autoAccept, factual: info.factual, jevReads: info.jevReads, seedPages: contacts ? 1 : 0 }),
      latestProbe: info.latestProbe,
    };
  },
});
