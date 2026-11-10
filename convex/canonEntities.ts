/**
 * Canon identity for accounts and contacts (docs/canoncrm-spec.md).
 *
 * TAM accounts live in the record service, which a mutation cannot read, so a
 * TAM row gets a Canon entity by promotion: lib/recordPromotion.ts reads the
 * whole rows of the records the caller sees and anchors one entity per company
 * (and, optionally, per person), linked by domain / email and record id. A
 * promotion also puts the record on the ledger (docs/cp0-object-layer.md,
 * migration step 7): its stream starts from the TAM row. A research run anchors
 * a company's identity only, through anchorAccounts. Synced CRM rows get their
 * entity on first use instead (convex/canon.ts saveCrmAccount), and share it
 * with the TAM row through the domain.
 */
import { ConvexError, v } from "convex/values";
import { action, internalMutation, internalQuery, query, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUser } from "./lib";
import { callerClient, requireCaller } from "./records";
import { PROMOTE_MAX, promoteAccounts, type Anchored, type Promoted } from "./lib/recordPromotion";
import { hiddenFields, may, type Access } from "./lib/access";
import { accessFor, querySees, sightJudge } from "./permissions";
import { admitThenRead } from "./lib/scopedRecordClient";
import type { EntityType } from "./lib/canon/attributes";
import { convexLedgerStore, partySyncHasBudget, saveParty } from "./canon";
import { recordContactValues, recordSeed, syncPartyBatch } from "./lib/canon/partyLedger";
import { ensureEntity } from "./lib/canon/ledger";
import { ID, accountExternalIds, contactExternalIds, normalizeDomain, normalizeEmail } from "./lib/canon/identity";
import { entityTypeValidator } from "./canonGate";
import { parseCitation } from "./lib/fitExplain";

/** Contacts promoted per account. */
const CONTACTS_PER_ACCOUNT = 100;

const contactInput = v.object({
  recordId: v.string(), fullName: v.string(), email: v.optional(v.string()),
  title: v.optional(v.string()), linkedinUrl: v.optional(v.string()),
  /** When the record service last changed the row: the import's valid time, so a promotion read before a newer edit cannot beat it. */
  updatedAt: v.optional(v.number()),
});
const accountInput = v.object({
  recordId: v.string(), domain: v.string(), name: v.string(), contacts: v.array(contactInput),
  /** The TAM row a promoted account's stream starts from. */
  snapshot: v.optional(v.object({
    updatedAt: v.number(), industry: v.optional(v.string()), employees: v.optional(v.number()), country: v.optional(v.string()),
    linkedinUrl: v.optional(v.string()), status: v.optional(v.string()), ownerId: v.optional(v.string()),
  })),
});

type ContactInput = typeof contactInput.type;

/**
 * Put each account on the ledger, then its contacts: Canon identity and a
 * stream that starts from the row given (lib/recordPromotion.ts promoteAccounts
 * alone calls this, with whole rows). Contacts are visited while the
 * transaction's facts-read budget holds (syncPartyBatch, as a CRM sync's rows
 * are): a long-lived contact re-resolves its appended fields from up to 200
 * facts each. The contacts not reached come back as `unprocessed`, for the
 * caller to submit again with the same account, whose write is then unchanged.
 */
export const promoteRecords = internalMutation({
  args: { orgId: v.id("organizations"), accounts: v.array(accountInput) },
  handler: async (ctx, args) => {
    const out: Array<Promoted & { unprocessed: ContactInput[] }> = [];
    for (const a of args.accounts) {
      const { entityId } = await saveParty(ctx, {
        orgId: args.orgId, object: "account", identity: accountIdentity(a), seed: null,
        ...recordSeed("account", { id: a.recordId, domain: a.domain, name: a.name, updatedAt: a.snapshot?.updatedAt ?? Date.now(), ...a.snapshot }),
      });
      const contacts: Promoted["contacts"] = [];
      const { unprocessed } = await syncPartyBatch(a.contacts.slice(0, CONTACTS_PER_ACCOUNT), { hasBudget: () => partySyncHasBudget(ctx), visit: async (c) => {
        const { entityId: contactId } = await saveParty(ctx, {
          orgId: args.orgId, object: "contact", identity: contactIdentity(c), seed: null,
          source: { kind: "import", ref: `record:contact:${c.recordId}`, actorId: "record-service", ...(c.updatedAt !== undefined ? { validFrom: c.updatedAt } : {}) },
          values: recordContactValues(c),
        });
        contacts.push({ recordId: c.recordId, entityId: contactId });
      } });
      out.push({ recordId: a.recordId, entityId, contacts, unprocessed });
    }
    return out;
  },
});

const accountIdentity = (a: { recordId: string; domain: string; name: string }) => ({
  projectionTable: "recordAccounts" as const, projectionId: a.recordId, label: a.name,
  externalIds: accountExternalIds({ domain: a.domain, recordId: a.recordId }),
});
const contactIdentity = (c: { recordId: string; fullName: string; email?: string }) => ({
  projectionTable: "recordContacts" as const, projectionId: c.recordId, label: c.fullName,
  externalIds: contactExternalIds({ email: c.email, recordId: c.recordId }),
});

/** Canon identity for companies, without putting them on the ledger (a research run's targets). Takes no row values. */
export const anchorAccounts = internalMutation({
  args: { orgId: v.id("organizations"), accounts: v.array(v.object({ recordId: v.string(), domain: v.string(), name: v.string() })) },
  handler: async (ctx, args): Promise<Anchored[]> => {
    const store = convexLedgerStore(ctx);
    const out: Anchored[] = [];
    for (const a of args.accounts) {
      out.push({ recordId: a.recordId, entityId: await ensureEntity(store, { orgId: args.orgId, entityType: "account", ...accountIdentity(a) }) as Id<"canonEntities"> });
    }
    return out;
  },
});

/**
 * Anchor Canon identity for contacts alone (no account row needed): a contact with an email joins the entity
 * that email already names, so a contact worked elsewhere keeps one identity. A contact whose stream hasn't
 * started gets one from the row given (lib/recordPromotion.ts promoteContacts alone calls this, with whole rows).
 * Returns record id to entity id.
 */
export const anchorContacts = internalMutation({
  args: { orgId: v.id("organizations"), contacts: v.array(contactInput) },
  handler: async (ctx, args): Promise<Anchored[]> => {
    const store = convexLedgerStore(ctx);
    const out: Anchored[] = [];
    for (const c of args.contacts.slice(0, CONTACTS_PER_ACCOUNT)) {
      const identity = contactIdentity(c);
      let entityId = await ensureEntity(store, { orgId: args.orgId, entityType: "contact", ...identity }) as Id<"canonEntities">;
      // A stream's first entry starts it from the row, as a promotion does: the projector then writes the
      // research's facts back to this row, not to a new one it would add for an unseeded stream.
      const started = await ctx.db.query("ledgerEntries").withIndex("by_streamId_version", (q) => q.eq("streamId", entityId)).first();
      if (!started) {
        entityId = (await saveParty(ctx, {
          orgId: args.orgId, object: "contact", identity, seed: null,
          source: { kind: "import", ref: `record:contact:${c.recordId}`, actorId: "record-service", ...(c.updatedAt !== undefined ? { validFrom: c.updatedAt } : {}) },
          values: recordContactValues(c),
        })).entityId as Id<"canonEntities">;
      }
      out.push({ recordId: c.recordId, entityId });
    }
    return out;
  },
});

/**
 * Promote TAM accounts (record-service ids), optionally with their people,
 * onto the ledger: Canon identity and a stream that starts from the TAM row,
 * so they are worked records agents can propose facts about. Idempotent.
 */
export const promote = action({
  args: { accountIds: v.array(v.string()), includeContacts: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<{ promoted: Promoted[]; notFound: string[] }> => {
    if (args.accountIds.length > PROMOTE_MAX) throw new ConvexError(`Promote at most ${PROMOTE_MAX} accounts at a time`);
    const caller = await requireCaller(ctx);
    // Promoting starts a record's ledger stream, an edit of a company the caller sees (CP14).
    if (!may(caller.access, "account", "edit")) throw new ConvexError("Your role cannot edit companies");
    return promoteAccounts(ctx, callerClient(ctx, caller), caller.orgId as Id<"organizations">, args.accountIds, args.includeContacts);
  },
});

const FIT_ATTRIBUTES = ["industry", "country", "employees"] as const;

/**
 * The cited facts behind an account's fit inputs: for industry, country and
 * employees, the resolved ledger value when its evidence is a verbatim quote
 * with a source URL (research and enrichment facts). Empty for a record that
 * has no entity or no cited fact; callers compare `value` with the row they show.
 */
export const fitCitations = query({
  args: { recordId: v.string() },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    const r = await fitCitationsAs(ctx, user, args.recordId, new Set());
    // A role that sees only some companies: null, and the page asks fitCitationsScoped (CP14).
    return r.pending.length ? null : r.value;
  },
});

/** A company's cited fit facts, as `user` may see them: only a company they see (sightJudge), without fields hidden from them. */
async function fitCitationsAs(ctx: QueryCtx, user: Doc<"users">, recordId: string, admitted: ReadonlySet<string>) {
  const access = await accessFor(ctx, user);
  const judge = sightJudge(ctx, [access], admitted);
  const ext = await ctx.db.query("canonExternalIds")
    .withIndex("by_orgId_provider_externalId", (q) => q.eq("orgId", user.orgId).eq("provider", ID.recordAccount).eq("externalId", recordId))
    .first();
  const entity = ext ? await ctx.db.get(ext.entityId) : null;
  if (!entity || entity.orgId !== user.orgId || !(await judge.entity(entity))) return { pending: judge.pending, value: [] };
  const hidden = new Set(hiddenFields(access, "account"));
  const out = [];
  for (const attribute of FIT_ATTRIBUTES.filter((a) => !hidden.has(a))) {
    const state = await ctx.db.query("canonFieldState").withIndex("by_entityId_attribute", (q) => q.eq("entityId", entity._id).eq("attribute", attribute)).first();
    const fact = state?.state === "resolved" && state.factId ? await ctx.db.get(state.factId) : null;
    const cited = parseCitation(fact?.evidence);
    if (fact && cited && !Array.isArray(fact.value)) out.push({ attribute, value: fact.value, sourceKind: fact.sourceKind, observedAt: fact.observedAt, ...cited });
  }
  return { pending: judge.pending, value: out };
}

export const fitCitationsFor = internalQuery({
  args: { recordId: v.string(), admitted: v.array(v.string()) },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    return user ? fitCitationsAs(ctx, user, args.recordId, new Set(args.admitted)) : { pending: [], value: [] };
  },
});

/** fitCitations for a role that sees only some companies: the company is admitted through the caller's scoped client. */
export const fitCitationsScoped = action({
  args: { recordId: v.string() },
  handler: async (ctx, args): Promise<Awaited<ReturnType<typeof fitCitationsAs>>["value"]> => {
    const caller = await requireCaller(ctx, { read: true });
    return admitThenRead(callerClient(ctx, caller), caller.orgId, (admitted) => ctx.runQuery(internal.canonEntities.fitCitationsFor, { ...args, admitted }));
  },
});

const findArgs = {
  entityType: entityTypeValidator,
  entityId: v.optional(v.string()),
  recordId: v.optional(v.string()),
  domain: v.optional(v.string()),
  email: v.optional(v.string()),
};

/** Find an account or contact's entity by entity id, record id, domain or email. Null when it has none yet, or the caller does not see it (CP14). */
export const find = query({
  args: findArgs,
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    return findAs(ctx, user.orgId, [await accessFor(ctx, user)], args, new Set());
  },
});

/** `find` for an action that admitted the record through the caller's scoped client (Ask Canon). */
export const findFor = internalQuery({
  // Access objects as lib/access.ts accessOf builds them; internal callers only.
  args: { orgId: v.id("organizations"), accesses: v.array(v.any()), admitted: v.array(v.string()), ...findArgs },
  handler: (ctx, { orgId, accesses, admitted, ...args }) => findAs(ctx, orgId, accesses as Access[], args, new Set(admitted)),
});

/**
 * The entity, its identifiers and its field states, for a record every one of
 * `accesses` sees (permissions.querySees, with the record-service ids an
 * action admitted), without the fields any of them has hidden.
 */
async function findAs(
  ctx: QueryCtx, orgId: Id<"organizations">, accesses: readonly Access[],
  args: { entityType: EntityType; entityId?: string; recordId?: string; domain?: string; email?: string }, admitted: ReadonlySet<string>,
) {
  {
    const user = { orgId };
    let entityId: Id<"canonEntities"> | null = args.entityId ? ctx.db.normalizeId("canonEntities", args.entityId) : null;
    if (!entityId) {
      const key = args.recordId
        ? { provider: args.entityType === "contact" ? ID.recordContact : ID.recordAccount, externalId: args.recordId }
        : args.domain && args.entityType === "account" ? { provider: ID.domain, externalId: normalizeDomain(args.domain) }
        : args.email && args.entityType === "contact" ? { provider: ID.email, externalId: normalizeEmail(args.email) }
        : null;
      if (!key) return null;
      const ext = await ctx.db.query("canonExternalIds")
        .withIndex("by_orgId_provider_externalId", (q) => q.eq("orgId", user.orgId).eq("provider", key.provider).eq("externalId", key.externalId))
        .first();
      entityId = ext?.entityId ?? null;
    }
    const entity = entityId ? await ctx.db.get(entityId) : null;
    if (!entity || entity.orgId !== user.orgId || entity.entityType !== args.entityType) return null;
    if (!(await querySees(ctx, accesses, entity, admitted))) return null;
    const object = entity.entityType === "opportunity" ? "deal" : entity.entityType;
    const hidden = new Set(accesses.flatMap((a) => hiddenFields(a, object)));
    const externalIds = await ctx.db.query("canonExternalIds").withIndex("by_entityId", (q) => q.eq("entityId", entity._id)).take(50);
    const fields = (await ctx.db.query("canonFieldState").withIndex("by_entityId_attribute", (q) => q.eq("entityId", entity._id)).take(200)).filter((f) => !hidden.has(f.attribute));
    return {
      entityId: entity._id, entityType: entity.entityType, label: entity.label ?? null,
      projection: { table: entity.projectionTable, id: entity.projectionId },
      // `op:` rows are claimed edit operations (lib/canon/partyLedger.ts writeParty), not identity.
      externalIds: externalIds.filter((x) => !x.provider.startsWith("op:")).map((x) => ({ provider: x.provider, externalId: x.externalId })),
      fields: fields.map((f) => ({ attribute: f.attribute, value: f.value, state: f.state, sourceKind: f.sourceKind, factId: f.factId, updatedAt: f.updatedAt })),
    };
  }
}

