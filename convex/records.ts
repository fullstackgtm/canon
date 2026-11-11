/**
 * Native CRM records (accounts/contacts), proxied to the WS1 record service
 * via convex/lib/recordClient.ts and always scoped to the caller's orgId.
 *
 * While RECORD_SERVICE_URL is unset the client runs its fake over the
 * `fakeRecord*` tables below, so dev edits persist across reloads.
 */
import { can, refusal } from "./lib/capabilities";
import { ConvexError, v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { action, internalMutation, internalQuery, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUser } from "./lib";
import { accessFor } from "./permissions";
import { canSeeRecord, may, permissionOf, refuseLockedWrite, type Access, type RecordOp } from "./lib/access";
import { scopedRecordClient } from "./lib/scopedRecordClient";
import { editPartyRecord, foundEmailEdit, isLedgerEditField, writeFoundEmail, type RecordAccountSnapshot, type RecordContactSnapshot, type RecordEditPorts, type RecordPatch } from "./lib/canon/partyLedger";
import { partyFieldValue as fieldValue } from "./lib/objects/validators";
import { TREG_PHONE_ENDPOINT } from "./lib/phoneFinder";
import { TregRefusal } from "./lib/treg";
import { EmailLookupLimit, findWorkEmail, type FoundEmail } from "./lib/providers/emailFind";
import { findPhone as findPhoneOn } from "./lib/providers/phoneFind";
import { meter, resolveFor } from "./lib/providers/meter";
import { EMAIL_LOOKUPS_PER_DAY, PAID_PHONE_HITS_PER_MONTH, PHONE_LOOKUPS_PER_DAY, ProviderUnavailable } from "./lib/providers/registry";
import { filterValidator } from "./lib/scopeValidators";
import { parseQuery } from "../modules/kernel/icpQuery";
import { accountCriteria } from "./lib/icpCriteria";
import { isPaidEmailHit, isPaidPhoneHit, utcMonthWindow } from "./lib/usage";
import {
  accountIdFor,
  accountNamesFor,
  applyPatch,
  atLeastVersion,
  recordClient,
  scoreFakeAccounts,
  type FakeObjectSource,
  type FakeRecordStore,
  type RecordClient,
} from "./lib/recordClient";
import type {
  AccountRow,
  IcpGate,
  AccountsListResponse,
  ContactRow,
  ContactsListResponse,
  EditRequest,
  EditResponse,
  FieldHistoryRow,
  GetResponse,
  UpsertResponse,
} from "./lib/recordContract";
import { EDITABLE_ACCOUNT_FIELDS, EDITABLE_CONTACT_FIELDS, editRequestKey, reusedEditKeyMessage } from "./lib/recordContract";
import { BULK_MAX } from "./lib/objects/views";
import { upsertAccount, upsertContact } from "./lib/objects/createArgs";
import { admitRegisterIds } from "./lib/recordReferences";
import { icpGateValidator, icpVersionWeightsValidator } from "./lib/scoreHistory";
import { ACTIVITY_OBJECT } from "../modules/kernel/reportLanguage";
import type { ActivityReportContext } from "./moduleActivities";

// ───────────────────────────── Fake store (Convex tables) ─────────────────────────────

/** Accounts per page; the action-side store pages through the whole workspace (10k+ for TAM seeds). */
const FAKE_ACCOUNT_PAGE = 2000;
/** Stop paging here: past it the fake is the wrong tool and the record service should be used. */
const FAKE_ACCOUNT_MAX = 50_000;
/** A fake rescore commits all rows and its version together; larger workspaces need the record service. */
const FAKE_RESCORE_MAX = 2000;

export const fakeRescore = internalMutation({
  args: { ws: v.string(), weights: icpVersionWeightsValidator, version: v.optional(v.number()), gates: v.array(icpGateValidator) },
  handler: async (ctx, { ws, weights, version, gates }): Promise<{ rescored: number; gates: IcpGate[] }> => {
    const meta = await ctx.db.query("fakeRecordKeys").withIndex("by_ws_key", (q) => q.eq("ws", ws).eq("key", "__fitVersion")).unique();
    const accepted = meta?.response.version as number | undefined;
    if (accepted !== undefined) {
      if (version === undefined || version < accepted) throw new ConvexError("stale ICP version");
      if (version === accepted) return { rescored: 0, gates: meta?.response.gates ?? [] };
    }
    const rows = await ctx.db.query("fakeRecordAccounts").withIndex("by_ws_recordId", (q) => q.eq("ws", ws)).take(FAKE_RESCORE_MAX + 1);
    const contacts = await ctx.db.query("fakeRecordContacts").withIndex("by_ws_recordId", (q) => q.eq("ws", ws)).take(FAKE_RESCORE_MAX + 1);
    if (rows.length > FAKE_RESCORE_MAX || contacts.length > FAKE_RESCORE_MAX) throw new ConvexError("Use the record service to rescore this workspace");
    const scored = scoreFakeAccounts(rows.map((r) => r.row as AccountRow), contacts.map((r) => r.row as ContactRow), weights, gates);
    for (let i = 0; i < rows.length; i++) await ctx.db.patch(rows[i]._id, { row: scored[i] });
    const response = { ...(version === undefined ? {} : { version }), gates };
    if (meta) await ctx.db.patch(meta._id, { response });
    else await ctx.db.insert("fakeRecordKeys", { ws, key: "__fitVersion", response });
    return { rescored: rows.length, gates };
  },
});

export const fakeAccountsPage = internalQuery({
  args: { ws: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("fakeRecordAccounts")
      .withIndex("by_ws_recordId", (q) => q.eq("ws", args.ws))
      .paginate(args.paginationOpts);
    return { ...page, page: page.page.map((d) => d.row as AccountRow) };
  },
});

async function fakeAllAccounts(ctx: ActionCtx, ws: string): Promise<AccountRow[]> {
  const rows: AccountRow[] = [];
  let cursor: string | null = null;
  for (;;) {
    const result: { page: AccountRow[]; isDone: boolean; continueCursor: string } = await ctx.runQuery(
      internal.records.fakeAccountsPage,
      { ws, paginationOpts: { numItems: FAKE_ACCOUNT_PAGE, cursor } },
    );
    rows.push(...result.page);
    if (result.isDone || rows.length >= FAKE_ACCOUNT_MAX) return rows;
    cursor = result.continueCursor;
  }
}

export const fakeGetAccounts = internalQuery({
  args: { ws: v.string(), ids: v.array(v.string()) },
  handler: async (ctx, args): Promise<AccountRow[]> => {
    const out: AccountRow[] = [];
    for (const id of args.ids) {
      const doc = await ctx.db
        .query("fakeRecordAccounts")
        .withIndex("by_ws_recordId", (q) => q.eq("ws", args.ws).eq("recordId", id))
        .first();
      if (doc) out.push(doc.row as AccountRow);
    }
    return out;
  },
});

export const fakeGetContact = internalQuery({
  args: { ws: v.string(), id: v.string() },
  handler: async (ctx, args): Promise<ContactRow | null> => {
    const doc = await ctx.db
      .query("fakeRecordContacts")
      .withIndex("by_ws_recordId", (q) => q.eq("ws", args.ws).eq("recordId", args.id))
      .first();
    return doc ? (doc.row as ContactRow) : null;
  },
});

export const fakeContacts = internalQuery({
  args: { ws: v.string(), accountId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ContactRow[]> => {
    const docs = args.accountId
      ? await ctx.db
          .query("fakeRecordContacts")
          .withIndex("by_ws_accountId", (q) => q.eq("ws", args.ws).eq("accountId", args.accountId!))
          .take(500)
      : await ctx.db
          .query("fakeRecordContacts")
          .withIndex("by_ws_recordId", (q) => q.eq("ws", args.ws))
          .take(2000);
    return docs.map((d) => d.row as ContactRow);
  },
});

export const fakeHistory = internalQuery({
  args: { ws: v.string(), recordId: v.string() },
  handler: async (ctx, args): Promise<FieldHistoryRow[]> => {
    const docs = await ctx.db
      .query("fakeRecordHistory")
      .withIndex("by_ws_recordId", (q) => q.eq("ws", args.ws).eq("recordId", args.recordId))
      .order("desc")
      .take(200);
    return docs.map((d) => d.entry as FieldHistoryRow);
  },
});

export const fakePutAccounts = internalMutation({
  args: { ws: v.string(), rows: v.array(v.any()) },
  handler: async (ctx, args) => {
    for (const row of args.rows as AccountRow[]) {
      const existing = await ctx.db
        .query("fakeRecordAccounts")
        .withIndex("by_ws_recordId", (q) => q.eq("ws", args.ws).eq("recordId", row.id))
        .first();
      if (existing) await ctx.db.patch(existing._id, { row });
      else await ctx.db.insert("fakeRecordAccounts", { ws: args.ws, recordId: row.id, row });
    }
  },
});

export const fakePutContacts = internalMutation({
  args: { ws: v.string(), rows: v.array(v.any()) },
  handler: async (ctx, args) => {
    for (const row of args.rows as ContactRow[]) {
      const existing = await ctx.db
        .query("fakeRecordContacts")
        .withIndex("by_ws_recordId", (q) => q.eq("ws", args.ws).eq("recordId", row.id))
        .first();
      if (existing) await ctx.db.patch(existing._id, { row, accountId: row.accountId });
      else await ctx.db.insert("fakeRecordContacts", { ws: args.ws, recordId: row.id, accountId: row.accountId, row });
    }
  },
});

export const fakeEdit = internalMutation({
  args: { ws: v.string(), req: v.any(), now: v.number() },
  handler: async (ctx, args) => {
    const req = args.req as EditRequest;
    const request = editRequestKey(req);
    const seen = await ctx.db
      .query("fakeRecordKeys")
      .withIndex("by_ws_key", (q) => q.eq("ws", args.ws).eq("key", `edit:${req.idempotencyKey}`))
      .first();
    if (seen) {
      // The request is kept beside the answer; keys stored before it was have none and answer as before.
      const { request: stored, ...response } = seen.response as EditResponse & { request?: string };
      if (stored !== undefined && stored !== request) throw new ConvexError(reusedEditKeyMessage(req.idempotencyKey));
      return response;
    }
    const doc =
      req.object === "account"
        ? await ctx.db
            .query("fakeRecordAccounts")
            .withIndex("by_ws_recordId", (q) => q.eq("ws", args.ws).eq("recordId", req.id))
            .first()
        : await ctx.db
            .query("fakeRecordContacts")
            .withIndex("by_ws_recordId", (q) => q.eq("ws", args.ws).eq("recordId", req.id))
            .first();
    if (!doc) throw new ConvexError(`${req.object} ${req.id} not found`);
    let result;
    try {
      result = applyPatch(req.object, req.id, doc.row, req.patch, req.actorId, args.now);
    } catch (error) {
      throw new ConvexError(error instanceof Error ? error.message : "Invalid edit");
    }
    await ctx.db.patch(doc._id, { row: result.row });
    for (const entry of result.history) {
      await ctx.db.insert("fakeRecordHistory", { ws: args.ws, recordId: req.id, entry });
    }
    // The workspace's commit clock: mutations on it serialize, so readings order edits as they were applied.
    const clock = await ctx.db
      .query("fakeRecordKeys")
      .withIndex("by_ws_key", (q) => q.eq("ws", args.ws).eq("key", "__editClock"))
      .first();
    const at = Math.max(args.now, ((clock?.response as { at?: number } | undefined)?.at ?? 0) + 1);
    if (clock) await ctx.db.patch(clock._id, { response: { at } });
    else await ctx.db.insert("fakeRecordKeys", { ws: args.ws, key: "__editClock", response: { at } });
    const response: EditResponse = { version: result.version, at };
    await ctx.db.insert("fakeRecordKeys", { ws: args.ws, key: `edit:${req.idempotencyKey}`, response: { ...response, request } });
    return response;
  },
});

export const fakeSeenKey = internalQuery({
  args: { ws: v.string(), key: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("fakeRecordKeys")
      .withIndex("by_ws_key", (q) => q.eq("ws", args.ws).eq("key", args.key))
      .first();
    return (doc?.response as UpsertResponse | undefined) ?? null;
  },
});

export const fakeRememberKey = internalMutation({
  args: { ws: v.string(), key: v.string(), response: v.any() },
  handler: async (ctx, args) => {
    await ctx.db.insert("fakeRecordKeys", { ws: args.ws, key: args.key, response: args.response });
  },
});

export const fakeProvision = internalMutation({
  args: { ws: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("fakeRecordKeys")
      .withIndex("by_ws_key", (q) => q.eq("ws", args.ws).eq("key", "__provisioned"))
      .first();
    if (existing) return false;
    await ctx.db.insert("fakeRecordKeys", { ws: args.ws, key: "__provisioned", response: { at: Date.now() } });
    return true;
  },
});

const PUT_CHUNK = 200;

export function convexFakeStore(ctx: ActionCtx): FakeRecordStore {
  return {
    rescore: (ws, icp, version, gates) => ctx.runMutation(internal.records.fakeRescore, {
      ws, weights: { base: icp.base ?? 0, industries: icp.industries ?? {}, countries: icp.countries ?? {}, employeeBands: icp.employeeBands ?? [] },
      ...(version === undefined ? {} : { version }), gates: gates ?? [],
    }),
    provision: (ws) => ctx.runMutation(internal.records.fakeProvision, { ws }),
    allAccounts: (ws) => fakeAllAccounts(ctx, ws),
    async getAccount(ws, id) {
      const rows = await ctx.runQuery(internal.records.fakeGetAccounts, { ws, ids: [id] });
      return rows[0] ?? null;
    },
    async getAccountsByIds(ws, ids) {
      const out = new Map<string, AccountRow>();
      for (let i = 0; i < ids.length; i += PUT_CHUNK) {
        const rows = await ctx.runQuery(internal.records.fakeGetAccounts, { ws, ids: ids.slice(i, i + PUT_CHUNK) });
        for (const row of rows) out.set(row.id, row);
      }
      return out;
    },
    allContacts: (ws) => ctx.runQuery(internal.records.fakeContacts, { ws }),
    getContact: (ws, id) => ctx.runQuery(internal.records.fakeGetContact, { ws, id }),
    contactsFor: (ws, accountId) => ctx.runQuery(internal.records.fakeContacts, { ws, accountId }),
    history: (ws, id) => ctx.runQuery(internal.records.fakeHistory, { ws, recordId: id }),
    async putAccounts(ws, rows) {
      for (let i = 0; i < rows.length; i += PUT_CHUNK) {
        await ctx.runMutation(internal.records.fakePutAccounts, { ws, rows: rows.slice(i, i + PUT_CHUNK) });
      }
    },
    async putContacts(ws, rows) {
      for (let i = 0; i < rows.length; i += PUT_CHUNK) {
        await ctx.runMutation(internal.records.fakePutContacts, { ws, rows: rows.slice(i, i + PUT_CHUNK) });
      }
    },
    edit: (ws, req, now) => ctx.runMutation(internal.records.fakeEdit, { ws, req, now }),
    seenKey: (ws, key) => ctx.runQuery(internal.records.fakeSeenKey, { ws, key }),
    rememberKey: (ws, key, response) => ctx.runMutation(internal.records.fakeRememberKey, { ws, key, response }).then(() => undefined),
  };
}

/** Hot rows read per page, and the most the fake lists: past it, run the record service. */
const FAKE_OBJECT_PAGE = 500;
const FAKE_OBJECT_MAX = 20_000;

/**
 * The fake's view of ledger objects: every hot row of the org, re-projected
 * with the org's current definitions (convex/objects.ts fakeObjectRows). A
 * record with no hot row (an `onDemand` import nobody has opened or saved)
 * is not listed, which the record service's projection would list.
 */
export function convexFakeObjectSource(ctx: ActionCtx): FakeObjectSource {
  return {
    async rows(ws, objects) {
      const out: FakeObjectRows = { rows: [], defs: [], heads: {} };
      let cursor: string | null = null;
      for (;;) {
        const page: FakeObjectRows & { isDone: boolean; continueCursor: string } = await ctx.runQuery(internal.objects.fakeObjectRows, {
          ws, objects: objects ? [...objects] : null, paginationOpts: { numItems: FAKE_OBJECT_PAGE, cursor },
        });
        if (cursor === null) Object.assign(out, { defs: page.defs, heads: page.heads });
        out.rows.push(...page.rows);
        if (page.isDone || out.rows.length >= FAKE_OBJECT_MAX) return out;
        cursor = page.continueCursor;
      }
    },
  };
}
type FakeObjectRows = Awaited<ReturnType<FakeObjectSource["rows"]>>;

export function clientFor(ctx: ActionCtx): RecordClient {
  return recordClient({ store: convexFakeStore(ctx), objects: convexFakeObjectSource(ctx) });
}

// ───────────────────────────── Caller scope ─────────────────────────────

/**
 * The caller of an action, with their access (CP14, convex/permissions.ts
 * accessFor): every record read an action serves is narrowed by it.
 */
export type ActionCaller = { orgId: string; userId: string; name: Doc<"users">["name"]; role: Doc<"users">["role"]; capabilities?: readonly string[]; access: Access };

export const callerContext = internalQuery({
  args: {},
  handler: async (ctx): Promise<ActionCaller | null> => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    return { orgId: user.orgId as string, userId: user._id as string, name: user.name, role: user.role, ...(user.capabilities ? { capabilities: user.capabilities } : {}), access: await accessFor(ctx, user) };
  },
});

/**
 * The caller of an action. During an admin's "view as" preview an action is
 * refused unless it declares itself a read (`read: true`), so a preview is
 * read-only by construction: a new action that sends, writes or spends is
 * blocked without anyone having to remember to check (CP14).
 */
export async function requireCaller(ctx: ActionCtx, opts: { read?: boolean } = {}): Promise<ActionCaller> {
  const caller = await ctx.runQuery(internal.records.callerContext, {});
  if (!caller) throw new ConvexError("Not authenticated");
  if (caller.access.preview && !opts.read) throw new ConvexError(`You are viewing as ${caller.access.preview.asName}: changes are off until you exit the preview`);
  return caller;
}

/**
 * The record client every read a caller makes goes through (CP14): the same
 * client as `clientFor`, with the caller's visibility and field rules on every
 * read that returns records (lib/scopedRecordClient.ts). A caller with full
 * access gets `clientFor` unchanged. Writes are not scoped here: each writer
 * checks `may` and the row first.
 */
export function callerClient(ctx: ActionCtx, caller: { orgId: string; access: Access }): RecordClient {
  return principalClient(ctx, caller.orgId, [caller.access]);
}

/**
 * The record client an agent run reads through (CP14): scoped to every one of
 * its principals (lib/access.ts agentPrincipals, their access from
 * permissions.principalAccess), so it returns no record any of them could not
 * see. A run has no signed-in caller, so the deal scope is computed from the
 * accesses given, never from the action's identity.
 */
export function principalClient(ctx: ActionCtx, orgId: string, accesses: readonly Access[]): RecordClient {
  const base = clientFor(ctx);
  const activityClient: RecordClient = {
    ...base,
    async aggregate(ws, object, req) {
      if (object !== ACTIVITY_OBJECT) return base.aggregate(ws, object, req);
      if (ws !== orgId) throw new ConvexError("An activity report must read its principals' workspace.");
      const args = { orgId: orgId as Id<"organizations">, accesses: [...accesses] };
      const before: ActivityReportContext = await ctx.runQuery(internal.moduleActivities.reportContext, args);
      const syncing = () => { throw new ConvexError({ projectionSyncing: true, message: "Activity report projections are syncing or unavailable. Try again shortly." }); };
      if (!before.ready) syncing();
      const ledger = { ...req };
      delete ledger.moduleActivities;
      const result = await base.aggregate(ws, object, { ...ledger, ...(before.sources.length ? { moduleActivities: before.sources } : {}) });
      const after: ActivityReportContext = await ctx.runQuery(internal.moduleActivities.reportContext, args);
      if (!after.ready || before.fence !== after.fence) syncing();
      return result;
    },
  };
  return scopedRecordClient(activityClient, accesses, () =>
    ctx.runQuery(internal.permissions.dealScopeOf, { orgId: orgId as Id<"organizations">, accesses: [...accesses] }));
}

/** Refuse `op` on a register row the caller's role may not perform or see; a hidden row reads as missing. */
export function requireRowAccess(access: Access, object: "account" | "contact", op: RecordOp, row: { ownerId?: string } | null) {
  if (!may(access, object, op)) throw new ConvexError(`Your role cannot ${op} ${object === "account" ? "companies" : "people"}`);
  if (row && !canSeeRecord(access, object, true, row.ownerId ?? null)) throw new ConvexError(`${object === "account" ? "Account" : "Contact"} not found`);
}

// ───────────────────────────── Public actions ─────────────────────────────

export const list = action({
  args: {
    filter: v.optional(filterValidator),
    sort: v.optional(
      v.object({
        field: v.union(v.literal("fit"), v.literal("name"), v.literal("employees"), v.literal("updatedAt")),
        dir: v.union(v.literal("asc"), v.literal("desc")),
      }),
    ),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
    // Query lines (modules/kernel/icpQuery.ts) every listed company must pass: a territory and the lines above it.
    lines: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args): Promise<AccountsListResponse> => {
    const caller = await requireCaller(ctx, { read: true });
    const { lines, ...rest } = args;
    if ((lines?.length ?? 0) > 8) throw new ConvexError("Filter by at most 8 query lines.");
    const criteria = (lines ?? []).map(lineCriteria);
    return callerClient(ctx, caller).list(caller.orgId, { ...rest, ...(criteria.length ? { filter: { ...rest.filter, criteria } } : {}), limit: Math.min(args.limit ?? 50, 200) });
  },
});

/** A query line as company criteria, or a refusal that says what in it doesn't read. Companies only: no AI fields or people. */
function lineCriteria(line: string) {
  const { query, errors } = parseQuery(line.slice(0, 2000), "segment");
  if (errors.length) throw new ConvexError(`"${line.slice(0, 80)}": ${errors[0]}`);
  if (query.has.length || query.clauses.some((c) => c.key === "field")) throw new ConvexError(`"${line.slice(0, 80)}": filter companies by company keys only`);
  const { custom: _custom, ...criteria } = accountCriteria(query.clauses);
  return criteria;
}

export const listContacts = action({
  args: {
    accountId: v.optional(v.string()),
    q: v.optional(v.string()),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<ContactsListResponse & { accountNames: Record<string, string> }> => {
    const caller = await requireCaller(ctx, { read: true });
    const client = callerClient(ctx, caller);
    const page = await client.listContacts(caller.orgId, {
      filter: { accountId: args.accountId, q: args.q },
      cursor: args.cursor,
      limit: Math.min(args.limit ?? 50, 200),
    });
    // Resolve employer names for the visible page only.
    const accountNames = await accountNamesFor(client, caller.orgId, page.rows.map((r) => r.accountId));
    return { ...page, accountNames };
  },
});

export const get = action({
  args: { id: v.string() },
  handler: async (ctx, args): Promise<GetResponse | null> => {
    const caller = await requireCaller(ctx, { read: true });
    // A company the caller's role does not see reads as missing; its people are those they see (CP14).
    return callerClient(ctx, caller).get(caller.orgId, args.id);
  },
});

export const count = action({
  args: { filter: filterValidator },
  handler: async (ctx, args): Promise<{ total: number }> => {
    const caller = await requireCaller(ctx, { read: true });
    return callerClient(ctx, caller).countSegment(caller.orgId, args.filter);
  },
});

/** Records one `upsert` call may add. */
export const UPSERT_MAX = 100;

/**
 * Add accounts (keyed by domain) or contacts (deduplicated by the record
 * service) to the register as unworked rows, like a population job does.
 * Fill-only: a row that already exists keeps its values and only gains the
 * ones it lacks; change values with `edit`, which goes through the ledger.
 */
export const upsert = action({
  args: {
    object: v.union(v.literal("account"), v.literal("contact")),
    accounts: v.optional(v.array(upsertAccount)),
    contacts: v.optional(v.array(upsertContact)),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args): Promise<UpsertResponse> => {
    const caller = await requireCaller(ctx);
    requireRowAccess(caller.access, args.object, "create", null);
    const records = args.object === "account" ? args.accounts : args.contacts;
    if (!records?.length) throw new ConvexError(`Pass at least one ${args.object} in ${args.object}s`);
    if (records.length > UPSERT_MAX) throw new ConvexError(`Add at most ${UPSERT_MAX} records at a time`);
    const client = clientFor(ctx);
    // An upsert fills the gaps of a record that already exists, which is an edit (CP14). A role that may not edit the
    // object, or sees only some of its records, adds only new ones: a company is matched by its domain, as the
    // service keys it; a person is matched by the service in ways only it can answer, so such a role adds people one
    // by one from the People page instead.
    // A field the caller's role may not change is not supplied by them either (CP14).
    for (const r of records) refuseLockedWrite(caller.access, args.object, Object.keys(r).filter((k) => k !== "accountDomain" && k !== "accountId"));
    const p = permissionOf(caller.access, args.object);
    if (!p.edit || p.visibility !== "all") {
      if (args.object === "contact") throw new ConvexError("Your role adds people from the People page, not by import");
      const existing = await Promise.all(args.accounts!.map((a) => client.get(caller.orgId, accountIdFor(a.domain))));
      const taken = args.accounts!.filter((_, i) => existing[i] !== null).map((a) => a.domain);
      if (taken.length) throw new ConvexError(`Already in the workspace: ${taken.slice(0, 5).join(", ")}. Your role adds new companies only.`);
    }
    // The record service replays the key; the claim refuses it sent again with other records.
    await ctx.runMutation(internal.apiIdempotency.claim, { key: args.idempotencyKey, request: { op: "records.upsert", object: args.object, records } });
    const body = { source: "api", idempotencyKey: `api:${caller.userId}:${args.idempotencyKey}`, fill: "missing" as const };
    return args.object === "account"
      ? client.upsertAccounts(caller.orgId, { ...body, records: args.accounts! })
      : client.upsertContacts(caller.orgId, { ...body, records: args.contacts! });
  },
});

export const edit = action({
  args: {
    object: v.union(v.literal("account"), v.literal("contact")),
    id: v.string(),
    patch: v.record(v.string(), fieldValue),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args): Promise<{ version: number }> => {
    const caller = await requireCaller(ctx);
    const result = await editPartyRecord(await recordEditPorts(ctx, caller, args, "edit"));
    if (args.object === "account" && ("status" in args.patch || "ownerId" in args.patch)) {
      await ctx.runMutation(internal.onboarding.markStep, { stepId: "triage_tam", orgId: caller.orgId });
    }
    return result;
  },
});

const bulkResult = v.object({
  streamId: v.string(),
  result: v.object({ status: v.string(), errors: v.optional(v.array(v.object({ field: v.string(), message: v.string(), rule: v.optional(v.string()), retryable: v.optional(v.boolean()) }))) }),
});

/**
 * One change to up to 25 register rows (a list view's selection): set `values`
 * on each (a person's own edit, so receipts and history work), delete them, or
 * restore them. Edits take the records.edit path; a delete appends a
 * `lifecycle` entry, promoting an unworked row first
 * (lib/canon/partyLedger.ts writeRecordLifecycle). Each row gets its own
 * result, keyed `streamId` (the row's id) so views.ts runBulk can drive it. A
 * retry with the same `batchKey` replays its edits instead of repeating them.
 * Only admins and managers delete and restore, as on the Deals page.
 */
export const bulkRegister = action({
  args: {
    object: v.union(v.literal("account"), v.literal("contact")),
    op: v.union(v.literal("update"), v.literal("delete"), v.literal("restore")),
    ids: v.array(v.string()),
    values: v.optional(v.record(v.string(), fieldValue)),
    batchKey: v.string(),
  },
  returns: v.object({ results: v.array(bulkResult), unprocessed: v.array(v.string()) }),
  handler: async (ctx, args) => {
    if (args.ids.length > BULK_MAX) throw new ConvexError(`Save at most ${BULK_MAX} records at a time`);
    if (args.op === "update" && !args.values) throw new ConvexError("An update needs values");
    const caller = await requireCaller(ctx);
    requireRowAccess(caller.access, args.object, args.op === "update" ? "edit" : "delete", null);
    if (args.op !== "update" && !can(caller, "deals.write")) {
      throw new ConvexError(`Only admins and managers can ${args.op === "delete" ? "archive" : "restore"} ${args.object === "account" ? "companies" : "people"}`);
    }
    const editable: readonly string[] = args.object === "account" ? EDITABLE_ACCOUNT_FIELDS : EDITABLE_CONTACT_FIELDS;
    const unknown = Object.keys(args.values ?? {}).filter((k) => !editable.includes(k) && !isLedgerEditField(args.object, k));
    if (unknown.length) throw new ConvexError(`${unknown.join(", ")} is not edited here`);
    const client = clientFor(ctx);
    const orgId = caller.orgId as Id<"organizations">;
    const results: Array<{ streamId: string; result: { status: string; errors?: Array<{ field: string; message: string }> } }> = [];
    for (const id of new Set(args.ids)) {
      try {
        if (args.op === "update") {
          await editPartyRecord(await recordEditPorts(ctx, caller, { object: args.object, id, patch: args.values!, idempotencyKey: `${args.batchKey}:${id}` }, "edit"));
          results.push({ streamId: id, result: { status: "applied" } });
          continue;
        }
        const row = args.object === "account"
          ? await client.get(caller.orgId, id).then((detail) => detail?.account ?? null)
          : await client.getContact(caller.orgId, id);
        if (!row) throw new ConvexError(`${args.object === "account" ? "Company" : "Person"} not found`);
        requireRowAccess(caller.access, args.object, "delete", row);
        const out = await ctx.runMutation(internal.canon.saveRecordLifecycle, {
          orgId, userId: caller.userId as Id<"users">, object: args.object, recordId: id, op: args.op,
          ...(row.stream ? { streamId: row.stream } : {}),
          // An unworked row is promoted from the row as it is now, so its stream starts from what the list showed.
          ...(row.stream ? {} : { snapshot: args.object === "account" ? recordSnapshotOf(row as AccountRow) : contactSnapshotOf(row as ContactRow) }),
        });
        results.push({ streamId: id, result: out.status === "invalid" ? { status: "invalid", errors: [{ field: "", message: out.message ?? "Not saved" }] } : { status: out.status } });
      } catch (cause) {
        const data: unknown = cause instanceof ConvexError ? cause.data : null;
        const errors = data && typeof data === "object" && Array.isArray((data as { errors?: unknown }).errors) ? (data as { errors: Array<{ field: string; message: string }> }).errors : null;
        results.push({ streamId: id, result: { status: "invalid", errors: errors ?? [{ field: "", message: typeof data === "string" ? data : "Could not save this record" }] } });
      }
    }
    // The projector writes each entry back to its row; wait for it once, so the list the caller reloads is current.
    if (args.op !== "update" && client.mode === "http") {
      const heads = await ctx.runQuery(internal.ledgerFeed.shardHeadsOf, { orgId });
      await client.nudgeProjector(caller.orgId, heads, process.env.CONVEX_SITE_URL, { wait: true });
    }
    return { results, unprocessed: [] };
  },
});

type RecordEditArgs = {
  object: "account" | "contact"; id: string; patch: RecordPatch; idempotencyKey: string;
  /** The paid provider call that found the values, when the person did not type them. */
  found?: { provider: string; callId: Id<"providerCalls"> };
  /** Values the record must still hold when the ledger writes (a module's approved proposal): else EditConflictError. */
  expect?: Record<string, string | null>;
  /** Why the person made the edit, kept on each value it writes (an approved account hierarchy fix's quotes). */
  evidence?: string;
};

/** The record-service contract that keeps one register: rows on the ledger take its values from the projector. */
const REGISTER_CONTRACT = "1.8.0";

/**
 * How a person's edit is written (lib/canon/partyLedger.ts editPartyRecord):
 * the ledger's checks, the ledger, then a wait for the projector to write the
 * values back to the record-service row the TAM explorer and accounts list
 * read; the service keeps only the fields the ledger does not track.
 */
export async function recordEditPorts(
  ctx: ActionCtx, caller: { orgId: string; userId: string; access?: Access }, args: RecordEditArgs, op?: RecordOp,
): Promise<RecordEditPorts> {
  const client = clientFor(ctx);
  const orgId = caller.orgId as Id<"organizations">;
  const row = args.object === "account"
    ? await client.get(caller.orgId, args.id).then((detail) => detail?.account ?? null)
    : await client.getContact(caller.orgId, args.id);
  if (!row) throw new ConvexError(`${args.object === "account" ? "Account" : "Contact"} not found`);
  // A person's edit (CP14): their role edits the object, and they see this row.
  let references: { userId: Id<"users">; admitted: string[] } | undefined;
  if (op && caller.access) {
    requireRowAccess(caller.access, args.object, op, row);
    // A field hidden or read-only for the caller's role is not changed by them (CP14).
    refuseLockedWrite(caller.access, args.object, Object.keys(args.patch));
    // The members and records the edit names are theirs to name (lib/recordReferences.ts).
    references = { userId: caller.userId as Id<"users">, admitted: await admitRegisterIds(callerClient(ctx, { orgId: caller.orgId, access: caller.access }), caller.orgId, args.patch) };
  }
  // A row the register already links to a stream (a CRM-only record the projector added) is edited on that stream.
  const linked = row?.stream;
  // A record worked for the first time is promoted onto the ledger: its stream starts from the row as it was before this edit.
  const promoting = !linked && !(await ctx.runQuery(internal.canon.recordHasStream, { orgId, object: args.object, recordId: args.id }));
  const snapshot = !promoting
    ? undefined
    : args.object === "account" ? recordSnapshotOf(row as AccountRow) : contactSnapshotOf(row as ContactRow);
  const edit = {
    object: args.object, recordId: args.id, patch: args.patch, idempotencyKey: args.idempotencyKey,
    ...(snapshot ? { snapshot } : {}), ...(linked ? { streamId: linked } : {}),
  };
  return {
    object: args.object,
    register: client.mode === "http" && atLeastVersion(await client.contractVersion(), REGISTER_CONTRACT),
    conditional: args.expect !== undefined,
    check: async () => {
      const { unnamed, ...checked } = await ctx.runQuery(internal.canon.checkRecordEdit, { orgId, ...edit, ...(references ? { references } : {}) });
      // Named by field, so the record API answers 422 for it (src/app/api/v1/_lib.ts toV1Error).
      if (unnamed?.length) throw new ConvexError({ code: "validation_failed", message: unnamed.map((e) => e.message).join("; "), errors: unnamed });
      return checked;
    },
    ledger: async (patch, at) => {
      const out = await ctx.runMutation(internal.canon.saveRecordEdit, {
        orgId, userId: caller.userId as Id<"users">, ...edit, patch, ...(at !== undefined ? { at } : {}), ...(args.found ? { found: args.found } : {}),
        ...(args.expect ? { expect: args.expect } : {}), ...(args.evidence !== undefined ? { evidence: args.evidence } : {}),
      });
      return { ...out, deferred: out.status === "deferred", conflict: out.status === "conflict" };
    },
    // The edit's entry is in the ledger; the projector links the row and writes it back before this returns.
    settle: async () => {
      if (client.mode !== "http") return;
      const heads = await ctx.runQuery(internal.ledgerFeed.shardHeadsOf, { orgId });
      await client.nudgeProjector(caller.orgId, heads, process.env.CONVEX_SITE_URL, { wait: true });
    },
    service: (patch, opts) => client.edit(caller.orgId, {
      // The service keeps only its own scalar fields; custom fields (lists, checkboxes) go to the ledger only.
      object: args.object, id: args.id, patch: patch as Record<string, string | number | null>, idempotencyKey: `${args.idempotencyKey}${opts?.keySuffix ?? ""}`, actorId: caller.userId,
      ...(opts?.payload ? { payload: opts.payload } : {}),
    }),
  };
}

const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, x]) => x !== undefined && x !== null));

/** The fields of a record-service account a ledger stream starts from. */
export function recordSnapshotOf(row: AccountRow): RecordAccountSnapshot {
  const { id, domain, name, updatedAt, industry, employees, country, linkedinUrl, status, ownerId } = row;
  return { id, domain, name, updatedAt, ...defined({ industry, employees, country, linkedinUrl, status, ownerId }) };
}

/** The fields of a record-service contact a ledger stream starts from. */
export function contactSnapshotOf(row: ContactRow): RecordContactSnapshot {
  const { id, fullName, updatedAt, email, title, linkedinUrl } = row;
  return { id, fullName, updatedAt, ...defined({ email, title, linkedinUrl }) };
}

// ───────────────────────────── Email on demand ─────────────────────────────

/** Paid email hits this workspace has used since the start of the UTC month. */
export const paidEmailHitsThisMonth = internalQuery({
  args: { orgId: v.string() },
  handler: async (ctx, args): Promise<number> => {
    const calls = await ctx.db
      .query("providerCalls")
      .withIndex("by_orgId_and_at", (q) => q.eq("orgId", args.orgId).gte("at", utcMonthWindow(Date.now()).start))
      .collect();
    return calls.filter(isPaidEmailHit).length;
  },
});

export const reserveEmailLookup = internalMutation({
  args: { orgId: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const day = new Date().toISOString().slice(0, 10);
    const row = await ctx.db
      .query("emailLookups")
      .withIndex("by_orgId_and_day", (q) => q.eq("orgId", args.orgId).eq("day", day))
      .unique();
    if (row && row.count >= EMAIL_LOOKUPS_PER_DAY) return false;
    if (row) await ctx.db.patch(row._id, { count: row.count + 1 });
    else await ctx.db.insert("emailLookups", { orgId: args.orgId, day, count: 1 });
    return true;
  },
});

export const recordProviderCall = internalMutation({
  args: {
    orgId: v.string(),
    provider: v.optional(v.union(v.literal("treg"), v.literal("deepline"), v.literal("scrapingbee"), v.literal("openrouter"))),
    endpoint: v.string(),
    feature: v.string(),
    callId: v.optional(v.string()),
    costMicro: v.number(),
    outcome: v.union(v.literal("hit"), v.literal("miss")),
  },
  handler: async (ctx, args): Promise<Id<"providerCalls">> => {
    return ctx.db.insert("providerCalls", { ...args, provider: args.provider ?? "treg", at: Date.now() });
  },
});

/** What one lookup did. `paid` is true when a Hunter hit spent a slot of the monthly allowance; `limit_reached` means nothing was looked up. */
export type FindEmailOutcome =
  | { status: "found" | "not_found" | "already_has_email"; email: string | null; paid?: boolean }
  | { status: "limit_reached"; email: null; limit: "daily" | "monthly"; message: string };

/**
 * Find a contact's work email when a rep acts on it. The contact and its
 * employer domain are read from the caller's workspace (never trusted from the
 * client); the result is written back as email + emailStatus, through the
 * ledger as enrichment under its providerCalls row, accepted by the rep (writeFoundEmail).
 *
 * The lookup itself runs through the provider registry (lib/providers/emailFind.ts): the workspace's own Deepline
 * account first when it connected one, which bills the workspace and so spends neither the daily reservation nor the
 * monthly allowance, then Canon's hosted treg chain on a Deepline miss, timeout or failure.
 */
export const findEmail = action({
  args: { accountId: v.string(), contactId: v.string() },
  handler: async (ctx, args): Promise<FindEmailOutcome> => {
    const caller = await requireCaller(ctx);
    const client = clientFor(ctx);
    const detail = await client.get(caller.orgId, args.accountId);
    const contact = detail?.contacts.find((c) => c.id === args.contactId);
    if (!detail || !contact) throw new ConvexError("Contact not found");
    // A paid lookup runs only on a person the caller sees and may edit (CP14), before any spend.
    requireRowAccess(caller.access, "contact", "edit", contact);
    // A role that may not write the field neither reads it here nor fills it (CP14).
    refuseLockedWrite(caller.access, "contact", ["email", "emailStatus"]);
    if (contact.email) return { status: "already_has_email", email: contact.email };
    let found: FoundEmail;
    try { found = await findWorkEmail(ctx, { orgId: caller.orgId, fullName: contact.fullName, domain: detail.account.domain }); }
    catch (error) {
      if (error instanceof EmailLookupLimit) return { status: "limit_reached", email: null, limit: error.limit, message: error.message };
      if (error instanceof ProviderUnavailable) throw new ConvexError(error.message);
      throw error instanceof TregRefusal ? new ConvexError(`Email lookup unavailable: ${error.message}`) : error;
    }
    // A provider that filed no receipt of its own answer (treg's waterfall files one per step) is cited by one here.
    const call = found.call ?? await meter(ctx, { orgId: caller.orgId, provider: "treg", capability: "email.find", endpoint: "guess_and_verify", costMicro: 0, outcome: found.email ? "hit" : "miss" });
    // A found email is enrichment from the call, accepted by the rep who ran it: it fills an empty email and loses to
    // a CRM's, and an email another contact holds is refused in the ledger and the record service alike.
    const edit = foundEmailEdit(contact.id, new Date().toISOString().slice(0, 10), found.email, { provider: found.provider, callId: call });
    if (found.emailStatus) edit.patch.emailStatus = found.emailStatus;
    await writeFoundEmail(await recordEditPorts(ctx, caller, { object: "contact", id: contact.id, ...edit }, "edit"), edit.patch);
    return { status: found.email ? "found" : "not_found", email: found.email, paid: found.paid };
  },
});

// ───────────────────────────── Phone on demand ─────────────────────────────

/** This workspace's phone lookups today and paid phone hits this month, from its providerCalls. */
export const phoneLookupUsage = internalQuery({
  args: { orgId: v.string() },
  handler: async (ctx, args): Promise<{ today: number; hitsThisMonth: number }> => {
    const now = Date.now();
    const calls = await ctx.db
      .query("providerCalls")
      .withIndex("by_orgId_and_at", (q) => q.eq("orgId", args.orgId).gte("at", utcMonthWindow(now).start))
      .collect();
    const dayStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
    return {
      today: calls.filter((c) => c.endpoint === TREG_PHONE_ENDPOINT && c.at >= dayStart).length,
      hitsThisMonth: calls.filter(isPaidPhoneHit).length,
    };
  },
});

export type FindPhoneOutcome =
  | { status: "found" | "not_found" | "already_has_phone"; phone: string | null }
  | { status: "limit_reached"; phone: null; limit: "daily" | "monthly"; message: string };

/**
 * Find a contact's phone when a rep asks for it, through the provider registry (lib/providers/phoneFind.ts): treg's
 * routed phone finder on the deployment's key, billed only on a hit. The contact and its employer domain are read
 * from the caller's workspace; a found number is written to the contact's stream as enrichment the rep accepted,
 * under its providerCalls row.
 */
export const findPhone = action({
  args: { accountId: v.string(), contactId: v.string() },
  handler: async (ctx, args): Promise<FindPhoneOutcome> => {
    const caller = await requireCaller(ctx);
    const client = clientFor(ctx);
    const detail = await client.get(caller.orgId, args.accountId);
    const contact = detail?.contacts.find((c) => c.id === args.contactId);
    if (!detail || !contact) throw new ConvexError("Contact not found");
    // A paid lookup runs only on a person the caller sees and may edit (CP14), before any spend.
    requireRowAccess(caller.access, "contact", "edit", contact);
    // A role that may not write the field neither reads it here nor fills it (CP14).
    refuseLockedWrite(caller.access, "contact", ["phone"]);
    if (contact.phone) return { status: "already_has_phone", phone: contact.phone };
    const resolution = await resolveFor(ctx, caller.orgId, "phone.find");
    if (!resolution.chain.length) throw new ConvexError("Phone lookup is not configured on this deployment.");
    const usage = await ctx.runQuery(internal.records.phoneLookupUsage, { orgId: caller.orgId });
    if (usage.today >= PHONE_LOOKUPS_PER_DAY) {
      return { status: "limit_reached", phone: null, limit: "daily", message: `Daily phone lookup limit (${PHONE_LOOKUPS_PER_DAY}) reached. Try again tomorrow.` };
    }
    if (usage.hitsThisMonth >= PAID_PHONE_HITS_PER_MONTH) {
      return { status: "limit_reached", phone: null, limit: "monthly", message: `Monthly phone lookup allowance (${PAID_PHONE_HITS_PER_MONTH}) used up. It resets on the 1st (UTC).` };
    }
    const day = new Date().toISOString().slice(0, 10);
    let result;
    try {
      result = await findPhoneOn(ctx, resolution, {
        orgId: caller.orgId,
        fullName: contact.fullName,
        domain: detail.account.domain,
        ...(contact.linkedinUrl ? { linkedinUrl: contact.linkedinUrl } : {}),
        ...(contact.email ? { email: contact.email } : {}),
        idempotencyKey: `find-phone:${caller.orgId}:${contact.id}:${day}`,
      });
    } catch (err) {
      throw err instanceof TregRefusal ? new ConvexError(`Phone lookup unavailable: ${err.message}`) : err;
    }
    const call = result.call;
    if (result.phone) {
      // Enrichment the rep accepted: it fills the empty phone and loses to a CRM's.
      const edit = { patch: { phone: result.phone }, idempotencyKey: `find-phone:${contact.id}:${day}:${result.phone}` };
      await editPartyRecord(await recordEditPorts(ctx, caller, { object: "contact", id: contact.id, ...edit, found: { provider: result.provider, callId: call } }, "edit"));
    }
    return { status: result.status, phone: result.phone };
  },
});
