/**
 * A deal's people and their roles (CP3b, docs/account-plays.md): each is a
 * `deal_contact` edge from the deal's stream to a contact's register id,
 * labelled with the role (lib/objects/associations.ts).
 *
 * Before edges, #225 kept the committee in `dealContacts`. Until a deal has
 * its first edge, reads show those rows, and the first change to the deal's
 * people turns them into edges in the same transaction; `migrateDealContacts`
 * converts the rest. Nothing writes `dealContacts` any more. It is dropped
 * once every deployment has migrated.
 */
import { can, refusal } from "./lib/capabilities";
import { ConvexError, v } from "convex/values";
import { action, internalMutation, internalQuery, type ActionCtx, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { dealsOfCompany } from "./deals";
import { callerClient, requireCaller } from "./records";
import { isRestricted, may, type Access } from "./lib/access";
import { dealVisible } from "./permissions";
import { edgeStore, peopleOfCompany, rowsById } from "./associations";
import { applyEdgeCommand, EDGES_PER_RECORD_MAX, seedDealRoles, type EdgeResult, type LegacyDealRole } from "./lib/objects/associations";
import { DEAL_ROLES, type DealRole } from "./lib/objects/registry";

/** Rows one deal's legacy committee held (#225's cap). */
const LEGACY_MAX = 50;
/** Legacy rows one migration batch reads. */
const MIGRATE_BATCH = 100;

const roleValidator = v.union(...DEAL_ROLES.map((r) => v.literal(r)));
const outcomeOf = (d: Doc<"deals">) => (d.isClosed ? (d.isWon ? "won" : "lost") : "open") as "open" | "won" | "lost";

/** The deal a record page's stream projects, in the caller's org. */
export async function dealOfStream(ctx: QueryCtx, orgId: Id<"organizations">, streamId: string): Promise<Doc<"deals"> | null> {
  const id = ctx.db.normalizeId("canonEntities", streamId);
  const entity = id ? await ctx.db.get(id) : null;
  if (!entity || entity.orgId !== orgId || entity.projectionTable !== "deals") return null;
  const dealId = ctx.db.normalizeId("deals", entity.projectionId);
  const deal = dealId ? await ctx.db.get(dealId) : null;
  return deal && deal.orgId === orgId ? deal : null;
}

/** Admins and managers edit any deal (the Deals page's rule); a rep edits the people of a deal they own. */
export function mayEdit(user: Doc<"users">, deal: Doc<"deals">): boolean {
  return can(user, "deals.write") || deal.primaryRepId === user._id;
}

const legacyRows = (ctx: QueryCtx, dealId: Id<"deals">) =>
  ctx.db.query("dealContacts").withIndex("by_dealId", (q) => q.eq("dealId", dealId)).take(LEGACY_MAX);

const asLegacy = (r: Doc<"dealContacts">): LegacyDealRole => ({ contactId: r.contactId, role: r.slot, reason: r.reason ?? null, setBy: r.setBy, at: r.updatedAt });

/** One person on a deal. `snapshot` is the name and title a legacy row kept, for a contact the register no longer lists. */
type Member = { contactId: string; role: DealRole; reason: string | null; snapshot: { name: string; title: string | null } | null };

/** A deal's people: its active edges, or its legacy rows while it has no edge at all. */
export async function membersOf(ctx: QueryCtx, orgId: Id<"organizations">, deal: Doc<"deals">, streamId: string): Promise<Member[]> {
  const edges = await ctx.db.query("associations")
    .withIndex("by_orgId_association_fromId_toId", (q) => q.eq("orgId", orgId).eq("association", "deal_contact").eq("fromId", streamId))
    .take(EDGES_PER_RECORD_MAX);
  if (edges.length) {
    return edges.filter((e) => e.active).sort((a, b) => a.createdAt - b.createdAt)
      .map((e) => ({ contactId: e.toId, role: e.label as DealRole, reason: e.reason ?? null, snapshot: null }));
  }
  return (await legacyRows(ctx, deal._id)).map((r) => ({ contactId: r.contactId, role: r.slot, reason: r.reason ?? null, snapshot: { name: r.contactName, title: r.title ?? null } }));
}

const streamOfDeal = async (ctx: QueryCtx, orgId: Id<"organizations">, dealId: Id<"deals">) =>
  (await ctx.db.query("canonEntities").withIndex("by_orgId_projectionId", (q) => q.eq("orgId", orgId).eq("projectionId", dealId)).first())?._id ?? null;

/** The caller's access (records.callerContext), when the read is a person's: their deals only (CP14). */
const accessArg = v.optional(v.any());
const sees = (access: unknown, deal: Doc<"deals">) => !access || dealVisible(access as Access, deal);

export const dealPeople = internalQuery({
  args: { orgId: v.id("organizations"), userId: v.id("users"), streamId: v.string(), access: accessArg },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    const deal = user ? await dealOfStream(ctx, args.orgId, args.streamId) : null;
    if (!user || !deal || !sees(args.access, deal)) return null;
    return { companyId: deal.companyId ?? null, canEdit: mayEdit(user, deal), members: await membersOf(ctx, args.orgId, deal, args.streamId) };
  },
});

export type ContactDeal = { streamId: string; name: string; stage: string | null; outcome: "open" | "won" | "lost"; role: DealRole };

/** The deals a contact is on, with their role on each. Legacy rows show once migrated. */
export const dealsOfContact = internalQuery({
  args: { orgId: v.id("organizations"), contactId: v.string(), access: accessArg },
  handler: async (ctx, args): Promise<ContactDeal[]> => {
    const edges = await ctx.db.query("associations")
      .withIndex("by_orgId_association_toId", (q) => q.eq("orgId", args.orgId).eq("association", "deal_contact").eq("toId", args.contactId))
      .take(EDGES_PER_RECORD_MAX);
    const rows = await Promise.all(edges.filter((e) => e.active).map(async (e) => {
      const deal = await dealOfStream(ctx, args.orgId, e.fromId);
      return deal && sees(args.access, deal) ? [{ streamId: e.fromId, name: deal.name, stage: deal.stage ?? null, outcome: outcomeOf(deal), role: e.label as DealRole }] : [];
    }));
    return rows.flat();
  },
});

export const companyRoles = internalQuery({
  args: { orgId: v.id("organizations"), companyId: v.string(), domain: v.optional(v.string()), stream: v.optional(v.string()), access: accessArg },
  handler: async (ctx, args) => {
    const deals = (await dealsOfCompany(ctx, args.orgId, args)).filter((d) => sees(args.access, d));
    const rows = await Promise.all(deals.map(async (d) => {
      const streamId = await streamOfDeal(ctx, args.orgId, d._id);
      const members = streamId ? await membersOf(ctx, args.orgId, d, streamId) : (await legacyRows(ctx, d._id)).map((r) => ({
        contactId: r.contactId, role: r.slot as DealRole, reason: null, snapshot: { name: r.contactName, title: r.title ?? null },
      }));
      return members.map((m) => ({ ...m, dealName: d.name, dealStreamId: streamId, outcome: outcomeOf(d), closeDate: d.closeDate }));
    }));
    return rows.flat();
  },
});

const command = v.union(
  v.object({ op: v.literal("setRole"), contactId: v.string(), role: roleValidator, reason: v.optional(v.string()) }),
  v.object({ op: v.literal("removeFromDeal"), contactId: v.string() }),
);
const edgeResult = v.union(
  v.object({ status: v.union(v.literal("applied"), v.literal("unchanged")) }),
  v.object({ status: v.literal("invalid"), message: v.string() }),
);

/** One person's change to a deal's people, in one transaction; a deal still on legacy rows is converted first. */
export const apply = internalMutation({
  args: { orgId: v.id("organizations"), userId: v.id("users"), streamId: v.string(), command },
  returns: edgeResult,
  handler: async (ctx, args): Promise<EdgeResult> => {
    const user = await ctx.db.get(args.userId);
    const deal = user && user.orgId === args.orgId ? await dealOfStream(ctx, args.orgId, args.streamId) : null;
    if (!user || !deal) throw new ConvexError("Deal not found");
    if (!mayEdit(user, deal)) throw new ConvexError("Only admins, managers and the deal's owner can change its people");
    const store = edgeStore(ctx);
    await seedDealRoles(store, args.orgId, args.streamId, (await legacyRows(ctx, deal._id)).map(asLegacy));
    const edgeCtx = { orgId: args.orgId, source: { kind: "user" as const, ref: `user:${args.userId}` }, actor: { kind: "user" as const, id: args.userId }, now: Date.now() };
    const { contactId } = args.command;
    return applyEdgeCommand(store, edgeCtx, args.command.op === "setRole"
      ? { op: "setRole", dealId: args.streamId, contactId, role: args.command.role, ...(args.command.reason ? { reason: args.command.reason } : {}) }
      : { op: "removeFromDeal", dealId: args.streamId, contactId });
  },
});

/**
 * Put several people on a deal in their roles, as `apply` does one at a time (a CSV import's Contacts column). A deal
 * still on legacy rows is converted first. Returns the people it changed; a refusal comes back as `error`.
 */
export async function setDealRoles(
  ctx: MutationCtx, orgId: Id<"organizations">, userId: Id<"users">, streamId: string, members: ReadonlyArray<{ contactId: string; role: DealRole }>,
): Promise<{ changed: number; error: string | null }> {
  const user = await ctx.db.get(userId);
  const deal = user && user.orgId === orgId ? await dealOfStream(ctx, orgId, streamId) : null;
  if (!user || !deal) return { changed: 0, error: "Deal not found" };
  if (!mayEdit(user, deal)) return { changed: 0, error: "Only admins, managers and the deal's owner can change its people" };
  const store = edgeStore(ctx);
  await seedDealRoles(store, orgId, streamId, (await legacyRows(ctx, deal._id)).map(asLegacy));
  const edgeCtx = { orgId, source: { kind: "user" as const, ref: `user:${userId}` }, actor: { kind: "user" as const, id: userId }, now: Date.now() };
  let changed = 0;
  for (const m of members) {
    const result = await applyEdgeCommand(store, edgeCtx, { op: "setRole", dealId: streamId, contactId: m.contactId, role: m.role });
    if (result.status === "invalid") return { changed, error: result.message };
    if (result.status === "applied") changed++;
  }
  return { changed, error: null };
}

async function change(ctx: ActionCtx, streamId: string, cmd: { op: "setRole"; contactId: string; role: DealRole; reason?: string } | { op: "removeFromDeal"; contactId: string }): Promise<EdgeResult> {
  const caller = await requireCaller(ctx);
  // A deal's people are the deal's: the caller edits deals and sees this one (CP14). A person added must be one they see.
  if (!may(caller.access, "deal", "edit")) throw new ConvexError("Your role cannot edit deal records");
  if (!(await ctx.runQuery(internal.dealCommittee.dealPeople, { orgId: caller.orgId as Id<"organizations">, userId: caller.userId as Id<"users">, streamId, access: caller.access }))) {
    throw new ConvexError("Deal not found");
  }
  if (cmd.op === "setRole" && !(await rowsById(callerClient(ctx, caller), caller.orgId, "contact", [cmd.contactId])).has(cmd.contactId)) {
    throw new ConvexError("Contact not found");
  }
  const result = await ctx.runMutation(internal.dealCommittee.apply, {
    orgId: caller.orgId as Id<"organizations">, userId: caller.userId as Id<"users">, streamId, command: cmd,
  });
  if (result.status === "invalid") throw new ConvexError(result.message);
  return result;
}

/**
 * Put a person on a deal in a role, or change their role. Executive, N-1,
 * Champion and Signer hold one person: whoever held it stays on the deal as
 * Involved. `reason` is Canon's, when a person accepts its suggestion.
 */
export const setRole = action({
  args: { streamId: v.string(), contactId: v.string(), role: roleValidator, reason: v.optional(v.string()) },
  returns: edgeResult,
  handler: (ctx, args): Promise<EdgeResult> =>
    change(ctx, args.streamId, { op: "setRole", contactId: args.contactId, role: args.role, ...(args.reason ? { reason: args.reason } : {}) }),
});

export const removeFromDeal = action({
  args: { streamId: v.string(), contactId: v.string() },
  returns: edgeResult,
  handler: (ctx, args): Promise<EdgeResult> => change(ctx, args.streamId, { op: "removeFromDeal", contactId: args.contactId }),
});

export type DealPerson = { contactId: string; name: string; title: string | null; role: DealRole; reason: string | null; atCompany: boolean };
export type DealPeople = { companyId: string | null; canEdit: boolean; members: DealPerson[]; companyPeople: Array<{ id: string; fullName: string; title?: string }> };

/**
 * A deal's people for its record page, named from the register, and the
 * people of its company, whom Canon picks from. A contact the register no
 * longer lists is left out, unless a legacy row kept its name.
 */
export const forDeal = action({
  args: { streamId: v.string() },
  handler: async (ctx, args): Promise<DealPeople | null> => {
    const caller = await requireCaller(ctx, { read: true });
    const orgId = caller.orgId as Id<"organizations">;
    const client = callerClient(ctx, caller);
    const data = await ctx.runQuery(internal.dealCommittee.dealPeople, { orgId, userId: caller.userId as Id<"users">, streamId: args.streamId, access: caller.access });
    // A person the caller does not see is left out, not shown by the name a legacy row kept (CP14).
    const restricted = isRestricted(caller.access);
    if (!data) return null;
    const [contacts, people] = await Promise.all([
      rowsById(client, orgId, "contact", data.members.map((m) => m.contactId)),
      data.companyId ? peopleOfCompany(ctx, client, orgId, data.companyId) : Promise.resolve([]),
    ]);
    const atCompany = new Set(people.map((p) => p.id));
    const members = data.members.flatMap((m): DealPerson[] => {
      const row = contacts.get(m.contactId);
      const name = row?.title || (restricted ? null : m.snapshot?.name);
      if (!name) return [];
      const title = row ? (typeof row.values.title === "string" && row.values.title ? row.values.title : null) : m.snapshot?.title ?? null;
      return [{ contactId: m.contactId, name, title, role: m.role, reason: m.reason, atCompany: atCompany.has(m.contactId) }];
    });
    return {
      companyId: data.companyId, canEdit: data.canEdit, members,
      companyPeople: people.map((p) => ({ id: p.id, fullName: p.name, ...(p.title ? { title: p.title } : {}) })),
    };
  },
});

export type CompanyRole = { id: string; contactId: string; contactName: string; title: string | null; role: DealRole; dealName: string; dealStreamId: string | null; outcome: "open" | "won" | "lost"; closeDate: string };

/**
 * Everyone who has held a role on a company's deals, for its account page:
 * the person, the role, the deal and how it ended. Whether they still work
 * there is read by the page from the company's current contacts.
 */
export const forCompany = action({
  args: { companyId: v.string(), domain: v.optional(v.string()), stream: v.optional(v.string()) },
  handler: async (ctx, args): Promise<CompanyRole[]> => {
    const caller = await requireCaller(ctx, { read: true });
    const orgId = caller.orgId as Id<"organizations">;
    const rows = await ctx.runQuery(internal.dealCommittee.companyRoles, { orgId, ...args, access: caller.access });
    const contacts = await rowsById(callerClient(ctx, caller), orgId, "contact", rows.map((r) => r.contactId));
    const restricted = isRestricted(caller.access);
    return rows.flatMap((r): CompanyRole[] => {
      const row = contacts.get(r.contactId);
      const contactName = row?.title || (restricted ? null : r.snapshot?.name);
      if (!contactName) return [];
      const title = row ? (typeof row.values.title === "string" && row.values.title ? row.values.title : null) : r.snapshot?.title ?? null;
      return [{
        id: `${r.dealStreamId ?? r.dealName}:${r.contactId}`, contactId: r.contactId, contactName, title, role: r.role,
        dealName: r.dealName, dealStreamId: r.dealStreamId, outcome: r.outcome, closeDate: r.closeDate,
      }];
    });
  },
});

/**
 * Convert `dealContacts` rows into `deal_contact` edges, a batch at a time,
 * scheduling the next batch until done. Each deal is converted whole, the
 * first time one of its rows is read, and only while it has no edge, so the
 * run resumes from any cursor and runs again harmlessly. A deal with no
 * stream yet is skipped and logged. Run on a deployment with
 * `dealCommittee:migrateDealContacts '{}'`.
 */
export const migrateDealContacts = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.object({ deals: v.number(), converted: v.number(), noStream: v.number(), isDone: v.boolean() }),
  handler: async (ctx, args) => {
    const page = await ctx.db.query("dealContacts").paginate({ numItems: MIGRATE_BATCH, cursor: args.cursor ?? null });
    const store = edgeStore(ctx);
    const dealIds = [...new Set(page.page.map((r) => r.dealId))];
    let converted = 0;
    let noStream = 0;
    for (const dealId of dealIds) {
      const deal = await ctx.db.get(dealId);
      const streamId = deal ? await streamOfDeal(ctx, deal.orgId, deal._id) : null;
      if (!deal || !streamId) { noStream++; continue; }
      if (await seedDealRoles(store, deal.orgId, streamId, (await legacyRows(ctx, deal._id)).map(asLegacy))) converted++;
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.dealCommittee.migrateDealContacts, { cursor: page.continueCursor });
    console.log(`migrateDealContacts: ${dealIds.length} deals, ${converted} converted, ${noStream} without a stream, done=${page.isDone}`);
    return { deals: dealIds.length, converted, noStream, isDone: page.isDone };
  },
});
