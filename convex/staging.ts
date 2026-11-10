/**
 * Staged fills (lib/staging.ts): a Market or Companies fill collects its
 * accounts and contacts here instead of writing them to the CRM. When the
 * fill finishes the run is ready for review; a manager explores it on the
 * review page and approves a selection, which an approval job writes through
 * the record service (fill-only, like every population write). Unapproved
 * runs are dropped after STAGED_TTL_MS.
 */
import { discoverySource } from "./lib/tam/investigationValidator";
import { unionSources, type CandidateSource } from "./lib/tam/dedupe";
import { can, refusal } from "./lib/capabilities";
import { ConvexError, v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery, mutation, query, type ActionCtx, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUser } from "./lib";
import { accessFor, principalAccess } from "./permissions";
import { seesEveryRecord } from "./lib/access";
import { clientFor, principalClient } from "./records";
import { visibleValues } from "./lib/scopedRecordClient";
import type { RecordClient } from "./lib/recordClient";
import type { AccountInput, ContactInput } from "./lib/recordContract";
import { batchKey, normDomain } from "./lib/peopleSources";
import {
  NONE, accountDims, cellFromKey, cellKey, contactDims, contactKey, hasKeywords, keywordsPass, needsCount, selects, totalsOf,
  type Cell, type Dims, type Selection, type StagedKind,
} from "./lib/staging";

/** How long an unapproved run is kept. */
export const STAGED_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** Records one approval step reads (and writes, at most). */
const PROMOTE_PAGE = 500;
/** Records one discard step deletes. */
const PURGE_PAGE = 1000;
/** Cells a run's review reads; a run past this many combinations shows a partial breakdown. */
const CELLS_MAX = 8000;
/** Records of a run staged before records carried their cell that the sample may scan. */
const LEGACY_SAMPLE_SCAN = 5000;
/** Records one keyword-count step reads. */
const KEYWORD_PAGE = 4000;
/** Records per cell, and in all, that a keyword count returns for the page's sample. */
const KEYWORD_SAMPLE_PER_CELL = 3;
const KEYWORD_SAMPLE_MAX = 6000;
/** Lookups per record-service call when marking records already in the CRM. */
const LOOKUP_BATCH = 100;

/** Whether a member (with the capabilities of a workspace role, lib.ts withRole) holds imports.run. */
const isManager = (who: { role: string; capabilities?: readonly string[] }) => can(who, "imports.run");

const termsValidator = v.object({ include: v.optional(v.array(v.string())), exclude: v.optional(v.array(v.string())) });
const keywordsValidator = v.object({ title: v.optional(termsValidator), company: v.optional(termsValidator) });

const selectionValidator = v.object({
  region: v.optional(v.array(v.string())),
  industry: v.optional(v.array(v.string())),
  sizeBand: v.optional(v.array(v.string())),
  seniority: v.optional(v.array(v.string())),
  department: v.optional(v.array(v.string())),
  existing: v.optional(v.union(v.literal("new"), v.literal("existing"))),
  keywords: v.optional(keywordsValidator),
  accountsWithContacts: v.optional(v.boolean()),
});

const dimsOf = (r: Doc<"stagedRecords">): Dims => ({
  region: r.region, industry: r.industry, sizeBand: r.sizeBand, existing: r.existing,
  ...(r.seniority !== undefined ? { seniority: r.seniority } : {}),
  ...(r.department !== undefined ? { department: r.department } : {}),
});

async function bumpCell(ctx: MutationCtx, jobId: Id<"backgroundJobs">, cell: string, by: number) {
  const row = await ctx.db.query("stagedCells").withIndex("by_jobId_and_cell", (q) => q.eq("jobId", jobId).eq("cell", cell)).unique();
  if (row) await ctx.db.patch(row._id, { count: row.count + by });
  else if (by > 0) await ctx.db.insert("stagedCells", { jobId, cell, count: by });
}

async function readCells(ctx: QueryCtx | MutationCtx, jobId: Id<"backgroundJobs">, knows = true) {
  const rows = await ctx.db.query("stagedCells").withIndex("by_jobId_and_cell", (q) => q.eq("jobId", jobId)).take(CELLS_MAX + 1);
  const cells = rows.slice(0, CELLS_MAX).map((r) => cellFromKey(r.cell, r.count));
  return { cells: knows ? cells : blindCells(cells), truncated: rows.length > CELLS_MAX };
}

/**
 * Whether the viewer may see which staged records the CRM already has (CP14).
 * A record is marked `existing` against the whole register, so it tells that
 * a company or person exists: only a viewer who sees all of them is told.
 * Everyone else reviews the run as if every record were new.
 */
async function knowsExisting(ctx: QueryCtx, user: Doc<"users">): Promise<boolean> {
  const access = await accessFor(ctx, user);
  return seesEveryRecord(access, "account") && seesEveryRecord(access, "contact");
}

/** Cells as a viewer who is not told what the CRM has sees them: none existing. */
function blindCells(cells: Cell[]): Cell[] {
  const merged = new Map<string, Cell>();
  for (const c of cells) {
    const dims = { ...c.dims, existing: false };
    const key = cellKey(c.kind, dims);
    const prior = merged.get(key);
    merged.set(key, { ...c, dims, count: (prior?.count ?? 0) + c.count });
  }
  return [...merged.values()];
}

/** A selection as such a viewer may make it: "new only" or "only those" would split on what they are not told. */
const blindSelection = <S extends { existing?: "new" | "existing" }>(s: S, knows: boolean): S => (knows ? s : { ...s, existing: undefined });

// ───────────────────────────── Collecting ─────────────────────────────

/** Hold a new fill for review: its run, and the tray job's link to the review page. */
export const create = internalMutation({
  args: { jobId: v.id("backgroundJobs"), orgId: v.id("organizations"), title: v.string() },
  handler: createStagedRun,
});

export async function createStagedRun(ctx: MutationCtx, a: { jobId: Id<"backgroundJobs">; orgId: Id<"organizations">; title: string }) {
  const now = Date.now();
  await ctx.db.insert("stagedRuns", { ...a, state: "collecting", createdAt: now, expiresAt: now + STAGED_TTL_MS });
  await ctx.db.patch(a.jobId, { href: `/dashboard/imports/${a.jobId}` });
  return null;
}

export const runFor = internalQuery({
  args: { jobId: v.id("backgroundJobs") },
  handler: async (ctx, a) => ctx.db.query("stagedRuns").withIndex("by_jobId", (q) => q.eq("jobId", a.jobId)).unique(),
});

type StageAccount = AccountInput & { nameGuessed?: boolean; discoverySources?: CandidateSource[] };

/** Which of these records the CRM already has: accounts by domain, contacts by email or LinkedIn. */
async function existingKeys(client: RecordClient, ws: string, accounts: StageAccount[], contacts: ContactInput[]) {
  const found = new Set<string>();
  const look = async (object: "account" | "contact", field: string, values: string[], keyOf: (v: string) => string) => {
    for (let i = 0; i < values.length; i += LOOKUP_BATCH) {
      const page = await client.listRegister(ws, object, { filter: [{ field, op: "in", value: values.slice(i, i + LOOKUP_BATCH) }], limit: 200 });
      for (const r of page.rows) if (typeof r.values[field] === "string") found.add(keyOf(r.values[field] as string));
    }
  };
  const uniq = (xs: Array<string | undefined>) => [...new Set(xs.filter((x): x is string => Boolean(x)))];
  await look("account", "domain", uniq(accounts.map((a) => normDomain(a.domain))), (d) => `a:${normDomain(d)}`);
  await look("contact", "email", uniq(contacts.map((c) => c.email?.toLowerCase())), (e) => contactKey({ fullName: "", email: e }));
  await look("contact", "linkedinUrl", uniq(contacts.map((c) => c.linkedinUrl)), (l) => contactKey({ fullName: "", linkedinUrl: l }));
  return found;
}

/**
 * Stage one page of a fill: mark what the CRM already has, then add the page
 * to the run. Accounts first, as contacts take their company's dimensions.
 */
export async function stagePage(ctx: ActionCtx, ws: string, jobId: Id<"backgroundJobs">, source: string, accounts: StageAccount[], contacts: ContactInput[]) {
  const found = await existingKeys(clientFor(ctx), ws, accounts, contacts);
  const rows = {
    accounts: accounts.map((a) => ({ ...a, domain: normDomain(a.domain), existing: found.has(`a:${normDomain(a.domain)}`) })),
    contacts: contacts.map((c) => ({ ...c, existing: found.has(contactKey(c)) })),
  };
  // One mutation per slice keeps each well inside a transaction's limits.
  for (let i = 0; i < Math.max(rows.accounts.length, rows.contacts.length); i += 200) {
    await withRetry(() => ctx.runMutation(internal.staging.addBatch, {
      jobId, source, accounts: rows.accounts.slice(i, i + 200), contacts: rows.contacts.slice(i, i + 200),
    }));
  }
}

/** Every page of a fill touches the same cells, so concurrent tasks conflict; a mutation that failed never committed. */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= 6) throw error;
      await new Promise((r) => setTimeout(r, 250 * 2 ** attempt + Math.random() * 500));
    }
  }
}

const stagedAccount = v.object({
  discoverySources: v.optional(v.array(discoverySource)),
  domain: v.string(), name: v.string(), nameGuessed: v.optional(v.boolean()), industry: v.optional(v.string()), employees: v.optional(v.number()),
  country: v.optional(v.string()), linkedinUrl: v.optional(v.string()), segmentIds: v.optional(v.array(v.string())), existing: v.boolean(),
});
const stagedContact = v.object({
  accountDomain: v.optional(v.string()), fullName: v.string(), title: v.optional(v.string()), email: v.optional(v.string()),
  linkedinUrl: v.optional(v.string()), existing: v.boolean(),
});

/**
 * Add records to a run. A record the run already holds counts once: an
 * account gains only the fields it lacked (moving to its new cell if that
 * changes a dimension), and a repeated contact is ignored.
 */
export const addBatch = internalMutation({
  args: { jobId: v.id("backgroundJobs"), source: v.string(), accounts: v.array(stagedAccount), contacts: v.array(stagedContact) },
  handler: addStagedBatch,
});

export async function addStagedBatch(ctx: MutationCtx, a: { jobId: Id<"backgroundJobs">; source: string; accounts: typeof stagedAccount.type[]; contacts: typeof stagedContact.type[] }) {
  // A run that was discarded (or approved) takes no more pages from tasks still in flight.
  const run = await ctx.db.query("stagedRuns").withIndex("by_jobId", (q) => q.eq("jobId", a.jobId)).unique();
  if (run?.state !== "collecting") return null;
  for (const acc of a.accounts) {
    const prior = await ctx.db.query("stagedRecords").withIndex("by_jobId_and_kind_and_key", (q) => q.eq("jobId", a.jobId).eq("kind", "account").eq("key", acc.domain)).unique();
    const fields = {
      name: prior && !(prior.nameGuessed && !acc.nameGuessed) ? prior.name! : acc.name,
      nameGuessed: prior ? Boolean(prior.nameGuessed && acc.nameGuessed) : Boolean(acc.nameGuessed),
      industry: prior && prior.industry !== NONE ? prior.industry : acc.industry,
      employees: prior?.employees ?? acc.employees,
      country: prior?.country ?? acc.country,
      linkedinUrl: prior?.linkedinUrl ?? acc.linkedinUrl,
      segmentIds: prior?.segmentIds ?? acc.segmentIds,
      discoverySources: prior?.discoverySources || acc.discoverySources ? unionSources([...(prior?.discoverySources ?? []), ...(acc.discoverySources ?? [])]) : undefined,
    };
    const dims = accountDims(fields, prior?.existing ?? acc.existing);
    const record = { ...defined(fields), ...dims };
    if (!prior) {
      await ctx.db.insert("stagedRecords", { jobId: a.jobId, kind: "account", key: acc.domain, source: a.source, domain: acc.domain, ...record, cell: cellKey("account", dims) });
      await bumpCell(ctx, a.jobId, cellKey("account", dims), 1);
      continue;
    }
    await ctx.db.patch(prior._id, { ...record, cell: cellKey("account", dims) });
    const before = cellKey("account", dimsOf(prior));
    const after = cellKey("account", dims);
    if (before !== after) {
      await bumpCell(ctx, a.jobId, before, -1);
      await bumpCell(ctx, a.jobId, after, 1);
      // Its staged contacts carry the company's dimensions: they move with it, so a selection keeps a contact only with its company.
      for await (const c of ctx.db.query("stagedRecords").withIndex("by_jobId_and_accountDomain", (q) => q.eq("jobId", a.jobId).eq("accountDomain", acc.domain))) {
        const from = dimsOf(c);
        const to = { ...from, region: dims.region, industry: dims.industry, sizeBand: dims.sizeBand };
        await ctx.db.patch(c._id, { region: to.region, industry: to.industry, sizeBand: to.sizeBand, cell: cellKey("contact", to) });
        await bumpCell(ctx, a.jobId, cellKey("contact", from), -1);
        await bumpCell(ctx, a.jobId, cellKey("contact", to), 1);
      }
    }
  }
  for (const c of a.contacts) {
    const key = contactKey(c);
    const prior = await ctx.db.query("stagedRecords").withIndex("by_jobId_and_kind_and_key", (q) => q.eq("jobId", a.jobId).eq("kind", "contact").eq("key", key)).unique();
    if (prior) continue;
    const domain = c.accountDomain ? normDomain(c.accountDomain) : "";
    const company = await ctx.db.query("stagedRecords").withIndex("by_jobId_and_kind_and_key", (q) => q.eq("jobId", a.jobId).eq("kind", "account").eq("key", domain)).unique();
    // A contact needs its company in the run: the CRM attaches it by domain.
    if (!company) continue;
    const dims = contactDims(dimsOf(company), c, c.existing);
    await ctx.db.insert("stagedRecords", {
      jobId: a.jobId, kind: "contact", key, source: a.source, ...dims,
      accountDomain: domain, fullName: c.fullName, ...defined({ title: c.title, email: c.email, linkedinUrl: c.linkedinUrl }),
      cell: cellKey("contact", dims),
    });
    await bumpCell(ctx, a.jobId, cellKey("contact", dims), 1);
  }
  return null;
}

/** The object without its undefined fields (Convex rejects explicit undefined in a document). */
function defined<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, value]) => value !== undefined)) as Partial<T>;
}

/** The name worker's answers for a staged run: replace guessed names (a named account keeps its own). */
export const renameAccounts = internalMutation({
  args: { jobId: v.id("backgroundJobs"), names: v.array(v.object({ domain: v.string(), name: v.string(), linkedinUrl: v.optional(v.string()) })) },
  handler: async (ctx, a) => {
    for (const n of a.names) {
      const row = await ctx.db.query("stagedRecords").withIndex("by_jobId_and_kind_and_key", (q) => q.eq("jobId", a.jobId).eq("kind", "account").eq("key", normDomain(n.domain))).unique();
      if (!row) continue;
      const patch: Partial<Doc<"stagedRecords">> = {};
      if (row.nameGuessed) Object.assign(patch, { name: n.name, nameGuessed: false });
      if (!row.linkedinUrl && n.linkedinUrl) patch.linkedinUrl = n.linkedinUrl;
      if (Object.keys(patch).length) await ctx.db.patch(row._id, patch);
    }
    return null;
  },
});

/**
 * The fill finished: a run still collecting is ready for review. Returns the
 * run's totals for the job's note, or null when the job was not staged.
 */
export async function readyRun(ctx: MutationCtx, jobId: Id<"backgroundJobs">) {
  const run = await ctx.db.query("stagedRuns").withIndex("by_jobId", (q) => q.eq("jobId", jobId)).unique();
  if (!run) return null;
  if (run.state === "collecting") await ctx.db.patch(run._id, { state: "ready" });
  return totalsOf((await readCells(ctx, jobId)).cells);
}

// ───────────────────────────── Review ─────────────────────────────

/** A staged run for its review page: state, the fill's progress, and every cell. */
export const run = query({
  args: { jobId: v.id("backgroundJobs") },
  handler: async (ctx, a) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const run = await ctx.db.query("stagedRuns").withIndex("by_jobId", (q) => q.eq("jobId", a.jobId)).unique();
    if (!run || run.orgId !== user.orgId) return null;
    const job = await ctx.db.get(a.jobId);
    const approvalJob = run.approval ? await ctx.db.get(run.approval.jobId) : null;
    const knows = await knowsExisting(ctx, user);
    const { cells, truncated } = await readCells(ctx, a.jobId, knows);
    return {
      title: run.title,
      state: run.state,
      createdAt: run.createdAt,
      expiresAt: run.expiresAt,
      canApprove: isManager(user),
      knowsExisting: knows,
      fill: job ? { status: job.status, detail: job.detail ?? null, phases: job.phases } : null,
      approval: run.approval
        ? { accounts: run.approval.accounts, contacts: run.approval.contacts, status: approvalJob?.status ?? null, detail: approvalJob?.detail ?? null, phases: approvalJob?.phases ?? [] }
        : null,
      cells,
      truncated,
    };
  },
});

/** A few staged records the selection keeps, to eyeball before approving. */
export const sample = query({
  args: { jobId: v.id("backgroundJobs"), kind: v.union(v.literal("account"), v.literal("contact")), selection: selectionValidator, limit: v.optional(v.number()) },
  handler: async (ctx, a) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    const run = await ctx.db.query("stagedRuns").withIndex("by_jobId", (q) => q.eq("jobId", a.jobId)).unique();
    if (!run || run.orgId !== user.orgId) return [];
    const limit = Math.min(a.limit ?? 50, 100);
    const knows = await knowsExisting(ctx, user);
    const selection = blindSelection(a.selection as Selection, knows);
    const out: Doc<"stagedRecords">[] = [];
    // Read through the cells the selection keeps, so a rare selection still finds its records.
    // (With keyword filters the page samples from keywordCells instead.)
    const cells = await ctx.db.query("stagedCells").withIndex("by_jobId_and_cell", (q) => q.eq("jobId", a.jobId)).take(CELLS_MAX);
    for (const c of cells) {
      if (out.length >= limit) break;
      const cell = cellFromKey(c.cell, c.count);
      if (cell.kind !== a.kind || c.count <= 0 || !selects(a.kind, cell.dims, selection)) continue;
      out.push(...await ctx.db.query("stagedRecords").withIndex("by_jobId_and_cell", (q) => q.eq("jobId", a.jobId).eq("cell", c.cell)).take(limit - out.length));
    }
    // A run staged before records carried their cell: scan them, bounded.
    let scanned = 0;
    if (out.length < limit) {
      for await (const r of ctx.db.query("stagedRecords").withIndex("by_jobId_and_kind_and_key", (q) => q.eq("jobId", a.jobId).eq("kind", a.kind))) {
        if (++scanned > LEGACY_SAMPLE_SCAN || out.length >= limit) break;
        if (r.cell === undefined && selects(a.kind, dimsOf(r), selection)) out.push(r);
      }
    }
    return out.map((r) => sampleRow(r, knows));
  },
});

/** A staged record as the review page's sample table shows it; `knows`: whether the viewer is told it is already in the CRM (knowsExisting). */
const sampleRow = (r: Doc<"stagedRecords">, knows: boolean) => ({
  id: r._id, discoverySources: r.discoverySources ?? [], existing: knows && r.existing, region: r.region, industry: r.industry, sizeBand: r.sizeBand, seniority: r.seniority ?? null, department: r.department ?? null,
  name: r.name ?? null, domain: r.domain ?? null, fullName: r.fullName ?? null, title: r.title ?? null, accountDomain: r.accountDomain ?? null, linkedinUrl: r.linkedinUrl ?? null,
});

export const keywordPage = internalQuery({
  args: { jobId: v.id("backgroundJobs"), kind: v.union(v.literal("account"), v.literal("contact")), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, a) => {
    const user = await getCurrentUser(ctx);
    const run = await ctx.db.query("stagedRuns").withIndex("by_jobId", (q) => q.eq("jobId", a.jobId)).unique();
    if (!user || !run || run.orgId !== user.orgId) throw new ConvexError("This run is gone.");
    const page = await ctx.db.query("stagedRecords")
      .withIndex("by_jobId_and_kind_and_key", (q) => q.eq("jobId", a.jobId).eq("kind", a.kind))
      .paginate({ numItems: KEYWORD_PAGE, cursor: a.cursor });
    const knows = await knowsExisting(ctx, user);
    const rows = page.page.map((r) => ({ ...sampleRow(r, knows), cell: cellKey(a.kind, { ...dimsOf(r), existing: knows && r.existing }) }));
    return { rows, next: page.isDone ? null : page.continueCursor };
  },
});

type SampleRow = ReturnType<typeof sampleRow>;

/**
 * What the cells can't count: the run's cells over the records that pass the
 * keyword filters and, with accountsWithContacts, only the companies of the
 * contacts the whole selection keeps. The review page's totals and breakdowns
 * (totalsOf, facetOf) run on these cells; a few of each cell's records come
 * along, so its sample follows the facets without another read. Contacts are
 * counted by keywords only, so their facets still show every key.
 */
export const countSelection = action({
  args: { jobId: v.id("backgroundJobs"), selection: selectionValidator },
  handler: async (ctx, a): Promise<{ cells: Cell[]; sample: Array<SampleRow & { kind: StagedKind; cell: string }> }> => {
    const s = a.selection as Selection;
    const k = hasKeywords(s.keywords) ? s.keywords : undefined;
    const counts = new Map<string, number>();
    const sample: Array<SampleRow & { kind: StagedKind; cell: string }> = [];
    const add = (r: SampleRow & { cell: string }, kind: StagedKind) => {
      const n = (counts.get(r.cell) ?? 0) + 1;
      counts.set(r.cell, n);
      if (n <= KEYWORD_SAMPLE_PER_CELL && sample.length < KEYWORD_SAMPLE_MAX) sample.push({ ...r, kind });
    };
    const companies = new Map<string, { name?: string; domain?: string }>();
    // Companies wait until a contact the selection keeps names them.
    const held = s.accountsWithContacts ? new Map<string, SampleRow & { cell: string }>() : null;
    const named = new Set<string>();
    for (const kind of ["account", "contact"] as const) {
      let cursor: string | null = null;
      do {
        const page: { rows: Array<SampleRow & { cell: string }>; next: string | null } = await ctx.runQuery(internal.staging.keywordPage, { jobId: a.jobId, kind, cursor });
        for (const r of page.rows) {
          const text = { title: r.title ?? undefined, name: r.name ?? undefined, domain: r.domain ?? undefined };
          if (kind === "account" && text.domain) companies.set(text.domain, text);
          if (!keywordsPass(kind, text, kind === "account" ? text : companies.get(r.accountDomain ?? ""), k)) continue;
          if (held && kind === "account" && text.domain) {
            held.set(text.domain, r);
            continue;
          }
          if (held && kind === "contact" && r.accountDomain && selects("contact", cellFromKey(r.cell, 1).dims, s)) named.add(r.accountDomain);
          add(r, kind);
        }
        cursor = page.next;
      } while (cursor);
    }
    for (const domain of named) {
      const r = held?.get(domain);
      if (r) add(r, "account");
    }
    return { cells: [...counts].map(([key, count]) => cellFromKey(key, count)), sample };
  },
});

async function managedRun(ctx: MutationCtx, jobId: Id<"backgroundJobs">) {
  const user = await getCurrentUser(ctx);
  if (!user) throw new ConvexError("Not authenticated");
  if (!isManager(user)) throw new ConvexError("Only admins and managers can add or discard staged records.");
  const run = await ctx.db.query("stagedRuns").withIndex("by_jobId", (q) => q.eq("jobId", jobId)).unique();
  if (!run || run.orgId !== user.orgId) throw new ConvexError("This run is gone.");
  return { user, run };
}

/** Add what the selection keeps to the CRM, as its own tray job. */
export const approve = mutation({
  args: {
    jobId: v.id("backgroundJobs"),
    selection: selectionValidator,
    /** What the page counted for keywords or accountsWithContacts (countSelection), which cells can't: the job's label and progress total. */
    counted: v.optional(v.object({ accounts: v.number(), contacts: v.number() })),
  },
  handler: async (ctx, a): Promise<{ approvalJobId: Id<"backgroundJobs"> }> => {
    const { user, run } = await managedRun(ctx, a.jobId);
    if (run.state !== "ready") throw new ConvexError(run.state === "collecting" ? "The fill is still running. Approve once it finishes." : "This run was already approved or discarded.");
    // A reviewer not told what the CRM has (knowsExisting) cannot split the run on it, nor learn it from the count.
    const knows = await knowsExisting(ctx, user);
    const selection = blindSelection(a.selection, knows);
    const totals = totalsOf((await readCells(ctx, a.jobId, knows)).cells, selection as Selection);
    // Keywords and accountsWithContacts only narrow the selection: the page's count, never more than the cells allow.
    if (needsCount(selection as Selection) && a.counted) {
      totals.accounts = Math.min(totals.accounts, a.counted.accounts);
      totals.contacts = Math.min(totals.contacts, a.counted.contacts);
    }
    if (!totals.accounts && !totals.contacts) throw new ConvexError("The selection keeps nothing. Widen it, or discard the run.");
    const now = Date.now();
    const approvalJobId = await ctx.db.insert("backgroundJobs", {
      orgId: run.orgId, kind: "contact_sweep", title: `Add ${fmt(totals.accounts)} accounts and ${fmt(totals.contacts)} contacts`,
      detail: "Adding the records you approved…", href: "/dashboard/contacts", status: "processing", startedAt: now, updatedAt: now,
      // With accountsWithContacts the companies are written alongside their contacts, so the progress counts contacts.
      phases: [{ key: "add", label: "Adding records", status: "processing", count: 0, done: 0, total: (a.selection.accountsWithContacts ? 0 : totals.accounts) + totals.contacts }],
    });
    await ctx.db.patch(run._id, {
      state: "approving",
      approval: { jobId: approvalJobId, selection, accounts: totals.accounts, contacts: totals.contacts, byUserId: user._id },
    });
    await ctx.scheduler.runAfter(0, internal.staging.promote, { jobId: a.jobId, kind: "account", cursor: null, added: 0 });
    return { approvalJobId };
  },
});

/** Drop a run without adding anything. */
export const discard = mutation({
  args: { jobId: v.id("backgroundJobs") },
  handler: async (ctx, a) => {
    const { run } = await managedRun(ctx, a.jobId);
    if (run.state !== "ready" && run.state !== "collecting") throw new ConvexError("This run was already approved or discarded.");
    // A fill still running stops; its tasks see the stop and settle.
    if (run.state === "collecting") {
      const job = await ctx.db.get(a.jobId);
      if (job?.status === "processing") await ctx.db.patch(a.jobId, { counters: { ...(job.counters ?? {}), stopped: 1, stoppedByUser: 1 } });
    }
    await ctx.db.patch(run._id, { state: "discarding" });
    await ctx.scheduler.runAfter(0, internal.staging.purge, { jobId: a.jobId });
    return null;
  },
});

const fmt = (n: number) => n.toLocaleString("en-US");

// ───────────────────────────── Approval ─────────────────────────────

/** The staged accounts of these domains. */
export const stagedAccounts = internalQuery({
  args: { jobId: v.id("backgroundJobs"), domains: v.array(v.string()) },
  handler: async (ctx, a) => {
    const out: Doc<"stagedRecords">[] = [];
    for (const domain of a.domains) {
      const row = await ctx.db.query("stagedRecords").withIndex("by_jobId_and_kind_and_key", (q) => q.eq("jobId", a.jobId).eq("kind", "account").eq("key", domain)).unique();
      if (row) out.push(row);
    }
    return out;
  },
});

export const promotePage = internalQuery({
  args: { jobId: v.id("backgroundJobs"), kind: v.union(v.literal("account"), v.literal("contact")), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, a) => {
    const run = await ctx.db.query("stagedRuns").withIndex("by_jobId", (q) => q.eq("jobId", a.jobId)).unique();
    const page = await ctx.db.query("stagedRecords")
      .withIndex("by_jobId_and_kind_and_key", (q) => q.eq("jobId", a.jobId).eq("kind", a.kind))
      .paginate({ numItems: PROMOTE_PAGE, cursor: a.cursor });
    return { run, rows: page.page, next: page.isDone ? null : page.continueCursor };
  },
});

/**
 * Write one page of the approved selection, then schedule the next: every
 * account first, then the contacts (the CRM attaches a contact to its
 * account by domain). Fill-only, with content-addressed keys, so a retried
 * page is a no-op.
 */
/** Write staged records to the CRM, fill-only, one write per source so each keeps the source that found it. */
async function writePage(ctx: ActionCtx, ws: string, jobId: Id<"backgroundJobs">, kind: StagedKind, rows: Doc<"stagedRecords">[]) {
  for (const source of new Set(rows.map((r) => r.source))) {
    const group = rows.filter((r) => r.source === source);
    if (kind === "account") {
      const records: AccountInput[] = group.map((r) => ({
        domain: r.domain!, name: r.name!,
        ...defined({ employees: r.employees, country: r.country, linkedinUrl: r.linkedinUrl, segmentIds: r.segmentIds, industry: r.industry === NONE ? undefined : r.industry }),
      }));
      await clientFor(ctx).upsertAccounts(ws, { records, source, idempotencyKey: batchKey(`approve:${jobId}`, "a", records), fill: "missing" });
    } else {
      const records: ContactInput[] = group.map((r) => ({ accountDomain: r.accountDomain!, fullName: r.fullName!, ...defined({ title: r.title, email: r.email, linkedinUrl: r.linkedinUrl }) }));
      await clientFor(ctx).upsertContacts(ws, { records, source, idempotencyKey: batchKey(`approve:${jobId}`, "c", records), fill: "missing" });
    }
  }
}

/** The access of a fill's approver, or null when they are no longer a member. */
export const approverAccess = internalQuery({
  args: { orgId: v.id("organizations"), userId: v.id("users") },
  handler: (ctx, a) => principalAccess(ctx, a.orgId, [a.userId]),
});

/**
 * The staged rows an approval may write as `approverId`: all of them for a
 * role that sees every company and person; otherwise none that lands on a
 * record already in the CRM which the approver cannot see (an existing company
 * by its domain, an existing person by their email, or a person whose company
 * is such a company).
 */
async function writableFor(ctx: ActionCtx, ws: string, approverId: Id<"users">) {
  const accesses = await ctx.runQuery(internal.staging.approverAccess, { orgId: ws as Id<"organizations">, userId: approverId });
  if (!accesses) throw new Error("The approver is no longer a member of this workspace");
  if (accesses.every((x) => seesEveryRecord(x, "account") && seesEveryRecord(x, "contact"))) return async (_k: StagedKind, rows: Doc<"stagedRecords">[]) => rows;
  const all = clientFor(ctx);
  const theirs = principalClient(ctx, ws, accesses);
  const hidden = async (object: "account" | "contact", field: "domain" | "email", values: string[]) => {
    const [exist, seen] = await Promise.all([visibleValues(all, ws, object, field, values), visibleValues(theirs, ws, object, field, values)]);
    return new Set([...exist].filter((x) => !seen.has(x)));
  };
  const lower = (s: string | undefined) => (s ?? "").toLowerCase();
  return async (kind: StagedKind, rows: Doc<"stagedRecords">[]) => {
    if (!rows.length) return rows;
    const domains = await hidden("account", "domain", rows.map((r) => lower(kind === "account" ? r.domain : r.accountDomain)));
    if (kind === "account") return rows.filter((r) => !domains.has(lower(r.domain)));
    const emails = await hidden("contact", "email", rows.flatMap((r) => (r.email ? [lower(r.email)] : [])));
    return rows.filter((r) => !domains.has(lower(r.accountDomain)) && !(r.email && emails.has(lower(r.email))));
  };
}

export const promote = internalAction({
  args: { jobId: v.id("backgroundJobs"), kind: v.union(v.literal("account"), v.literal("contact")), cursor: v.union(v.string(), v.null()), added: v.number(), attempt: v.optional(v.number()) },
  handler: async (ctx, a) => {
    const { run, rows, next } = await ctx.runQuery(internal.staging.promotePage, { jobId: a.jobId, kind: a.kind, cursor: a.cursor });
    if (!run?.approval || run.state !== "approving") return null;
    const selection = run.approval.selection as Selection;
    if (a.kind === "account" && selection.accountsWithContacts) {
      // Only the companies of kept contacts: they're written with their contacts.
      await ctx.scheduler.runAfter(0, internal.staging.promote, { jobId: a.jobId, kind: "contact", cursor: null, added: a.added });
      return null;
    }
    let kept = rows.filter((r) => selects(a.kind as StagedKind, dimsOf(r), selection));
    const k = selection.keywords;
    if (hasKeywords(k)) {
      // A contact passes the company keywords through its staged company.
      const companies = a.kind === "contact" && k.company
        ? new Map((await ctx.runQuery(internal.staging.stagedAccounts, { jobId: a.jobId, domains: [...new Set(kept.map((r) => r.accountDomain!))] })).map((c) => [c.domain!, c]))
        : null;
      kept = kept.filter((r) => keywordsPass(a.kind as StagedKind, r, a.kind === "account" ? r : companies?.get(r.accountDomain!), k));
    }
    const ws = run.orgId as string;
    try {
      // The approver's write never reaches a company or person their role hides (CP14): one already in the CRM that
      // they cannot see is skipped, and so is a person whose company is. Skipped rather than refused: a refusal with a
      // count would tell them how many records others own, and would block the rest of the fill.
      const writable = await writableFor(ctx, ws, run.approval.byUserId);
      kept = await writable(a.kind as StagedKind, kept);
      if (a.kind === "contact" && kept.length) {
        // A kept contact's company must exist before the contact is written. The selection
        // keeps it already unless the "already in your CRM" filter split them, or it keeps
        // only the companies of kept contacts; write those (fill-only) with the contacts.
        const domains = [...new Set(kept.map((r) => r.accountDomain!))];
        const companies = await ctx.runQuery(internal.staging.stagedAccounts, { jobId: a.jobId, domains });
        await writePage(ctx, ws, a.jobId, "account", await writable("account", companies.filter((r) => selection.accountsWithContacts || !selects("account", dimsOf(r), selection))));
      }
      await writePage(ctx, ws, a.jobId, a.kind, kept);
    } catch (error) {
      const attempt = (a.attempt ?? 0) + 1;
      const message = error instanceof Error ? error.message.slice(0, 300) : String(error);
      if (attempt < 5) {
        console.warn(`staged approval page failed (attempt ${attempt}), retrying: ${message}`);
        await ctx.scheduler.runAfter(5_000 * attempt, internal.staging.promote, { ...a, attempt });
        return null;
      }
      await ctx.runMutation(internal.staging.settleApproval, { jobId: a.jobId, added: a.added, error: message });
      return null;
    }
    const added = a.added + kept.length;
    if (next) {
      await ctx.runMutation(internal.staging.approvalProgress, { jobId: a.jobId, added });
      await ctx.scheduler.runAfter(0, internal.staging.promote, { jobId: a.jobId, kind: a.kind, cursor: next, added });
    } else if (a.kind === "account") {
      await ctx.runMutation(internal.staging.approvalProgress, { jobId: a.jobId, added });
      await ctx.scheduler.runAfter(0, internal.staging.promote, { jobId: a.jobId, kind: "contact", cursor: null, added });
    } else {
      await ctx.runMutation(internal.staging.settleApproval, { jobId: a.jobId, added });
    }
    return null;
  },
});

export const approvalProgress = internalMutation({
  args: { jobId: v.id("backgroundJobs"), added: v.number() },
  handler: async (ctx, a) => {
    const run = await ctx.db.query("stagedRuns").withIndex("by_jobId", (q) => q.eq("jobId", a.jobId)).unique();
    const job = run?.approval ? await ctx.db.get(run.approval.jobId) : null;
    if (!job || job.status !== "processing") return null;
    const phase = job.phases[0];
    await ctx.db.patch(job._id, {
      detail: `${fmt(a.added)} of ${fmt(phase?.total ?? 0)} records added…`,
      phases: [{ ...phase, count: a.added, done: a.added }],
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const settleApproval = internalMutation({
  args: { jobId: v.id("backgroundJobs"), added: v.number(), error: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const run = await ctx.db.query("stagedRuns").withIndex("by_jobId", (q) => q.eq("jobId", a.jobId)).unique();
    if (!run?.approval || run.state !== "approving") return null;
    const now = Date.now();
    const status = a.error ? "failed" : "completed";
    const job = await ctx.db.get(run.approval.jobId);
    if (job) {
      await ctx.db.patch(job._id, {
        status, updatedAt: now, completedAt: now,
        detail: a.error
          ? `Stopped after ${fmt(a.added)} records: ${a.error}`
          : `Added ${fmt(run.approval.accounts)} accounts and ${fmt(run.approval.contacts)} contacts. Records already in your CRM only gained the fields they were missing.`,
        phases: job.phases.map((p) => ({ ...p, status, count: a.added, done: a.added })),
        ...(a.error ? { error: a.error } : {}),
      });
    }
    // A failed approval can be retried from the review page: the pages already written are no-ops.
    await ctx.db.patch(run._id, a.error ? { state: "ready", approval: undefined } : { state: "approved" });
    return null;
  },
});

// ───────────────────────────── Discard and expiry ─────────────────────────────

/** Delete a run's staged records and cells a page at a time. Its state ends as discarded unless it was approved. */
export const purge = internalMutation({
  args: { jobId: v.id("backgroundJobs") },
  handler: async (ctx, a) => {
    const records = await ctx.db.query("stagedRecords").withIndex("by_jobId_and_kind_and_key", (q) => q.eq("jobId", a.jobId)).take(PURGE_PAGE);
    for (const r of records) await ctx.db.delete(r._id);
    const cells = records.length < PURGE_PAGE
      ? await ctx.db.query("stagedCells").withIndex("by_jobId_and_cell", (q) => q.eq("jobId", a.jobId)).take(PURGE_PAGE)
      : [];
    for (const c of cells) await ctx.db.delete(c._id);
    if (records.length === PURGE_PAGE || cells.length === PURGE_PAGE) {
      await ctx.scheduler.runAfter(0, internal.staging.purge, a);
      return null;
    }
    const run = await ctx.db.query("stagedRuns").withIndex("by_jobId", (q) => q.eq("jobId", a.jobId)).unique();
    if (run && run.state !== "approved") await ctx.db.patch(run._id, { state: "discarded" });
    return null;
  },
});

/** Drop runs nobody approved in time, and the staged copies of approved ones (cron). */
export const expire = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    for (const state of ["ready", "approved"] as const) {
      const due = await ctx.db.query("stagedRuns").withIndex("by_state_and_expiresAt", (q) => q.eq("state", state).lt("expiresAt", now)).take(20);
      for (const run of due) {
        if (state === "ready") await ctx.db.patch(run._id, { state: "discarding" });
        else await ctx.db.patch(run._id, { expiresAt: Number.MAX_SAFE_INTEGER });
        await ctx.scheduler.runAfter(0, internal.staging.purge, { jobId: run.jobId });
      }
    }
    return null;
  },
});
