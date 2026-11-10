/**
 * Associations on the record pages (CP3, lib/objects/associations.ts): a
 * contact's companies, a company's people, and a company's parent and child
 * companies. Changes are actions so they can check both ends against the
 * caller's register first and return once the record service has projected
 * them (a contact's `accountId` follows its primary edge). Reads hide an edge
 * whose other end the register no longer lists, so deleting a record hides its
 * edges and restoring it brings them back, with no edge entries written.
 */
import { ConvexError, v, type Infer } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { action, internalMutation, internalQuery, type ActionCtx, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { convexObjectStore } from "./objects";
import { callerClient, requireCaller, type ActionCaller } from "./records";
import { may } from "./lib/access";
import { applyEdgeCommand, EDGES_PER_RECORD_MAX, type EdgeCommand, type EdgeResult, type EdgeRow, type EdgeStore } from "./lib/objects/associations";
import type { AssociationName } from "./lib/objects/registry";
import type { RecordClient } from "./lib/recordClient";
import type { RegisterListRow } from "./lib/objects/listSpec";
import type { ContactDeal } from "./dealCommittee";

const asEdgeRow = (d: Doc<"associations">): EdgeRow => ({
  association: d.association as AssociationName, fromId: d.fromId, toId: d.toId, label: d.label, primary: d.primary, reason: d.reason ?? null, active: d.active,
  streamId: d.streamId, createdAt: d.createdAt,
});

export function edgeStore(ctx: MutationCtx): EdgeStore {
  const org = (id: string) => id as Id<"organizations">;
  return {
    ...convexObjectStore(ctx),
    async findEdge(orgId, association, fromId, toId) {
      const d = await ctx.db.query("associations")
        .withIndex("by_orgId_association_fromId_toId", (q) => q.eq("orgId", org(orgId)).eq("association", association).eq("fromId", fromId).eq("toId", toId))
        .first();
      return d ? asEdgeRow(d) : null;
    },
    async edgesFrom(orgId, association, fromId, limit) {
      const rows = await ctx.db.query("associations")
        .withIndex("by_orgId_association_fromId_toId", (q) => q.eq("orgId", org(orgId)).eq("association", association).eq("fromId", fromId))
        .take(limit);
      return rows.map(asEdgeRow).sort((a, b) => a.createdAt - b.createdAt);
    },
    async edgesTo(orgId, association, toId, limit) {
      const rows = await ctx.db.query("associations")
        .withIndex("by_orgId_association_toId", (q) => q.eq("orgId", org(orgId)).eq("association", association).eq("toId", toId))
        .take(limit);
      return rows.map(asEdgeRow).sort((a, b) => a.createdAt - b.createdAt);
    },
    async putEdge(orgId, row) {
      const doc = {
        orgId: org(orgId), association: row.association, fromId: row.fromId, toId: row.toId, streamId: row.streamId as Id<"canonEntities">,
        label: row.label, primary: row.primary, reason: row.reason, active: row.active, createdAt: row.createdAt,
      };
      const existing = await ctx.db.query("associations").withIndex("by_streamId", (q) => q.eq("streamId", doc.streamId)).unique();
      if (existing) await ctx.db.replace(existing._id, doc);
      else await ctx.db.insert("associations", doc);
    },
  };
}

const command = v.union(
  v.object({ op: v.literal("link"), fromId: v.string(), toId: v.string(), primary: v.optional(v.boolean()) }),
  v.object({ op: v.literal("unlink"), fromId: v.string(), toId: v.string() }),
  v.object({ op: v.literal("makePrimary"), fromId: v.string(), toId: v.string() }),
  v.object({ op: v.literal("setParent"), accountId: v.string(), parentId: v.union(v.string(), v.null()) }),
);
const edgeResult = v.union(
  v.object({ status: v.union(v.literal("applied"), v.literal("unchanged")) }),
  v.object({ status: v.literal("invalid"), message: v.string() }),
);

/** One person's change to edges, in one transaction. */
export const apply = internalMutation({
  args: { orgId: v.id("organizations"), userId: v.id("users"), command, seed: v.optional(v.string()) },
  returns: edgeResult,
  handler: (ctx, args): Promise<EdgeResult> => applyAsUser(ctx, args.orgId, args.userId, args.command as EdgeCommand, args.seed),
});

/** The one edge write a person makes: the ledger records them as source and actor. */
export function applyAsUser(ctx: MutationCtx, orgId: Id<"organizations">, userId: Id<"users">, cmd: EdgeCommand, seed?: string): Promise<EdgeResult> {
  const edgeCtx = { orgId, source: { kind: "user" as const, ref: `user:${userId}` }, actor: { kind: "user" as const, id: userId }, now: Date.now() };
  return applyEdgeCommand(edgeStore(ctx), edgeCtx, cmd, seed);
}

const associationName = v.union(v.literal("contact_account"), v.literal("account_parent"), v.literal("deal_contact"));

/** A record's active edges of one association, out of it (`from`) or into it (`to`), and whether it ever had one. */
export const edges = internalQuery({
  args: { orgId: v.id("organizations"), association: associationName, side: v.union(v.literal("from"), v.literal("to")), id: v.string() },
  handler: (ctx, args): Promise<{ active: EdgeRow[]; worked: boolean }> => edgesOf(ctx, args.orgId, args.association, args.side, args.id),
});

/** A record's edges of one association, oldest first: the `edges` query, and the same read inside a mutation. */
export async function edgesOf(ctx: QueryCtx, orgId: Id<"organizations">, association: Infer<typeof associationName>, side: "from" | "to", id: string) {
  const index = side === "from"
    ? ctx.db.query("associations").withIndex("by_orgId_association_fromId_toId", (q) => q.eq("orgId", orgId).eq("association", association).eq("fromId", id))
    : ctx.db.query("associations").withIndex("by_orgId_association_toId", (q) => q.eq("orgId", orgId).eq("association", association).eq("toId", id));
  const rows = (await index.take(EDGES_PER_RECORD_MAX)).map(asEdgeRow).sort((a, b) => a.createdAt - b.createdAt);
  return { active: rows.filter((r) => r.active), worked: rows.length > 0 };
}

/**
 * A page of the workspace's active parent edges, for a whole-workspace read (the account hierarchy scan). Ends are
 * ids only: the reader keeps an edge only when its record client returned both companies.
 */
export const parentEdgesPage = internalQuery({
  args: { orgId: v.id("organizations"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("associations")
      .withIndex("by_orgId_association_fromId_toId", (q) => q.eq("orgId", args.orgId).eq("association", "account_parent"))
      .paginate(args.paginationOpts);
    return {
      page: page.page.filter((d) => d.active).map((d) => ({ childId: d.fromId, parentId: d.toId, createdAt: d.createdAt })),
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

/** The live register rows among `ids`; a deleted or unknown id is left out. */
export async function rowsById(client: RecordClient, orgId: string, object: "account" | "contact", ids: readonly string[]): Promise<Map<string, RegisterListRow>> {
  const unique = [...new Set(ids)].filter(Boolean).slice(0, EDGES_PER_RECORD_MAX);
  if (!unique.length) return new Map();
  const page = await client.listRegister(orgId, object, { filter: [{ field: "id", op: "in", value: unique }], limit: unique.length });
  return new Map(page.rows.map((r) => [r.id, r]));
}

const text = (v: unknown) => (typeof v === "string" && v ? v : null);

/** Wait until the record service has projected the caller's org's ledger, so a reread shows the change. */
async function settle(ctx: ActionCtx, client: RecordClient, orgId: string) {
  if (client.mode !== "http") return;
  const heads = await ctx.runQuery(internal.ledgerFeed.shardHeadsOf, { orgId: orgId as Id<"organizations"> });
  await client.nudgeProjector(orgId, heads, process.env.CONVEX_SITE_URL, { wait: true });
}

export type EdgeChange = Infer<typeof command>;
export type EdgeWrite = (args: { orgId: Id<"organizations">; userId: Id<"users">; command: EdgeChange; seed?: string }) => Promise<EdgeResult>;

async function change(ctx: ActionCtx, cmd: EdgeChange): Promise<EdgeResult> {
  const result = await changeAs(ctx, await requireCaller(ctx), cmd);
  if (result.status === "invalid") throw new ConvexError(result.message);
  return result;
}

/**
 * A caller's change to edges, after reading both ends as they see them. `write` is the transaction that makes it:
 * `apply` by default, or a caller's own mutation that checks more in the same transaction (the account hierarchy's
 * compare-and-set). An invalid result is returned, not thrown, so that caller can keep it.
 */
export async function changeAs(ctx: ActionCtx, caller: ActionCaller, cmd: EdgeChange, write: EdgeWrite = (args) => ctx.runMutation(internal.associations.apply, args)): Promise<EdgeResult> {
  // Both ends are read as the caller sees them (CP14): a record they cannot see is not found, and linking edits them.
  const client = callerClient(ctx, caller);
  const isParent = cmd.op === "setParent";
  if (!may(caller.access, isParent ? "account" : "contact", "edit")) throw new ConvexError(`Your role cannot edit ${isParent ? "companies" : "people"}`);
  const contactId = isParent ? null : cmd.fromId;
  // Both ends must be live records of the caller's workspace. A company being removed may already be gone.
  const accountIds = isParent ? [cmd.accountId, ...(cmd.parentId ? [cmd.parentId] : [])] : cmd.op === "unlink" ? [] : [cmd.toId];
  const [contacts, accounts] = await Promise.all([
    contactId ? rowsById(client, caller.orgId, "contact", [contactId]) : Promise.resolve(new Map<string, RegisterListRow>()),
    rowsById(client, caller.orgId, "account", accountIds),
  ]);
  if (contactId && !contacts.has(contactId)) throw new ConvexError("Contact not found");
  if (accountIds.some((id) => !accounts.has(id))) throw new ConvexError("Company not found");
  // The company the register lists for the contact: its first edge, if this is the first change to its companies.
  const seed = contactId ? contacts.get(contactId)?.accountId || undefined : undefined;
  const result = await write({ orgId: caller.orgId as Id<"organizations">, userId: caller.userId as Id<"users">, command: cmd, ...(seed ? { seed } : {}) });
  if (result.status === "applied") await settle(ctx, client, caller.orgId);
  return result;
}

/** Link a contact to a company; the contact's first company is its primary. */
export const link = action({
  args: { contactId: v.string(), accountId: v.string(), primary: v.optional(v.boolean()) },
  returns: edgeResult,
  handler: (ctx, args): Promise<EdgeResult> => change(ctx, { op: "link", fromId: args.contactId, toId: args.accountId, ...(args.primary ? { primary: true } : {}) }),
});

/** Remove a contact's company. Removing the primary makes the oldest remaining company primary. */
export const unlink = action({
  args: { contactId: v.string(), accountId: v.string() },
  returns: edgeResult,
  handler: (ctx, args): Promise<EdgeResult> => change(ctx, { op: "unlink", fromId: args.contactId, toId: args.accountId }),
});

/** Make one of a contact's companies its primary, and the others not, in one transaction. */
export const makePrimary = action({
  args: { contactId: v.string(), accountId: v.string() },
  returns: edgeResult,
  handler: (ctx, args): Promise<EdgeResult> => change(ctx, { op: "makePrimary", fromId: args.contactId, toId: args.accountId }),
});

/** Set or (null) remove a company's parent company. */
export const setParent = action({
  args: { accountId: v.string(), parentId: v.union(v.string(), v.null()) },
  returns: edgeResult,
  handler: (ctx, args): Promise<EdgeResult> => change(ctx, { op: "setParent", accountId: args.accountId, parentId: args.parentId }),
});

export type RelatedCompany = { id: string; name: string; domain: string | null; primary: boolean };
export type RelatedPerson = { id: string; name: string; title: string | null; email: string | null; phone: string | null; linkedinUrl: string | null; primary: boolean };
export type Related =
  | { object: "contact"; companies: RelatedCompany[]; deals: ContactDeal[] }
  | { object: "account"; people: RelatedPerson[]; parent: RelatedCompany | null; children: RelatedCompany[] };

const companyOf = (row: RegisterListRow, primary: boolean): RelatedCompany => ({ id: row.id, name: row.title || row.id, domain: text(row.values.domain), primary });

/** A company's people: those whose primary company it is first, then anyone else linked to it, by name. */
export async function peopleOfCompany(ctx: ActionCtx, client: RecordClient, orgId: Id<"organizations">, accountId: string): Promise<RelatedPerson[]> {
  const [inbound, primaryPeople] = await Promise.all([
    ctx.runQuery(internal.associations.edges, { orgId, association: "contact_account", side: "to", id: accountId }),
    // The people whose primary company this is: the register's accountId, set from the primary edge once worked.
    client.listContacts(orgId, { filter: { accountId }, limit: EDGES_PER_RECORD_MAX }),
  ]);
  const people = new Map<string, RelatedPerson>(primaryPeople.rows.map((c) => [c.id, {
    id: c.id, name: c.fullName || c.id, title: c.title || null, email: c.email || null, phone: c.phone || null, linkedinUrl: c.linkedinUrl || null, primary: true,
  }]));
  const others = inbound.active.filter((e) => !people.has(e.fromId));
  const otherRows = await rowsById(client, orgId, "contact", others.map((e) => e.fromId));
  for (const e of others) {
    const row = otherRows.get(e.fromId);
    if (!row) continue;
    people.set(row.id, {
      id: row.id, name: row.title || row.id, title: text(row.values.title), email: text(row.values.email), phone: text(row.values.phone), linkedinUrl: text(row.values.linkedinUrl), primary: e.primary,
    });
  }
  return [...people.values()].sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name));
}

/**
 * A record's related lists. A contact whose companies nobody has worked yet
 * shows the one company the register lists for it, as its primary. Edges to
 * records the register no longer lists (deleted) are left out.
 */
export const related = action({
  args: { object: v.union(v.literal("account"), v.literal("contact")), id: v.string() },
  handler: async (ctx, args): Promise<Related | null> => {
    const caller = await requireCaller(ctx, { read: true });
    // The record and every related one as the caller sees them (CP14).
    const client = callerClient(ctx, caller);
    const orgId = caller.orgId as Id<"organizations">;
    const edgesOf = (association: "contact_account" | "account_parent", side: "from" | "to") =>
      ctx.runQuery(internal.associations.edges, { orgId, association, side, id: args.id });

    if (args.object === "contact") {
      const [contacts, out, deals] = await Promise.all([
        rowsById(client, caller.orgId, "contact", [args.id]),
        edgesOf("contact_account", "from"),
        ctx.runQuery(internal.dealCommittee.dealsOfContact, { orgId, contactId: args.id, access: caller.access }),
      ]);
      const contact = contacts.get(args.id);
      if (!contact) return null;
      const links = (out.worked ? out.active.map((e) => ({ id: e.toId, primary: e.primary })) : contact.accountId ? [{ id: contact.accountId, primary: true }] : [])
        .sort((a, b) => Number(b.primary) - Number(a.primary));
      const accounts = await rowsById(client, caller.orgId, "account", links.map((l) => l.id));
      return { object: "contact", companies: links.flatMap((l) => (accounts.has(l.id) ? [companyOf(accounts.get(l.id)!, l.primary)] : [])), deals };
    }

    const [accounts, people, parents, children] = await Promise.all([
      rowsById(client, caller.orgId, "account", [args.id]),
      peopleOfCompany(ctx, client, orgId, args.id),
      edgesOf("account_parent", "from"),
      edgesOf("account_parent", "to"),
    ]);
    if (!accounts.has(args.id)) return null;
    const family = await rowsById(client, caller.orgId, "account", [...parents.active.map((e) => e.toId), ...children.active.map((e) => e.fromId)]);
    const parent = parents.active.map((e) => family.get(e.toId)).find((r) => r !== undefined);
    return {
      object: "account",
      people,
      parent: parent ? companyOf(parent, false) : null,
      children: children.active.flatMap((e) => (family.has(e.fromId) ? [companyOf(family.get(e.fromId)!, false)] : [])),
    };
  },
});
