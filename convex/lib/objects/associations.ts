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
import { project, type EntryActor, type EntrySource, type LedgerEntry } from "./fold.ts";
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
  /** A stream's newest entry that `match` accepts, read back from its latest entry; null when none does. */
  lastEntry(streamId: string, match: (e: LedgerEntry) => boolean): Promise<LedgerEntry | null>;
  /** Where a CRM's value is kept when it differs from what a person decided in Canon. A CRM write of a CLAIMED association needs it. */
  disagreements?: DisagreementStore;
  /**
   * Whether an edge write attributed to a person (`userId`, at `at`) was a HubSpot import that person started, from
   * before the import wrote `association` as HubSpot (legacy attribution).
   */
  legacyHubspotImport?(orgId: string, association: AssociationName, userId: string, at: number): Promise<boolean>;
}

/** A CRM provider whose import or sync writes links. */
export type CrmProvider = "salesforce" | "hubspot";
const CRM_PROVIDERS: ReadonlySet<string> = new Set<CrmProvider>(["salesforce", "hubspot"]);

/**
 * The associations whose differing CRM values are kept, each with a page where a person sees and settles them.
 * Activity targets follow the same rule but keep none: no page edits what an activity is about.
 */
export const CLAIMED: ReadonlySet<AssociationName> = new Set<AssociationName>(["account_parent", "contact_account", "deal_contact"]);

/**
 * What one CRM record says about a link, kept because a person decided it otherwise in Canon (EdgeWriter.disagree).
 * `fromId` is the record the link is from: a company, a person or a deal. `toId` is the far end the CRM names: a
 * company's parent (null: none), a company the person is at (`primary`: as their primary company), a person on the
 * deal in role `label`.
 */
export type Disagreement = {
  association: "account_parent" | "contact_account" | "deal_contact";
  fromId: string;
  toId: string | null;
  primary?: true;
  label?: DealRole;
  provider: CrmProvider;
  ref: string;
  seenAt: number;
};
export type StoredDisagreement = Disagreement & { id: string };

/**
 * One kept disagreement per claim: a company's parent per CRM record; per CRM record and person, each company they are
 * at and their primary company; per CRM record and deal, each person's role.
 */
export const sameClaim = (a: Disagreement, b: Disagreement) =>
  a.association === b.association && a.fromId === b.fromId && a.ref === b.ref && Boolean(a.primary) === Boolean(b.primary)
  && (a.association === "account_parent" || a.primary === true || a.toId === b.toId);

export interface DisagreementStore {
  /** The disagreements kept for links from `fromId`, from every CRM record. */
  of(orgId: string, fromId: string): Promise<StoredDisagreement[]>;
  /** Keep `d`, in place of the stored one with the same claim (`replaces`). */
  put(orgId: string, d: Disagreement, replaces: string | null): Promise<void>;
  remove(orgId: string, id: string): Promise<void>;
}

/**
 * Who decides one facet of a link (EdgeWriter.crm): a CRM record (its source ref), Canon (a person on a record page,
 * an approved hierarchy move, a merge, an agent), or nobody yet (null: never decided, or the register's company a
 * contact's first edge was seeded with, which an import or CRM sync put there).
 */
export type LinkOwner = { by: "crm"; provider: CrmProvider; ref: string } | { by: "canon" } | null;

/** Edges one record may have per association; a read of them is one bounded index range. */
export const EDGES_PER_RECORD_MAX = 200;
/** How far up a company's parents a new parent is checked for a cycle. */
const PARENT_DEPTH_MAX = 32;

/** `createdAt`: when the source made a link, for an edge this creates (a CRM import's own date); its writes are dated `now`. */
export type EdgeContext = { orgId: string; source: EntrySource; actor: EntryActor; now: number; createdAt?: number };

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
  | { op: "untarget"; activityId: string; toIds: readonly string[] }
  /**
   * A CRM's only: the links from `fromId` this CRM record names, all of them (a re-import). Links it made and no
   * longer names are removed, except a person's companies, which a CRM only adds; what it said about the others is no
   * longer kept.
   */
  | { op: "keepOnly"; association: "contact_account" | "deal_contact" | "activity_target"; fromId: string; toIds: readonly string[] };

export type EdgeResult = { status: "applied" | "unchanged" } | { status: "invalid"; message: string };

/**
 * Apply one command. `seed` is the company the register lists for the contact
 * (its `accountId`), read just before: when the contact has no edges yet, it
 * becomes the contact's first, primary edge before the command runs, as an
 * import from the register row.
 *
 * A command whose actor is an integration is a CRM's and goes through the CRM rule (EdgeWriter.crm): it writes only
 * what no person decided in Canon, and keeps the rest as a disagreement. Every other actor is Canon's.
 */
export async function applyEdgeCommand(store: EdgeStore, ctx: EdgeContext, cmd: EdgeCommand, seed?: string): Promise<EdgeResult> {
  const w = new EdgeWriter(store, ctx);
  if ("fromId" in cmd && cmd.op !== "keepOnly" && (cmd.fromId === "" || cmd.toId === "")) return { status: "invalid", message: "Name a contact and a company" };
  if (seed && "fromId" in cmd && cmd.op !== "keepOnly") await w.seedContactAccount(cmd.fromId, seed);
  return ctx.actor.kind === "integration" ? w.crm(cmd) : w.canon(cmd);
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

const CONTACT_ACCOUNT = "contact_account" satisfies AssociationName;
const ACCOUNT_PARENT = "account_parent" satisfies AssociationName;
const DEAL_CONTACT = "deal_contact" satisfies AssociationName;
const ACTIVITY_TARGET = "activity_target" satisfies AssociationName;
/** Records one activity may be about. */
export const ACTIVITY_TARGETS_MAX = 8;
const applied: EdgeResult = { status: "applied" };
/**
 * The edge to `toId` among a record's edges, active or removed, read as one range (null: it has none). Undefined
 * when the range was cut at its cap, so the edge must be looked up.
 */
const known = (all: readonly EdgeRow[], toId: string): EdgeRow | null | undefined =>
  all.find((e) => e.toId === toId) ?? (all.length < EDGES_PER_RECORD_MAX ? null : undefined);
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
    // An edge's flag or label is written only when it differs from what the edge shows, so it is always a new fact, even
    // when this source said the same before (a person putting back their primary after a CRM moved it).
    const dated = cmd.op === "create" && this.ctx.createdAt !== undefined ? { ...cmd, createdAt: this.ctx.createdAt } : cmd.op === "update" ? { ...cmd, reassert: true as const } : cmd;
    const r = await save(this.store, saveCtx, dated);
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
  private async ensure(association: AssociationName, fromId: string, toId: string, primary: boolean, source?: Pick<SaveContext, "source" | "actor">, known?: EdgeRow | null): Promise<EdgeRow> {
    const existing = known !== undefined ? known : await this.store.findEdge(this.ctx.orgId, association, fromId, toId);
    const flag = associationDef(association).primary ? { primary } : {};
    if (!existing) return this.write({ op: "create", values: { association, fromId, toId, ...flag } }, source);
    let row = existing;
    if (!row.active) row = await this.write({ op: "restore", streamId: row.streamId }, source);
    if (associationDef(association).primary && row.primary !== primary) row = await this.write({ op: "update", streamId: row.streamId, values: { primary } }, source);
    return row;
  }

  /** The edge (from, to), from the record's edges already read when they hold it. */
  private async edgeIn(all: readonly EdgeRow[], association: AssociationName, fromId: string, toId: string): Promise<EdgeRow | null> {
    const k = known(all, toId);
    return k !== undefined ? k : this.store.findEdge(this.ctx.orgId, association, fromId, toId);
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

  /** `all`: the contact's edges, active or removed, when already read. */
  async link(contactId: string, accountId: string, primary: boolean, all?: EdgeRow[]): Promise<EdgeResult> {
    all ??= await this.store.edgesFrom(this.ctx.orgId, CONTACT_ACCOUNT, contactId, EDGES_PER_RECORD_MAX);
    const edges = this.active(all);
    const current = edges.find((e) => e.toId === accountId);
    if (current) return primary && !current.primary ? this.makePrimary(contactId, accountId) : this.result();
    if (edges.length >= EDGES_PER_RECORD_MAX) return { status: "invalid", message: `A contact can have at most ${EDGES_PER_RECORD_MAX} companies` };
    const makePrimary = primary || !edges.some((e) => e.primary);
    // Demote first, so the contact never shows two primaries, even inside the transaction.
    if (makePrimary) for (const e of edges) await this.setPrimaryFlag(e, false);
    await this.ensure(CONTACT_ACCOUNT, contactId, accountId, makePrimary, undefined, known(all, accountId));
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

  /** A Canon command: written as asked. */
  async canon(cmd: EdgeCommand): Promise<EdgeResult> {
    switch (cmd.op) {
      case "link": return this.link(cmd.fromId, cmd.toId, cmd.primary === true);
      case "unlink": return this.unlink(cmd.fromId, cmd.toId);
      case "makePrimary": return this.makePrimary(cmd.fromId, cmd.toId);
      case "setParent": return (await this.parentRefusal(cmd.accountId, cmd.parentId)) ?? this.writeParent(cmd.accountId, cmd.parentId);
      case "setRole": return this.setRole(cmd.dealId, cmd.contactId, cmd.role, cmd.reason ?? null);
      case "removeFromDeal": return this.removeFromDeal(cmd.dealId, cmd.contactId);
      case "target": return this.target(cmd.activityId, cmd.toIds);
      case "untarget": return this.untarget(cmd.activityId, cmd.toIds);
      case "keepOnly": return { status: "invalid", message: "Only a CRM import removes the links it no longer names" };
    }
  }

  /**
   * The CRM rule: the one place a CRM import or sync (actor `integration`, source the CRM record) writes links. A
   * person's intervention has priority. Each command is judged on the facets a person can decide about its links:
   * - a company's parent (`parent`): many-to-one, so one value, decided over all the company's parent links;
   * - whether a link exists (`link`), for each company a person is at, person on a deal and record an activity is about;
   * - which of a person's companies is primary (`primary`), and a person's role on a deal (`role`): the field on the link.
   * A facet Canon decides (linkOwner, fieldOwner) is not written over: what the CRM says instead is kept as a
   * disagreement, once per value, for a person to take or leave, and is cleared when the CRM agrees. A facet a CRM
   * decides, or nobody yet, follows the CRM. A CRM removes only a link it made itself: for a parent, that CRM record
   * (several CRM records can be one Canon company); otherwise, that CRM.
   */
  async crm(cmd: EdgeCommand): Promise<EdgeResult> {
    if (!CRM_PROVIDERS.has(this.ctx.source.kind)) throw new Error(`an integration's link write needs a CRM source, not ${this.ctx.source.kind}`);
    switch (cmd.op) {
      case "link": return this.crmLink(cmd.fromId, cmd.toId, cmd.primary === true);
      case "makePrimary": return this.crmLink(cmd.fromId, cmd.toId, true);
      case "unlink": return (await this.crmOwns(CONTACT_ACCOUNT, cmd.fromId, cmd.toId)) ? this.unlink(cmd.fromId, cmd.toId) : this.result();
      case "setParent": return (await this.parentRefusal(cmd.accountId, cmd.parentId)) ?? this.crmSetParent(cmd.accountId, cmd.parentId);
      case "setRole": return this.crmSetRole(cmd.dealId, cmd.contactId, cmd.role);
      case "removeFromDeal": return (await this.crmOwns(DEAL_CONTACT, cmd.dealId, cmd.contactId)) ? this.removeFromDeal(cmd.dealId, cmd.contactId) : this.result();
      case "target": return this.crmTarget(cmd.activityId, cmd.toIds);
      case "untarget":
        for (const toId of new Set(cmd.toIds)) if (await this.crmOwns(ACTIVITY_TARGET, cmd.activityId, toId)) await this.untarget(cmd.activityId, [toId]);
        return this.result();
      case "keepOnly": return this.crmKeepOnly(cmd.association, cmd.fromId, cmd.toIds);
    }
  }

  private get provider(): CrmProvider {
    return this.ctx.source.kind as CrmProvider;
  }

  /** Who a source is, as an owner: a CRM record, nobody (the register's seeded company), or Canon. */
  private async ownerBy(association: AssociationName, source: EntrySource, at: number): Promise<LinkOwner> {
    if (CRM_PROVIDERS.has(source.kind)) return { by: "crm", provider: source.kind as CrmProvider, ref: source.ref };
    if (source.kind === "import") return null;
    const userId = source.kind === "user" && source.ref.startsWith("user:") ? source.ref.slice("user:".length) : null;
    if (userId && (await this.store.legacyHubspotImport?.(this.ctx.orgId, association, userId, at))) return { by: "crm", provider: "hubspot", ref: "hubspot:legacy" };
    return { by: "canon" };
  }

  /**
   * Who decides whether an edge exists: the source of its latest create or restore when active, of its latest removal
   * when not. One read back from the stream's latest entry to its latest lifecycle entry (or its first).
   */
  private async linkOwner(edge: EdgeRow): Promise<LinkOwner> {
    const entry = await this.store.lastEntry(edge.streamId, (e) => e.body.kind === "lifecycle" || e.version === 1);
    return entry ? this.ownerBy(edge.association, entry.source, entry.observedAt) : null;
  }

  /** Who decides a field on an edge (a contact's primary flag, a deal role): the source of the value it shows, from its hot row. */
  private async fieldOwner(edge: EdgeRow, field: "primary" | "label"): Promise<LinkOwner> {
    const state = await this.store.getHotRow(edge.streamId);
    const factId = state && project(this.def, state).meta[field]?.factId;
    const fact = factId ? state.fields[field]?.candidates.find((c) => c.factId === factId) : undefined;
    return fact ? this.ownerBy(edge.association, { kind: fact.sourceKind, ref: fact.sourceRef }, fact.observedAt) : null;
  }

  /** Whether this CRM made the active edge (from, to), so it may remove it. */
  private async crmOwns(association: AssociationName, fromId: string, toId: string): Promise<boolean> {
    const edge = await this.store.findEdge(this.ctx.orgId, association, fromId, toId);
    if (!edge?.active) return false;
    const owner = await this.linkOwner(edge);
    return owner?.by === "crm" && owner.provider === this.provider;
  }

  private claim(c: Pick<Disagreement, "association" | "fromId" | "toId" | "primary" | "label">): Disagreement {
    return { ...c, provider: this.provider, ref: this.ctx.source.ref, seenAt: this.ctx.now };
  }

  private disagreementStore(): DisagreementStore {
    if (!this.store.disagreements) throw new Error("a CRM write of a claimed association needs a disagreement store");
    return this.store.disagreements;
  }

  /** Keep what the CRM says instead of what Canon decided, unless it is already kept with the same value. */
  private async disagree(d: Disagreement): Promise<void> {
    const store = this.disagreementStore();
    const kept = (await store.of(this.ctx.orgId, d.fromId)).find((k) => sameClaim(k, d));
    if (kept && kept.toId === d.toId && kept.label === d.label) return;
    await store.put(this.ctx.orgId, d, kept?.id ?? null);
  }

  /** The CRM agrees with Canon on this claim: nothing is kept for it. */
  private async agree(d: Disagreement): Promise<void> {
    const store = this.disagreementStore();
    for (const k of await store.of(this.ctx.orgId, d.fromId)) if (sameClaim(k, d)) await store.remove(this.ctx.orgId, k.id);
  }

  /**
   * A CRM lists a person at a company, first (`primary`) when it is their primary. A company a person removed them from
   * stays removed; a primary company a person chose stays primary. The person's first company is primary when they
   * have none, as on the record page.
   */
  private async crmLink(contactId: string, accountId: string, primary: boolean): Promise<EdgeResult> {
    const all = await this.store.edgesFrom(this.ctx.orgId, CONTACT_ACCOUNT, contactId, EDGES_PER_RECORD_MAX);
    const edges = this.active(all);
    const at = this.claim({ association: CONTACT_ACCOUNT, fromId: contactId, toId: accountId });
    if (!edges.some((e) => e.toId === accountId)) {
      const removed = await this.edgeIn(all, CONTACT_ACCOUNT, contactId, accountId);
      if (removed && (await this.linkOwner(removed))?.by === "canon") {
        await this.disagree(at);
        return this.result();
      }
    }
    const primaryNow = edges.find((e) => e.primary);
    const asPrimary = { ...at, primary: true as const };
    const takesPrimary = primary && (!primaryNow || primaryNow.toId === accountId || (await this.fieldOwner(primaryNow, "primary"))?.by !== "canon");
    const result = await this.link(contactId, accountId, takesPrimary, all);
    if (result.status === "invalid") return result;
    await this.agree(at);
    if (primary) await (takesPrimary ? this.agree(asPrimary) : this.disagree(asPrimary));
    return result;
  }

  /**
   * A CRM puts a person on a deal in a role. A person a person removed from the deal stays off it, and a role a person
   * gave stays: the CRM's role is kept as a disagreement. A single-holder role a person gave someone else stays theirs,
   * and a newcomer the CRM gives it joins as involved.
   */
  private async crmSetRole(dealId: string, contactId: string, role: DealRole): Promise<EdgeResult> {
    if (!dealId || !contactId) return { status: "invalid", message: "Name a deal and a person" };
    if (!DEAL_ROLES.includes(role)) return { status: "invalid", message: `Unknown role ${role}` };
    const all = await this.store.edgesFrom(this.ctx.orgId, DEAL_CONTACT, dealId, EDGES_PER_RECORD_MAX);
    const edges = this.active(all);
    const current = edges.find((e) => e.toId === contactId);
    const said = this.claim({ association: DEAL_CONTACT, fromId: dealId, toId: contactId, label: role });
    if (current?.label === role) {
      await this.agree(said);
      return this.result();
    }
    const removed = current ? null : await this.edgeIn(all, DEAL_CONTACT, dealId, contactId);
    const holder = DEAL_SINGLE_ROLES.has(role) ? edges.find((e) => e.toId !== contactId && e.label === role) : undefined;
    const keptOff = removed !== null && (await this.linkOwner(removed))?.by === "canon";
    const keptRole = !keptOff && current !== undefined && (await this.fieldOwner(current, "label"))?.by === "canon";
    const keptHolder = !keptOff && !keptRole && holder !== undefined && (await this.fieldOwner(holder, "label"))?.by === "canon";
    if (!keptOff && !keptRole && !keptHolder) {
      const result = await this.setRole(dealId, contactId, role, null, all);
      if (result.status !== "invalid") await this.agree(said);
      return result;
    }
    await this.disagree(said);
    // Only the single role was a person's (someone else holds it): the CRM's newcomer still joins the deal, as involved.
    return keptHolder && !current ? this.setRole(dealId, contactId, "involved", null, all) : this.result();
  }

  /** A CRM makes an activity about these records. One a person took it off stays off. */
  private async crmTarget(activityId: string, toIds: readonly string[]): Promise<EdgeResult> {
    const allowed: string[] = [];
    for (const toId of new Set(toIds.filter(Boolean))) {
      const edge = await this.store.findEdge(this.ctx.orgId, ACTIVITY_TARGET, activityId, toId);
      if (edge && !edge.active && (await this.linkOwner(edge))?.by === "canon") continue;
      allowed.push(toId);
    }
    if (!allowed.length) return toIds.length ? this.result() : this.target(activityId, toIds);
    return this.target(activityId, allowed);
  }

  /** See `keepOnly`. Links a person made or put back stay. */
  private async crmKeepOnly(association: "contact_account" | "deal_contact" | "activity_target", fromId: string, keep: readonly string[]): Promise<EdgeResult> {
    for (const e of association === CONTACT_ACCOUNT ? [] : await this.store.edgesFrom(this.ctx.orgId, association, fromId, EDGES_PER_RECORD_MAX)) {
      if (!e.active || keep.includes(e.toId)) continue;
      const owner = await this.linkOwner(e);
      if (owner?.by !== "crm" || owner.provider !== this.provider) continue;
      await (association === DEAL_CONTACT ? this.removeFromDeal(fromId, e.toId) : this.untarget(fromId, [e.toId]));
    }
    if (CLAIMED.has(association)) {
      const store = this.disagreementStore();
      for (const k of await store.of(this.ctx.orgId, fromId)) {
        if (k.association === association && k.provider === this.provider && k.toId !== null && !keep.includes(k.toId)) await store.remove(this.ctx.orgId, k.id);
      }
    }
    return this.result();
  }

  /** Why a company cannot have this parent, or null. */
  private async parentRefusal(accountId: string, parentId: string | null): Promise<EdgeResult | null> {
    if (!accountId) return { status: "invalid", message: "Name a company" };
    if (parentId === accountId) return { status: "invalid", message: "A company cannot be its own parent" };
    if (parentId && (await this.isAncestor(accountId, parentId))) return { status: "invalid", message: "That company is already below this one" };
    return null;
  }

  private async writeParent(accountId: string, parentId: string | null): Promise<EdgeResult> {
    const parents = this.active(await this.store.edgesFrom(this.ctx.orgId, ACCOUNT_PARENT, accountId, EDGES_PER_RECORD_MAX));
    for (const p of parents) if (p.toId !== parentId) await this.write({ op: "delete", streamId: p.streamId });
    if (parentId && !parents.some((p) => p.toId === parentId)) await this.ensure(ACCOUNT_PARENT, accountId, parentId, false);
    return this.result();
  }

  /**
   * A company's parent now and who decides it: the owner of its active parent link, or with none active, of the one
   * removed last. Null when the company never had a parent.
   */
  private async parentOwner(accountId: string): Promise<{ current: string | null; owner: LinkOwner }> {
    const rows = await this.store.edgesFrom(this.ctx.orgId, ACCOUNT_PARENT, accountId, EDGES_PER_RECORD_MAX);
    const active = rows.find((r) => r.active);
    if (active) return { current: active.toId, owner: await this.linkOwner(active) };
    let latest: { row: EdgeRow; at: number } | null = null;
    for (const r of rows) {
      const life = (await this.store.getHotRow(r.streamId))?.lifecycle;
      const at = life?.status === "deleted" ? life.at : r.createdAt;
      if (!latest || at >= latest.at) latest = { row: r, at };
    }
    return { current: null, owner: latest ? await this.linkOwner(latest.row) : null };
  }

  /** A CRM sets or clears a company's parent (see crm). HubSpot never clears one; a CRM record clears only a link it made itself. */
  private async crmSetParent(accountId: string, parentId: string | null): Promise<EdgeResult> {
    const { current, owner } = await this.parentOwner(accountId);
    const said = this.claim({ association: ACCOUNT_PARENT, fromId: accountId, toId: parentId });
    if (current === parentId) {
      await this.agree(said);
      return unchanged;
    }
    if (owner?.by === "canon") {
      await this.disagree(said);
      return unchanged;
    }
    if (parentId === null && owner?.ref !== this.ctx.source.ref) return unchanged;
    return this.writeParent(accountId, parentId);
  }

  /** `all`: the deal's edges, active or removed, when already read. */
  async setRole(dealId: string, contactId: string, role: DealRole, reason: string | null, all?: EdgeRow[]): Promise<EdgeResult> {
    if (!dealId || !contactId) return { status: "invalid", message: "Name a deal and a person" };
    if (!DEAL_ROLES.includes(role)) return { status: "invalid", message: `Unknown role ${role}` };
    all ??= await this.store.edgesFrom(this.ctx.orgId, DEAL_CONTACT, dealId, EDGES_PER_RECORD_MAX);
    const edges = this.active(all);
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
    const removed = await this.edgeIn(all, DEAL_CONTACT, dealId, contactId);
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
