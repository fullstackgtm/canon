/**
 * Bring a whole HubSpot portal across (CP12): the import run's state and its writes. The steps that read HubSpot
 * are hubspotImportActions.ts; the order and the mapping are lib/hubspotImport.ts. Nothing here writes to HubSpot.
 */
import { can, refusal } from "./lib/capabilities";
import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUser, requireCap } from "./lib";
import { accessFor } from "./permissions";
import { narrowsReads } from "./lib/access";

import { edgeStore } from "./associations";
import { dealOfStream, legacyRolesOf } from "./dealCommittee";
import { applyEdgeCommand, seedDealRoles, type EdgeCommand } from "./lib/objects/associations";
import { DEAL_ROLES, STANDARD_OBJECTS, resolveObjectDef, type DealRole, type OrgObjectExtension } from "./lib/objects/registry";
import { fromStored, toStored } from "./lib/objects/validators";
import { ID } from "./lib/canon/identity";
import { asEntry, asState, convexObjectStore, loadDef } from "./objects";
import { appendObservations } from "./observations";
import { save, type SaveCommand } from "./lib/objects/write";
import { foldAll, project } from "./lib/objects/fold";
import { fieldValue } from "./lib/objects/validators";
import { IMPORT_OBJECTS, planHubspotPipelines, type CustomField, type ImportObject } from "./lib/hubspotImport";
import { addField, updateField } from "./lib/objects/fieldBuilder";
import { RegistryError } from "./lib/objects/registry";
import { scheduleNudge } from "./ledgerFeed";
import { saveDealValues, saveParty, survivorOf } from "./canon";
import type { DealValues } from "./lib/canon/dealLedger";

/** A run whose heartbeat is older than this stopped (its step failed or was lost); it may be resumed. */
const STALE_MS = 10 * 60 * 1000;
/** Failures one run keeps for the screen; the counts stay exact. */
const FAILURES_MAX = 50;

const objectsArg = v.array(v.union(...IMPORT_OBJECTS.map((o) => v.literal(o))));
const resultArg = v.object({ object: v.string(), read: v.number(), written: v.number(), failed: v.number() });
const failureArg = v.object({ object: v.string(), id: v.string(), message: v.string() });
const noticeArg = v.object({ object: v.string(), message: v.string() });
const ownerArg = v.object({
  crmOwnerId: v.string(), name: v.string(), email: v.union(v.string(), v.null()), archived: v.boolean(),
  userId: v.union(v.string(), v.null()), member: v.boolean(), records: v.number(),
});

const customFieldArg = v.object({
  object: v.union(v.literal("account"), v.literal("contact"), v.literal("deal")), property: v.string(), apiName: v.string(),
  type: v.string(), options: v.array(v.object({ hubspot: v.string(), canon: v.string() })),
});

const hubspotOf = (ctx: { db: any }, orgId: Id<"organizations">) =>
  ctx.db.query("integrations").withIndex("by_orgId_provider", (q: any) => q.eq("orgId", orgId).eq("provider", "hubspot")).first() as Promise<Doc<"integrations"> | null>;

const latestRun = (ctx: { db: any }, orgId: Id<"organizations">) =>
  ctx.db.query("crmImports").withIndex("by_orgId_startedAt", (q: any) => q.eq("orgId", orgId)).order("desc").first() as Promise<Doc<"crmImports"> | null>;

const isStale = (run: Doc<"crmImports">) => run.status === "running" && Date.now() - run.heartbeatAt > STALE_MS;

/** The import screen: whether HubSpot is connected, and the latest run. */
export const latest = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const [integration, run] = await Promise.all([hubspotOf(ctx, user.orgId), latestRun(ctx, user.orgId)]);
    // A failure and a spot-check mismatch name a record: only a role that sees every record is shown them (CP14).
    const access = await accessFor(ctx, user);
    const whole = !narrowsReads(access) && !access.preview;
    return {
      connected: Boolean(integration?.isActive),
      displayName: integration?.displayName ?? null,
      canImport: can(user, "imports.run"),
      run: run ? { ...run, ...(whole ? {} : { failures: [], spotCheck: undefined }), stale: isStale(run) } : null,
    };
  },
});

/** Start importing the chosen objects from the connected portal. Admins and managers; one run at a time. */
export const start = mutation({
  args: { objects: objectsArg },
  handler: async (ctx, args): Promise<Id<"crmImports">> => {
    const user = await requireCap(ctx, "imports.run");
    const integration = await hubspotOf(ctx, user.orgId);
    if (!integration?.isActive) throw new ConvexError("Connect HubSpot first");
    const objects = IMPORT_OBJECTS.filter((o) => args.objects.includes(o));
    if (!objects.length) throw new ConvexError("Pick something to import");
    const running = await latestRun(ctx, user.orgId);
    if (running?.status === "running" && !isStale(running)) throw new ConvexError("An import is already running");
    const now = Date.now();
    const runId = await ctx.db.insert("crmImports", {
      orgId: user.orgId, provider: "hubspot", status: "running", startedBy: user._id, startedAt: now, heartbeatAt: now, parentLinksAs: "hubspot", linksAs: "hubspot",
      objects, phase: "owners", cursor: null, lease: 1, results: [], failures: [], owners: [], notices: [],
    });
    await ctx.scheduler.runAfter(0, internal.hubspotImportActions.step, { runId, lease: 1 });
    return runId;
  },
});

/** Carry on a run that failed or stopped from the phase and page it reached. */
export const resume = mutation({
  args: { runId: v.id("crmImports") },
  handler: async (ctx, args) => {
    const user = await requireCap(ctx, "imports.run");
    const run = await ctx.db.get(args.runId);
    if (!run || run.orgId !== user.orgId) throw new ConvexError("Import not found");
    if (run.status === "completed" || (run.status === "running" && !isStale(run))) throw new ConvexError("This import is not stopped");
    const lease = run.lease + 1;
    await ctx.db.patch(run._id, { status: "running", lease, heartbeatAt: Date.now(), error: undefined });
    await ctx.scheduler.runAfter(0, internal.hubspotImportActions.step, { runId: run._id, lease });
    return null;
  },
});

/** The signed-in admin or manager an import action runs for. */
export const importer = internalQuery({
  args: {},
  handler: async (ctx) => {
    const user = await requireCap(ctx, "imports.run");
    return { orgId: user.orgId, userId: user._id };
  },
});

export const runOf = internalQuery({
  args: { runId: v.id("crmImports") },
  handler: (ctx, args) => ctx.db.get(args.runId),
});

/** The org's HubSpot field mappings, read by every records page. */
export const mappingsOf = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => (await hubspotOf(ctx, args.orgId))?.fieldMappings ?? null,
});

const addResults = (rows: Doc<"crmImports">["results"], add: Doc<"crmImports">["results"]) => {
  const out = rows.map((r) => ({ ...r }));
  for (const a of add) {
    const row = out.find((r) => r.object === a.object);
    if (row) Object.assign(row, { read: row.read + a.read, written: row.written + a.written, failed: row.failed + a.failed });
    else out.push({ ...a });
  }
  return out;
};

/**
 * Record what one step did (several pages, and at a parallel stage each lane's) and where the run is now, then
 * schedule the next step. A step under an old lease (the run was resumed meanwhile) changes nothing, so no page is
 * written by two steps at once. `lanes` is left out once the run is past a parallel stage, which clears them.
 */
export const advance = internalMutation({
  args: {
    runId: v.id("crmImports"), lease: v.number(), phase: v.string(), cursor: v.union(v.string(), v.null()),
    lanes: v.optional(v.array(v.object({ phase: v.string(), cursor: v.union(v.string(), v.null()), done: v.boolean() }))),
    results: v.array(resultArg), failures: v.array(failureArg), notices: v.array(noticeArg),
    owners: v.optional(v.array(ownerArg)),
    customFields: v.optional(v.array(customFieldArg)),
    ownerRecords: v.optional(v.array(v.object({ crmOwnerId: v.string(), records: v.number() }))),
    error: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const run = await ctx.db.get(a.runId);
    if (!run || run.lease !== a.lease || run.status !== "running") return null;
    const now = Date.now();
    const owners = (a.owners ?? run.owners).map((o) => ({ ...o, records: o.records + (a.ownerRecords?.find((r) => r.crmOwnerId === o.crmOwnerId)?.records ?? 0) }));
    const notices = [...run.notices];
    for (const n of a.notices) if (!notices.some((x) => x.object === n.object && x.message === n.message)) notices.push(n);
    const done = a.phase === "done";
    await ctx.db.patch(run._id, {
      phase: a.phase, cursor: a.cursor, lanes: a.lanes, heartbeatAt: now, results: addResults(run.results, a.results),
      failures: [...run.failures, ...a.failures].slice(0, FAILURES_MAX), notices, owners, ...(a.customFields ? { customFields: a.customFields } : {}),
      ...(a.error !== undefined ? { status: "failed" as const, error: a.error.slice(0, 500) } : done ? { status: "completed" as const, finishedAt: now } : {}),
    });
    if (a.error === undefined && !done) await ctx.scheduler.runAfter(0, internal.hubspotImportActions.step, { runId: run._id, lease: a.lease });
    return null;
  },
});

/** Users with these (lowercased) emails, and whether each is a CRM sync's placeholder rather than a member. */
export const usersByEmail = internalQuery({
  args: { orgId: v.id("organizations"), emails: v.array(v.string()) },
  handler: async (ctx, args) => {
    const found = await Promise.all(args.emails.map((email) => ctx.db.query("users").withIndex("by_orgId_email", (q) => q.eq("orgId", args.orgId).eq("email", email)).first()));
    return found.flatMap((u, i) => (u ? [{ email: args.emails[i], userId: u._id as string, placeholder: /^(hubspot|salesforce):/.test(u.clerkUserId) }] : []));
  },
});

/** The mirror's crmAccounts rows for these HubSpot company ids. */
export const accountRows = internalQuery({
  args: { orgId: v.id("organizations"), crmIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const rows = await Promise.all(args.crmIds.map((crmId) => ctx.db.query("crmAccounts").withIndex("by_orgId_crmId", (q) => q.eq("orgId", args.orgId).eq("crmId", crmId)).first()));
    return rows.flatMap((r) => (r ? [{ crmId: r.crmId, id: r._id }] : []));
  },
});

/**
 * Each HubSpot company's or person's ledger stream (merged records resolve to their survivor) and the key the
 * register lists it by: its domain or email.
 */
export const partyRefs = internalQuery({
  args: { orgId: v.id("organizations"), object: v.union(v.literal("account"), v.literal("contact")), crmIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const provider = args.object === "account" ? ID.crmAccount("hubspot") : ID.crmContact("hubspot");
    return Promise.all(args.crmIds.map(async (crmId) => {
      const ext = await ctx.db.query("canonExternalIds").withIndex("by_orgId_provider_externalId", (q) => q.eq("orgId", args.orgId).eq("provider", provider).eq("externalId", crmId)).first();
      const row = args.object === "account"
        ? await ctx.db.query("crmAccounts").withIndex("by_orgId_crmId", (q) => q.eq("orgId", args.orgId).eq("crmId", crmId)).first()
        : await ctx.db.query("crmContacts").withIndex("by_orgId_crmId", (q) => q.eq("orgId", args.orgId).eq("crmId", crmId)).first();
      const key = row ? (args.object === "account" ? (row as Doc<"crmAccounts">).domain : (row as Doc<"crmContacts">).email) : undefined;
      return { crmId, streamId: ext ? ((await survivorOf(ctx, ext.entityId)) as string) : null, key: key?.trim().toLowerCase() || null };
    }));
  },
});

/** A deal stream's custom field values, from its hot row (deals keep one). */
async function customOf(ctx: { db: any }, orgId: Id<"organizations">, streamId: Id<"canonEntities">): Promise<Record<string, unknown>> {
  const row = await ctx.db.query("recordRows").withIndex("by_orgId_streamId", (q: any) => q.eq("orgId", orgId).eq("streamId", streamId)).unique();
  if (!row) return {};
  const def = await loadDef(ctx as never, orgId, "deal");
  const projected = project(def, asState(row));
  return Object.fromEntries(Object.entries(projected.values).filter(([k]) => k.startsWith("custom.")));
}

/** The deals rows and streams of these HubSpot deal ids, with what the spot check compares. */
export const dealRefs = internalQuery({
  args: { orgId: v.id("organizations"), crmIds: v.array(v.string()) },
  handler: async (ctx, args) => Promise.all(args.crmIds.map(async (crmId) => {
    const deal = await ctx.db.query("deals").withIndex("by_orgId_crmId", (q) => q.eq("orgId", args.orgId).eq("crmId", crmId)).first();
    if (!deal) return { crmId, deal: null };
    const stream = await ctx.db.query("canonEntities").withIndex("by_orgId_projectionId", (q) => q.eq("orgId", args.orgId).eq("projectionId", deal._id)).first();
    const account = deal.accountId ? await ctx.db.get(deal.accountId) : null;
    const people = stream
      ? (await ctx.db.query("associations").withIndex("by_orgId_association_fromId_toId", (q) => q.eq("orgId", args.orgId).eq("association", "deal_contact").eq("fromId", stream._id)).take(200))
        .filter((e) => e.active).map((e) => `${e.toId}:${e.label}`)
      : [];
    return {
      crmId,
      deal: {
        streamId: stream?._id ?? null, name: deal.name, amount: deal.amount ?? null, stage: deal.stage ?? null, closeDate: deal.closeDate,
        ownerId: deal.primaryRepId ?? null, company: account?.crmId ?? null, createdAt: deal.createdAt, isClosed: deal.isClosed, isWon: deal.isWon, people,
        custom: stream ? await customOf(ctx, args.orgId, stream._id) : {},
      },
    };
  })),
});

const stageArg = v.object({ id: v.string(), label: v.string(), displayOrder: v.optional(v.number()), archived: v.optional(v.boolean()), metadata: v.optional(v.object({ probability: v.optional(v.string()), isClosed: v.optional(v.string()) })) });
const pipelineArg = v.object({ id: v.string(), label: v.string(), displayOrder: v.optional(v.number()), archived: v.optional(v.boolean()), stages: v.array(stageArg) });

/** Make the org's deal pipelines HubSpot's (planHubspotPipelines): stage options with HubSpot's labels, then the pipeline rows. */
export const writePipelines = internalMutation({
  args: { orgId: v.id("organizations"), pipelines: v.array(pipelineArg) },
  handler: async (ctx, a) => {
    const defRow = await ctx.db.query("objectDefs").withIndex("by_orgId_apiName", (q) => q.eq("orgId", a.orgId).eq("apiName", "deal")).unique();
    const ext = defRow ? fromStored<OrgObjectExtension>(defRow) : undefined;
    const field = resolveObjectDef(STANDARD_OBJECTS.deal, ext).byApiName.get("stage");
    const options = field && "options" in field ? field.options : [];
    const rows = await ctx.db.query("dealPipelines").withIndex("by_orgId", (q) => q.eq("orgId", a.orgId)).take(100);
    const plan = planHubspotPipelines(options, rows.map((r) => ({ id: r._id as string, name: r.name, stages: r.stages, createdAt: r.createdAt })), a.pipelines);
    const picklistOptions = toStored({ ...ext?.picklistOptions, stage: plan.options });
    if (defRow) await ctx.db.patch(defRow._id, { picklistOptions, updatedAt: Date.now() });
    else await ctx.db.insert("objectDefs", { orgId: a.orgId, apiName: "deal", registryVersion: 0, customFields: [], picklistOptions, updatedAt: Date.now() });
    let createdAt = Date.now();
    for (const w of plan.writes) {
      if (w.kind === "insert") await ctx.db.insert("dealPipelines", { orgId: a.orgId, name: w.name, stages: w.stages, createdAt: createdAt++ });
      else await ctx.db.patch(w.id as Id<"dealPipelines">, { name: w.name, stages: w.stages });
    }
    return { pipelines: a.pipelines.filter((p) => !p.archived).length };
  },
});

const linkArg = v.union(
  v.object({ kind: v.literal("companies"), ref: v.string(), contactId: v.string(), seed: v.optional(v.string()), companyIds: v.array(v.string()) }),
  v.object({ kind: v.literal("parent"), ref: v.string(), accountId: v.string(), parentId: v.string() }),
  v.object({ kind: v.literal("people"), ref: v.string(), streamId: v.string(), members: v.array(v.object({ contactId: v.string(), role: v.union(...DEAL_ROLES.map((r) => v.literal(r))) })) }),
);

/**
 * Write a page's associations as edges, as HubSpot's (each its HubSpot record's source ref): a person at each of their
 * companies (the first one primary), a company under its parent, people on a deal in their roles. The edge writer's
 * CRM rule (EdgeWriter.crm) keeps what a person decided in Canon, and records what HubSpot says instead. An edge that
 * is already there is unchanged, so a re-run writes nothing new. Returns the HubSpot records whose edges were refused.
 */
export const writeLinks = internalMutation({
  args: { orgId: v.id("organizations"), userId: v.id("users"), links: v.array(linkArg) },
  handler: async (ctx, a) => {
    const store = edgeStore(ctx);
    const now = Date.now();
    const out = { applied: 0, failed: [] as Array<{ ref: string; message: string }> };
    for (const l of a.links) {
      const edgeCtx = hubspotEdges(a.orgId, `hubspot:${l.ref}`, now);
      if (l.kind === "people") {
        const deal = await dealOfStream(ctx, a.orgId, l.streamId);
        if (!deal) { out.failed.push({ ref: l.ref, message: "Deal not found" }); continue; }
        await seedDealRoles(store, a.orgId, l.streamId, await legacyRolesOf(ctx, deal._id));
      }
      const cmds: EdgeCommand[] = l.kind === "parent"
        ? [{ op: "setParent", accountId: l.accountId, parentId: l.parentId }]
        : l.kind === "people"
          ? l.members.map((m) => ({ op: "setRole" as const, dealId: l.streamId, contactId: m.contactId, role: m.role as DealRole }))
          : [
            ...l.companyIds.map((toId, i) => ({ op: "link" as const, fromId: l.contactId, toId, ...(i === 0 ? { primary: true } : {}) })),
            { op: "keepOnly" as const, association: "contact_account" as const, fromId: l.contactId, toIds: l.companyIds },
          ];
      for (const cmd of cmds) {
        const res = await applyEdgeCommand(store, edgeCtx, cmd, l.kind === "companies" ? l.seed : undefined);
        if (res.status === "invalid") {
          out.failed.push({ ref: l.ref, message: res.message });
          break;
        }
        if (res.status === "applied") out.applied++;
      }
    }
    return out;
  },
});

/** A HubSpot record's edge writes: its source ref, the integration as actor. */
const hubspotEdges = (orgId: Id<"organizations">, ref: string, now: number) =>
  ({ orgId, source: { kind: "hubspot" as const, ref }, actor: { kind: "integration" as const, id: "hubspot" }, now });

const activityArg = v.object({
  hubspotId: v.string(), object: v.union(v.literal("call"), v.literal("meeting"), v.literal("note"), v.literal("task")),
  values: v.record(v.string(), fieldValue), createdAt: v.union(v.number(), v.null()), targets: v.array(v.string()),
});

/** The external id an engagement's activity is found by again: one per HubSpot object, so a call and a note never share one. */
const engagementProvider = (object: string) => `hubspot:${object}`;

/**
 * Write a page of calls, meetings, notes and tasks through the object API's `save`, as HubSpot's records: a new one is
 * created with HubSpot's date and found again on a re-run by its HubSpot id (which then changes nothing), then gets
 * an `activity_target` edge to each company, person and deal it is about, so it shows on each timeline.
 */
export const writeActivities = internalMutation({
  args: { orgId: v.id("organizations"), userId: v.id("users"), rows: v.array(activityArg) },
  handler: async (ctx, a) => {
    const store = convexObjectStore(ctx);
    const edges = edgeStore(ctx);
    const out = { created: 0, updated: 0, unchanged: 0, failed: [] as Array<{ ref: string; message: string }> };
    for (const r of a.rows) {
      const def = await loadDef(ctx, a.orgId, r.object);
      const provider = engagementProvider(r.object);
      const found = await store.findByExternalId(a.orgId, provider, r.hubspotId);
      const cmd: SaveCommand = found
        ? { op: "update", streamId: found, values: r.values }
        : { op: "create", values: r.values, externalId: { provider, externalId: r.hubspotId }, ...(r.createdAt !== null ? { createdAt: r.createdAt } : {}) };
      const res = await save(store, {
        orgId: a.orgId, def, source: { kind: "hubspot", ref: `${provider}:${r.hubspotId}` }, actor: { kind: "integration", id: "hubspot" }, now: Date.now(),
        alwaysKeepHotRow: def.residency === "all",
      }, cmd);
      if (res.status === "invalid" || res.status === "conflict") {
        out.failed.push({ ref: r.hubspotId, message: res.status === "invalid" ? res.errors.map((e) => e.message).join("; ") : "The record changed while it was imported" });
        continue;
      }
      let changed = res.status !== "unchanged";
      if (r.targets.length) {
        const edge = await applyEdgeCommand(edges, hubspotEdges(a.orgId, `${provider}:${r.hubspotId}`, Date.now()), { op: "target", activityId: res.streamId, toIds: r.targets });
        if (edge.status === "invalid") {
          out.failed.push({ ref: r.hubspotId, message: edge.message });
          continue;
        }
        changed ||= edge.status === "applied";
      }
      if (!changed) out.unchanged++;
      else out[found ? "updated" : "created"]++;
    }
    return out;
  },
});

const loggedEmailArg = v.object({
  hubspotId: v.string(), contactIds: v.array(v.string()), occurredAt: v.number(), userId: v.optional(v.id("users")),
  direction: v.union(v.literal("inbound"), v.literal("outbound")), from: v.string(), to: v.string(), subject: v.string(), body: v.string(),
});

/**
 * Log a page of HubSpot emails on each of their people's timelines, as the emails a member sends from Canon are
 * (observations of type `email`). An email already logged for a person (its key) is not logged twice.
 */
export const writeEmails = internalMutation({
  args: { orgId: v.id("organizations"), rows: v.array(loggedEmailArg) },
  handler: async (ctx, a) => {
    let logged = 0;
    const now = Date.now();
    for (const r of a.rows) {
      const key = `hubspot:email:${r.hubspotId}`;
      for (const contactId of r.contactIds) {
        const seen = await ctx.db.query("observations").withIndex("by_orgId_subjectContactId_bodyKey", (q) => q.eq("orgId", a.orgId).eq("subject.contactId", contactId).eq("body.key", key)).first();
        if (seen) continue;
        const event = { kind: "logged" as const, provider: "hubspot" as const, direction: r.direction, from: r.from, to: r.to, subject: r.subject, body: r.body, ...(r.userId ? { userId: r.userId } : {}) };
        await appendObservations(ctx, a.orgId, { object: "contact", contactId }, { kind: "pipeline", ref: "hubspot" }, [{ body: { type: "email", key, event }, observedAt: now, occurredAt: r.occurredAt }]);
        logged++;
      }
    }
    return { logged };
  },
});

/** What Canon holds for these engagements: each activity's values and targets, or each email's logged people. */
export const engagementRows = internalQuery({
  args: { orgId: v.id("organizations"), object: v.string(), items: v.array(v.object({ id: v.string(), contactIds: v.array(v.string()) })) },
  handler: async (ctx, a) => {
    if (a.object === "email") {
      return Promise.all(a.items.map(async ({ id, contactIds }) => {
        const key = `hubspot:email:${id}`;
        const rows = (await Promise.all(contactIds.map((contactId) =>
          ctx.db.query("observations").withIndex("by_orgId_subjectContactId_bodyKey", (q) => q.eq("orgId", a.orgId).eq("subject.contactId", contactId).eq("body.key", key)).first()))).filter((r) => r !== null);
        const first = rows[0];
        const event = first?.body.type === "email" ? first.body.event : null;
        return { id, row: event ? { subject: event.subject, body: "body" in event ? event.body : "", at: first!.occurredAt ?? null, people: rows.map((r) => (r!.subject.object === "contact" ? r!.subject.contactId : "")) } : null };
      }));
    }
    const def = await loadDef(ctx, a.orgId, a.object);
    return Promise.all(a.items.map(async ({ id }) => {
      const ext = await ctx.db.query("canonExternalIds").withIndex("by_orgId_provider_externalId", (q) => q.eq("orgId", a.orgId).eq("provider", engagementProvider(a.object)).eq("externalId", id)).first();
      if (!ext) return { id, row: null };
      const entries = await ctx.db.query("ledgerEntries").withIndex("by_streamId_version", (q) => q.eq("streamId", ext.entityId)).take(200);
      const state = foldAll(entries.map(asEntry));
      const targets = await ctx.db.query("associations").withIndex("by_orgId_association_fromId_toId", (q) => q.eq("orgId", a.orgId).eq("association", "activity_target").eq("fromId", ext.entityId)).take(50);
      if (!state) return { id, row: null };
      const projected = project(def, state);
      const values = Object.fromEntries(Object.entries(projected.values).map(([fieldId, value]) => [def.byFieldId.get(fieldId as never)?.apiName ?? fieldId, value]));
      return { id, row: { values, createdAt: projected.createdAt, targets: targets.filter((t) => t.active).map((t) => t.toId) } };
    }));
  },
});

const specArg = v.object({
  object: v.union(v.literal("account"), v.literal("contact"), v.literal("deal")), property: v.string(), label: v.string(),
  type: v.union(v.literal("text"), v.literal("number"), v.literal("date"), v.literal("datetime"), v.literal("checkbox"), v.literal("picklist"), v.literal("multipicklist")),
  options: v.array(v.object({ value: v.string(), label: v.string() })),
});

/**
 * Make a custom field for each HubSpot property, as an admin's field builder would (lib/objects/fieldBuilder.ts). A
 * field with the property's label is that property's field, so a re-run reuses it, adding any option HubSpot added.
 * Returns each property's field and the Canon value of each HubSpot option; a property that cannot be a field is reported.
 */
export const ensureCustomFields = internalMutation({
  args: { orgId: v.id("organizations"), specs: v.array(specArg) },
  handler: async (ctx, a): Promise<{ fields: CustomField[]; refused: Array<{ property: string; message: string }> }> => {
    const fields: CustomField[] = [];
    const refused: Array<{ property: string; message: string }> = [];
    for (const object of ["account", "contact", "deal"] as const) {
      const specs = a.specs.filter((s) => s.object === object);
      if (!specs.length) continue;
      const row = await ctx.db.query("objectDefs").withIndex("by_orgId_apiName", (q) => q.eq("orgId", a.orgId).eq("apiName", object)).unique();
      let ext = row ? fromStored<OrgObjectExtension>(row) : undefined;
      const before = JSON.stringify(ext?.customFields ?? []);
      for (const spec of specs) {
        let field = ext?.customFields.find((f) => f.archivedAt === undefined && f.label.toLowerCase() === spec.label.toLowerCase());
        // A datetime property imported before Canon had date-and-time fields stays the date field it became.
        const type = field?.type === "date" && spec.type === "datetime" ? "date" : spec.type;
        if (field && field.type !== type) {
          refused.push({ property: spec.property, message: `A ${field.type} field is already named ${spec.label}` });
          continue;
        }
        try {
          if (!field) {
            const out = addField(object, ext, { label: spec.label, type: spec.type, options: spec.options.map((o) => ({ label: o.label })) });
            ext = out.ext;
            field = out.field;
          } else if (field.type === "picklist" || field.type === "multipicklist") {
            const current = field.options;
            const missing = spec.options.filter((o) => !current.some((x) => x.label.toLowerCase() === o.label.toLowerCase()));
            if (missing.length) {
              ext = updateField(object, ext, field.fieldId, { options: [...current.map((o) => ({ value: o.value, label: o.label })), ...missing.map((o) => ({ label: o.label }))] });
              field = ext.customFields.find((f) => f.fieldId === field!.fieldId)!;
            }
          }
        } catch (e) {
          if (!(e instanceof RegistryError)) throw e;
          refused.push({ property: spec.property, message: e.message });
          continue;
        }
        const options = "options" in field && field.options ? field.options : [];
        fields.push({
          object, property: spec.property, apiName: field.apiName, type,
          options: spec.options.flatMap((o) => {
            const canon = options.find((x) => x.label.toLowerCase() === o.label.toLowerCase());
            return canon ? [{ hubspot: o.value, canon: canon.value }] : [];
          }),
        });
      }
      if (ext && JSON.stringify(ext.customFields) !== before) {
        const doc = { registryVersion: ext.registryVersion, customFields: toStored(ext.customFields), updatedAt: Date.now(), ...(ext.picklistOptions ? { picklistOptions: toStored(ext.picklistOptions) } : {}) };
        if (row) await ctx.db.patch(row._id, doc);
        else await ctx.db.insert("objectDefs", { orgId: a.orgId, apiName: object, ...doc });
      }
    }
    await scheduleNudge(ctx, a.orgId);
    return { fields, refused };
  },
});

const historyArg = v.object({
  object: v.union(v.literal("account"), v.literal("contact"), v.literal("deal")), crmId: v.string(),
  field: v.string(), value: v.union(v.string(), v.number(), v.null()), at: v.number(), ref: v.string(),
});

/**
 * Record HubSpot's past values as dated facts on each record's ledger stream, each from its own source record and
 * valid from HubSpot's timestamp, so the record's history shows when each value held. They rank below the record's
 * live HubSpot values, so the current value stays current. A re-run appends nothing.
 */
export const writeHistory = internalMutation({
  args: { orgId: v.id("organizations"), rows: v.array(historyArg) },
  handler: async (ctx, a) => {
    let written = 0;
    const missing: string[] = [];
    for (const r of a.rows) {
      if (r.object === "deal") {
        const deal = await ctx.db.query("deals").withIndex("by_orgId_crmId", (q) => q.eq("orgId", a.orgId).eq("crmId", r.crmId)).first();
        if (!deal) {
          missing.push(r.crmId);
          continue;
        }
        const out = await saveDealValues(ctx, deal, { kind: "csv", ref: r.ref, actorId: "hubspot", validFrom: r.at }, { [r.field]: r.value } as DealValues, { now: Date.now() });
        if (out.result.status === "applied") written++;
        continue;
      }
      const ext = await ctx.db.query("canonExternalIds").withIndex("by_orgId_provider_externalId", (q) => q.eq("orgId", a.orgId).eq("provider", r.object === "account" ? ID.crmAccount("hubspot") : ID.crmContact("hubspot")).eq("externalId", r.crmId)).first();
      if (!ext) {
        missing.push(r.crmId);
        continue;
      }
      const out = await saveParty(ctx, {
        orgId: a.orgId, object: r.object, identity: { entityId: await survivorOf(ctx, ext.entityId) }, seed: null,
        source: { kind: "import", ref: r.ref, actorId: "hubspot", validFrom: r.at }, values: { [r.field]: r.value },
      });
      if (out.result.status === "applied") written++;
    }
    return { written, missing };
  },
});

const mismatchArg = v.object({ id: v.string(), name: v.string(), field: v.string(), hubspot: v.union(v.string(), v.null()), canon: v.union(v.string(), v.null()) });

export const saveSpotCheck = internalMutation({
  args: { runId: v.id("crmImports"), objects: v.array(v.object({ object: v.string(), sampled: v.number(), fields: v.number(), mismatches: v.array(mismatchArg) })) },
  handler: async (ctx, a) => {
    await ctx.db.patch(a.runId, { spotCheck: { at: Date.now(), objects: a.objects.map((o) => ({ ...o, mismatches: o.mismatches.slice(0, 100) })) } });
    return null;
  },
});

export type ImportRun = Doc<"crmImports">;
export type { ImportObject };
