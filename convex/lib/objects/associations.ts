/**
 * Associations (CP3, docs/cp0-object-layer.md): typed edges between records,
 * each an edge stream on the ledger (registry.ts ASSOCIATION_OBJECT). Every
 * change is a `save`, so it gets a ledger entry, a hot row and history; this
 * module adds the rules that span edges (one primary company per contact, one
 * parent per company, no parent cycles) and keeps an index row per edge so a
 * record's edges are one indexed read. Everything runs in one transaction, so
 * moving the primary from one edge to another is atomic.
 *
 * Who owns a contact's companies: the register's `accountId` (set by imports,
 * CSV, CRM syncs and domain linking) is a contact's one company until a
 * person works its associations. The first edge change seeds an edge for that
 * company (`seed`), and from then on the edges are the truth and the record
 * service writes `accountId` from the primary edge (its projector, contract
 * 1.20.0), which upserts and domain linking no longer change. This is CP2a's
 * rule for fields ("worked accounts and contacts") applied to edges.
 *
 * Pure: written against EdgeStore so it runs in a Convex mutation
 * (convex/associations.ts) and in tests.
 */
import { project, type EntryActor, type EntrySource } from "./fold.ts";
import { associationDef, associationObjectDef, DEAL_ROLES, DEAL_SINGLE_ROLES, edgeOf, type AssociationName, type DealRole, type Edge, type ResolvedObjectDef } from "./registry.ts";
import { save, type ObjectStore, type SaveCommand, type SaveContext } from "./write.ts";

/** An edge's index row: the edge, its stream, and when the stream was created (the order a record's edges are listed in). */
export type EdgeRow = Edge & { streamId: string; createdAt: number };

export interface EdgeStore extends ObjectStore {
  /** The edge stream for (association, from, to), active or removed. */
  findEdge(orgId: string, association: AssociationName, fromId: string, toId: string): Promise<EdgeRow | null>;
  /** Edges out of a record, active or removed, oldest first, at most `limit`. */
  edgesFrom(orgId: string, association: AssociationName, fromId: string, limit: number): Promise<EdgeRow[]>;
  /** Edges into a record, active or removed, oldest first, at most `limit`. */
  edgesTo(orgId: string, association: AssociationName, toId: string, limit: number): Promise<EdgeRow[]>;
  /** Write an edge's index row, keyed by its stream. */
  putEdge(orgId: string, row: EdgeRow): Promise<void>;
}

/** Edges one record may have per association; a read of them is one bounded index range. */
export const EDGES_PER_RECORD_MAX = 200;
/** How far up a company's parents a new parent is checked for a cycle. */
const PARENT_DEPTH_MAX = 32;

export type EdgeContext = { orgId: string; source: EntrySource; actor: EntryActor; now: number };

export type EdgeCommand =
  /** Link a contact to a company. The contact's first company is its primary; `primary` makes this one primary. */
  | { op: "link"; fromId: string; toId: string; primary?: boolean }
  /** Remove a contact's company. Removing the primary makes the oldest remaining company primary. */
  | { op: "unlink"; fromId: string; toId: string }
  | { op: "makePrimary"; fromId: string; toId: string }
  /** A company's one parent, replaced or (null) removed. */
  | { op: "setParent"; accountId: string; parentId: string | null }
  /**
   * Put a person on a deal in a role, or change their role (one per deal).
   * Giving a single-holder role (Executive, N-1, Champion, Signer) moves
   * whoever held it to `involved`. `reason` is Canon's, when a person accepted
   * its suggestion; without one the edge's reason is cleared.
   */
  | { op: "setRole"; dealId: string; contactId: string; role: DealRole; reason?: string }
  | { op: "removeFromDeal"; dealId: string; contactId: string }
  /** Make a new activity (its stream id) about each of these records: companies, people or deals, by id. */
  | { op: "target"; activityId: string; toIds: readonly string[] }
  /** Make an activity no longer about these records (a CRM import that moved it). */
  | { op: "untarget"; activityId: string; toIds: readonly string[] };

export type EdgeResult = { status: "applied" | "unchanged" } | { status: "invalid"; message: string };

/**
 * Apply one command. `seed` is the company the register lists for the contact
 * (its `accountId`), read just before: when the contact has no edges yet, it
 * becomes the contact's first, primary edge before the command runs, as an
 * import from the register row.
 */
export async function applyEdgeCommand(store: EdgeStore, ctx: EdgeContext, cmd: EdgeCommand, seed?: string): Promise<EdgeResult> {
  const w = new EdgeWriter(store, ctx);
  if (cmd.op === "setParent") return w.setParent(cmd.accountId, cmd.parentId);
  if (cmd.op === "setRole") return w.setRole(cmd.dealId, cmd.contactId, cmd.role, cmd.reason ?? null);
  if (cmd.op === "removeFromDeal") return w.removeFromDeal(cmd.dealId, cmd.contactId);
  if (cmd.op === "target") return w.target(cmd.activityId, cmd.toIds);
  if (cmd.op === "untarget") return w.untarget(cmd.activityId, cmd.toIds);
  if (cmd.fromId === "" || cmd.toId === "") return { status: "invalid", message: "Name a contact and a company" };
  if (seed) await w.seedContactAccount(cmd.fromId, seed);
  switch (cmd.op) {
    case "link": return w.link(cmd.fromId, cmd.toId, cmd.primary === true);
    case "unlink": return w.unlink(cmd.fromId, cmd.toId);
    case "makePrimary": return w.makePrimary(cmd.fromId, cmd.toId);
  }
}

/**
 * The far ends of `fromId`'s active edges that a source created and that it
 * no longer names: what a CRM re-import removes. An edge is the source's when
 * its stream was created from that source kind, so edges a person or an agent
 * made are never in the list.
 */
export async function edgesFromSourceNotIn(
  store: EdgeStore, orgId: string, association: AssociationName, fromId: string, keep: readonly string[], sourceKind: EntrySource["kind"],
): Promise<string[]> {
  const out: string[] = [];
  for (const e of await store.edgesFrom(orgId, association, fromId, EDGES_PER_RECORD_MAX)) {
    if (!e.active || keep.includes(e.toId)) continue;
    const [first] = await store.readEntries(e.streamId, 0, 1);
    if (first?.source.kind === sourceKind) out.push(e.toId);
  }
  return out;
}

/** An edge's state as a merge's undo puts it back. */
export type EdgeState = { active: boolean; primary: boolean };
/** An edge stream a merge wrote, with its state before (null: the merge created it). */
export type TouchedEdge = {
  streamId: string;
  before: EdgeState | null;
  /** Its state right after the merge: an undo leaves an edge changed since then as it is. */
  after?: EdgeState;
};

export type RepointInput = {
  object: "account" | "contact";
  survivorId: string;
  loserIds: readonly string[];
  /** Contacts whose company nobody has worked yet, with the company the register lists: seeded as their first edge first. */
  seeds: readonly { contactId: string; accountId: string }[];
  /** Activities that name a loser in their `accountId` or `contactId` lookup (they have no edge to it). */
  activityIds: readonly string[];
};

/** Edge streams one merge may write: what one transaction's writes are sized for. */
export const MERGE_EDGES_MAX = 600;

/**
 * Give a merge's survivor the edges of the records merged into it (CP15a). For companies: each contact at a
 * loser is at the survivor too, and primary there when the loser was its primary; the loser's parent becomes
 * the survivor's when it has none; the loser's child companies move under the survivor. For people: each of
 * the loser's companies is the survivor's too, primary only when the survivor has none. Activities about a
 * loser are about the survivor too. A loser's own edges stay: reads hide edges whose other end is deleted,
 * and undoing the merge shows them again. Returns every edge stream it wrote, with its state before.
 */
export async function repointEdges(store: EdgeStore, ctx: EdgeContext, m: RepointInput): Promise<TouchedEdge[]> {
  const w = new EdgeWriter(store, ctx);
  w.touched = new Map();
  await w.repoint(m);
  if (w.touched.size > MERGE_EDGES_MAX) throw new Error(`a merge may change at most ${MERGE_EDGES_MAX} associations`);
  const out: TouchedEdge[] = [];
  for (const [streamId, before] of w.touched) {
    const after = await w.stateOf(streamId);
    out.push({ streamId, before, ...(after ? { after } : {}) });
  }
  return out;
}

/** Undo repointEdges: each edge it wrote goes back to its state before, and edges it created are removed. */
export async function restoreEdges(store: EdgeStore, ctx: EdgeContext, touched: readonly TouchedEdge[]): Promise<void> {
  await new EdgeWriter(store, ctx).restore(touched);
}

/** A deal role set before edges (a `dealContacts` row, #225): who set it, when, and Canon's reason if accepted. */
export type LegacyDealRole = { contactId: string; role: DealRole; reason: string | null; setBy: string; at: number };

/**
 * Turn a deal's legacy roles into its first edges, each dated and attributed
 * as its row was. A deal that has any edge, active or removed, is left alone,
 * so this runs again harmlessly and never brings back a role someone removed.
 * Returns whether it wrote the deal's edges.
 */
export async function seedDealRoles(store: EdgeStore, orgId: string, dealId: string, rows: readonly LegacyDealRole[]): Promise<boolean> {
  if (!rows.length || (await store.edgesFrom(orgId, DEAL_CONTACT, dealId, 1)).length) return false;
  for (const r of [...rows].sort((a, b) => a.at - b.at)) {
    const ctx: EdgeContext = { orgId, source: { kind: "user", ref: `user:${r.setBy}` }, actor: { kind: "user", id: r.setBy }, now: r.at };
    await new EdgeWriter(store, ctx).setRole(dealId, r.contactId, r.role, r.reason);
  }
  return true;
}

const CONTACT_ACCOUNT: AssociationName = "contact_account";
const ACCOUNT_PARENT: AssociationName = "account_parent";
const DEAL_CONTACT: AssociationName = "deal_contact";
const ACTIVITY_TARGET: AssociationName = "activity_target";
/** Records one activity may be about. */
export const ACTIVITY_TARGETS_MAX = 8;
const applied: EdgeResult = { status: "applied" };
const unchanged: EdgeResult = { status: "unchanged" };

class EdgeWriter {
  private readonly def: ResolvedObjectDef = associationObjectDef();
  private changed = false;

  private readonly store: EdgeStore;
  private readonly ctx: EdgeContext;

  constructor(store: EdgeStore, ctx: EdgeContext) {
    this.store = store;
    this.ctx = ctx;
  }

  private result(): EdgeResult {
    return this.changed ? applied : unchanged;
  }

  private active(rows: readonly EdgeRow[]) {
    return rows.filter((r) => r.active);
  }

  /** Each edge stream a merge touched, with its state before (null: the merge created it). Unset outside merges. */
  touched: Map<string, EdgeState | null> | null = null;

  /** An edge stream's state now, from its hot row. */
  async stateOf(streamId: string): Promise<EdgeState | null> {
    return (await this.edgeAt(streamId)) ?? null;
  }

  /** An edge stream's edge now, from its hot row. */
  private async edgeAt(streamId: string): Promise<(EdgeState & { association: AssociationName; fromId: string }) | null> {
    const state = await this.store.getHotRow(streamId);
    const row = state && project(this.def, state);
    const edge = row && edgeOf(row.values, row.deletedAt);
    return edge ? { active: edge.active, primary: edge.primary, association: edge.association, fromId: edge.fromId } : null;
  }

  /** Save one change to an edge stream and rewrite its index row from the stream's new state. */
  private async write(cmd: SaveCommand, source: Pick<SaveContext, "source" | "actor"> = this.ctx): Promise<EdgeRow> {
    const saveCtx: SaveContext = { orgId: this.ctx.orgId, def: this.def, source: source.source, actor: source.actor, now: this.ctx.now };
    if (this.touched && cmd.op !== "create" && !this.touched.has(cmd.streamId)) this.touched.set(cmd.streamId, await this.stateOf(cmd.streamId));
    const r = await save(this.store, saveCtx, cmd);
    if (this.touched && cmd.op === "create" && "streamId" in r && !this.touched.has(r.streamId)) this.touched.set(r.streamId, null);
    if (r.status === "invalid" || r.status === "conflict") throw new Error(`association save ${cmd.op} failed: ${JSON.stringify(r)}`);
    if (r.status === "applied" || r.status === "proposed") this.changed = true;
    const state = await this.store.getHotRow(r.streamId);
    const row = state && project(this.def, state);
    const edge = row && edgeOf(row.values, row.deletedAt);
    if (!state || !edge) throw new Error(`association stream ${r.streamId} has no edge`);
    const indexed: EdgeRow = { ...edge, streamId: r.streamId, createdAt: state.createdAt };
    await this.store.putEdge(this.ctx.orgId, indexed);
    return indexed;
  }

  /** Make (association, from, to) an active edge with `primary`, creating or re-adding its stream. */
  private async ensure(association: AssociationName, fromId: string, toId: string, primary: boolean, source?: Pick<SaveContext, "source" | "actor">): Promise<EdgeRow> {
    const existing = await this.store.findEdge(this.ctx.orgId, association, fromId, toId);
    const flag = associationDef(association).primary ? { primary } : {};
    if (!existing) return this.write({ op: "create", values: { association, fromId, toId, ...flag } }, source);
    let row = existing;
    if (!row.active) row = await this.write({ op: "restore", streamId: row.streamId }, source);
    if (associationDef(association).primary && row.primary !== primary) row = await this.write({ op: "update", streamId: row.streamId, values: { primary } }, source);
    return row;
  }

  private async setPrimaryFlag(row: EdgeRow, primary: boolean) {
    if (row.primary !== primary) await this.write({ op: "update", streamId: row.streamId, values: { primary } });
  }

  async seedContactAccount(contactId: string, accountId: string) {
    const any = await this.store.edgesFrom(this.ctx.orgId, CONTACT_ACCOUNT, contactId, 1);
    if (any.length) return;
    const seeded = await this.ensure(CONTACT_ACCOUNT, contactId, accountId, true, {
      source: { kind: "import", ref: `record:contact:${contactId}` }, actor: { kind: "integration", id: "register" },
    });
    // A seeded edge is what the contact already had (its register company), so a merge's undo keeps it as seeded.
    this.touched?.set(seeded.streamId, { active: true, primary: true });
  }

  /**
   * Give a merge's survivor the edges of the records merged into it (CP15a, repointEdges). Every edge
   * stream this writes is recorded in `touched` with its state before.
   */
  async repoint(m: RepointInput): Promise<void> {
    const losers = new Set(m.loserIds);
    for (const seed of m.seeds) await this.seedContactAccount(seed.contactId, seed.accountId);
    const s = m.survivorId;
    if (m.object === "account") {
      for (const loser of m.loserIds) {
        // People: each contact at a loser is at the survivor too, primary there when the loser was its primary.
        for (const e of this.active(await this.store.edgesTo(this.ctx.orgId, CONTACT_ACCOUNT, loser, EDGES_PER_RECORD_MAX))) {
          const theirs = this.active(await this.store.edgesFrom(this.ctx.orgId, CONTACT_ACCOUNT, e.fromId, EDGES_PER_RECORD_MAX));
          const atSurvivor = theirs.find((x) => x.toId === s);
          if (e.primary) await this.setPrimaryFlag(e, false);
          if (atSurvivor) {
            if (e.primary && !atSurvivor.primary) await this.setPrimaryFlag(atSurvivor, true);
          } else {
            await this.ensure(CONTACT_ACCOUNT, e.fromId, s, e.primary);
          }
        }
        // The loser's parent becomes the survivor's, when the survivor has none and it would not loop.
        const parent = this.active(await this.store.edgesFrom(this.ctx.orgId, ACCOUNT_PARENT, loser, EDGES_PER_RECORD_MAX))[0];
        const survivorParent = this.active(await this.store.edgesFrom(this.ctx.orgId, ACCOUNT_PARENT, s, EDGES_PER_RECORD_MAX))[0];
        if (parent && !survivorParent && parent.toId !== s && !losers.has(parent.toId) && !(await this.isAncestor(s, parent.toId))) {
          await this.ensure(ACCOUNT_PARENT, s, parent.toId, false);
        }
        // The loser's child companies move under the survivor.
        for (const child of this.active(await this.store.edgesTo(this.ctx.orgId, ACCOUNT_PARENT, loser, EDGES_PER_RECORD_MAX))) {
          if (child.fromId === s || losers.has(child.fromId) || (await this.isAncestor(child.fromId, s))) continue;
          await this.write({ op: "delete", streamId: child.streamId });
          await this.ensure(ACCOUNT_PARENT, child.fromId, s, false);
        }
      }
    } else {
      for (const loser of m.loserIds) {
        // Companies: each of the loser's companies is the survivor's too; its primary only when the survivor has none.
        for (const e of this.active(await this.store.edgesFrom(this.ctx.orgId, CONTACT_ACCOUNT, loser, EDGES_PER_RECORD_MAX))) {
          const ours = this.active(await this.store.edgesFrom(this.ctx.orgId, CONTACT_ACCOUNT, s, EDGES_PER_RECORD_MAX));
          if (ours.some((x) => x.toId === e.toId)) continue;
          if (ours.length >= EDGES_PER_RECORD_MAX) break;
          await this.ensure(CONTACT_ACCOUNT, s, e.toId, e.primary && !ours.some((x) => x.primary));
        }
        // Deal roles: the survivor takes the loser's role on each deal it is not on yet. The loser's edge stays,
        // hidden while it is merged, so a single role (one economic buyer) is never held twice where anyone reads it.
        for (const e of this.active(await this.store.edgesTo(this.ctx.orgId, DEAL_CONTACT, loser, EDGES_PER_RECORD_MAX))) {
          const existing = await this.store.findEdge(this.ctx.orgId, DEAL_CONTACT, e.fromId, s);
          if (existing?.active) continue;
          const values = { label: e.label, reason: e.reason ?? null };
          if (!existing) await this.write({ op: "create", values: { association: DEAL_CONTACT, fromId: e.fromId, toId: s, ...values } });
          else {
            await this.write({ op: "restore", streamId: existing.streamId });
            await this.write({ op: "update", streamId: existing.streamId, values });
          }
        }
      }
    }
    // Activities about a loser, by edge or by its lookup, are about the survivor too.
    const activities = new Set(m.activityIds);
    for (const loser of m.loserIds) {
      for (const e of this.active(await this.store.edgesTo(this.ctx.orgId, ACTIVITY_TARGET, loser, EDGES_PER_RECORD_MAX))) activities.add(e.fromId);
    }
    for (const activityId of activities) await this.ensure(ACTIVITY_TARGET, activityId, s, false);
  }

  /** Put each edge a merge touched back as it was before (see restoreEdges): demotions and removals first, so a contact never shows two primaries. */
  async restore(touched: readonly TouchedEdge[]): Promise<void> {
    const target = (t: TouchedEdge): EdgeState => t.before ?? { active: false, primary: false };
    const current = new Map(await Promise.all(touched.map(async (t) => [t.streamId, await this.edgeAt(t.streamId)] as const)));
    const changed = (t: TouchedEdge) => {
      const now = current.get(t.streamId);
      return !t.after || !now || now.active !== t.after.active || now.primary !== t.after.primary;
    };
    // An edge changed since the merge keeps that change. A contact's companies go back together or not at all, so
    // putting back one primary never leaves the contact with two (a company made primary since stays primary).
    const keptContacts = new Set(touched.filter(changed).flatMap((t) => {
      const now = current.get(t.streamId);
      return now?.association === CONTACT_ACCOUNT ? [now.fromId] : [];
    }));
    const restorable = touched.filter((t) => {
      const now = current.get(t.streamId);
      return !changed(t) && !(now?.association === CONTACT_ACCOUNT && keptContacts.has(now.fromId));
    });
    const ordered = [...restorable.filter((t) => !(target(t).active && target(t).primary)), ...restorable.filter((t) => target(t).active && target(t).primary)];
    for (const t of ordered) {
      const want = target(t);
      const now = await this.stateOf(t.streamId);
      if (!now) continue;
      if (!want.active) {
        if (now.primary) await this.write({ op: "update", streamId: t.streamId, values: { primary: false } });
        if (now.active) await this.write({ op: "delete", streamId: t.streamId });
        continue;
      }
      if (!now.active) await this.write({ op: "restore", streamId: t.streamId });
      if (now.primary !== want.primary) await this.write({ op: "update", streamId: t.streamId, values: { primary: want.primary } });
    }
  }

  async link(contactId: string, accountId: string, primary: boolean): Promise<EdgeResult> {
    const edges = this.active(await this.store.edgesFrom(this.ctx.orgId, CONTACT_ACCOUNT, contactId, EDGES_PER_RECORD_MAX));
    const current = edges.find((e) => e.toId === accountId);
    if (current) return primary && !current.primary ? this.makePrimary(contactId, accountId) : this.result();
    if (edges.length >= EDGES_PER_RECORD_MAX) return { status: "invalid", message: `A contact can have at most ${EDGES_PER_RECORD_MAX} companies` };
    const makePrimary = primary || !edges.some((e) => e.primary);
    // Demote first, so the contact never shows two primaries, even inside the transaction.
    if (makePrimary) for (const e of edges) await this.setPrimaryFlag(e, false);
    await this.ensure(CONTACT_ACCOUNT, contactId, accountId, makePrimary);
    return this.result();
  }

  async unlink(contactId: string, accountId: string): Promise<EdgeResult> {
    const edges = this.active(await this.store.edgesFrom(this.ctx.orgId, CONTACT_ACCOUNT, contactId, EDGES_PER_RECORD_MAX));
    const current = edges.find((e) => e.toId === accountId);
    if (!current) return this.result();
    // A removed edge keeps no primary flag, so re-adding it later decides afresh.
    await this.setPrimaryFlag(current, false);
    await this.write({ op: "delete", streamId: current.streamId });
    const rest = edges.filter((e) => e !== current);
    if (current.primary && rest.length && !rest.some((e) => e.primary)) {
      const oldest = [...rest].sort((a, b) => a.createdAt - b.createdAt)[0];
      await this.setPrimaryFlag(oldest, true);
    }
    return this.result();
  }

  async makePrimary(contactId: string, accountId: string): Promise<EdgeResult> {
    const edges = this.active(await this.store.edgesFrom(this.ctx.orgId, CONTACT_ACCOUNT, contactId, EDGES_PER_RECORD_MAX));
    const target = edges.find((e) => e.toId === accountId);
    if (!target) return { status: "invalid", message: "That company is not linked to this contact" };
    for (const e of edges) if (e !== target) await this.setPrimaryFlag(e, false);
    await this.setPrimaryFlag(target, true);
    return this.result();
  }

  async target(activityId: string, toIds: readonly string[]): Promise<EdgeResult> {
    const ends = [...new Set(toIds.filter(Boolean))];
    if (!activityId || !ends.length) return { status: "invalid", message: "Name an activity and a record it is about" };
    if (ends.length > ACTIVITY_TARGETS_MAX) return { status: "invalid", message: `An activity can be about at most ${ACTIVITY_TARGETS_MAX} records` };
    for (const toId of ends) await this.ensure(ACTIVITY_TARGET, activityId, toId, false);
    return this.result();
  }

  async untarget(activityId: string, toIds: readonly string[]): Promise<EdgeResult> {
    for (const toId of new Set(toIds)) {
      const edge = await this.store.findEdge(this.ctx.orgId, ACTIVITY_TARGET, activityId, toId);
      if (edge?.active) await this.write({ op: "delete", streamId: edge.streamId });
    }
    return this.result();
  }

  async setParent(accountId: string, parentId: string | null): Promise<EdgeResult> {
    if (!accountId) return { status: "invalid", message: "Name a company" };
    if (parentId === accountId) return { status: "invalid", message: "A company cannot be its own parent" };
    if (parentId && (await this.isAncestor(accountId, parentId))) return { status: "invalid", message: "That company is already below this one" };
    const parents = this.active(await this.store.edgesFrom(this.ctx.orgId, ACCOUNT_PARENT, accountId, EDGES_PER_RECORD_MAX));
    for (const p of parents) if (p.toId !== parentId) await this.write({ op: "delete", streamId: p.streamId });
    if (parentId && !parents.some((p) => p.toId === parentId)) await this.ensure(ACCOUNT_PARENT, accountId, parentId, false);
    return this.result();
  }

  async setRole(dealId: string, contactId: string, role: DealRole, reason: string | null): Promise<EdgeResult> {
    if (!dealId || !contactId) return { status: "invalid", message: "Name a deal and a person" };
    if (!DEAL_ROLES.includes(role)) return { status: "invalid", message: `Unknown role ${role}` };
    const edges = this.active(await this.store.edgesFrom(this.ctx.orgId, DEAL_CONTACT, dealId, EDGES_PER_RECORD_MAX));
    const current = edges.find((e) => e.toId === contactId);
    if (!current && edges.length >= EDGES_PER_RECORD_MAX) return { status: "invalid", message: `A deal can have at most ${EDGES_PER_RECORD_MAX} people` };
    if (DEAL_SINGLE_ROLES.has(role)) {
      for (const e of edges) {
        if (e.toId !== contactId && e.label === role) await this.write({ op: "update", streamId: e.streamId, values: { label: "involved", reason: null } });
      }
    }
    const values = { label: role, reason };
    if (current) {
      if (current.label !== role || current.reason !== reason) await this.write({ op: "update", streamId: current.streamId, values });
      return this.result();
    }
    const removed = await this.store.findEdge(this.ctx.orgId, DEAL_CONTACT, dealId, contactId);
    if (!removed) {
      await this.write({ op: "create", values: { association: DEAL_CONTACT, fromId: dealId, toId: contactId, ...values } });
      return this.result();
    }
    await this.write({ op: "restore", streamId: removed.streamId });
    await this.write({ op: "update", streamId: removed.streamId, values });
    return this.result();
  }

  async removeFromDeal(dealId: string, contactId: string): Promise<EdgeResult> {
    const edge = await this.store.findEdge(this.ctx.orgId, DEAL_CONTACT, dealId, contactId);
    if (edge?.active) await this.write({ op: "delete", streamId: edge.streamId });
    return this.result();
  }

  /** Whether `accountId` is `candidate` or one of its parents' parents: then `candidate` cannot become its parent. */
  private async isAncestor(accountId: string, candidate: string): Promise<boolean> {
    let current = candidate;
    for (let depth = 0; depth < PARENT_DEPTH_MAX; depth++) {
      const up = this.active(await this.store.edgesFrom(this.ctx.orgId, ACCOUNT_PARENT, current, EDGES_PER_RECORD_MAX));
      if (!up.length) return false;
      current = up[0].toId;
      if (current === accountId) return true;
    }
    return true;
  }
}
