/**
 * Writes a module proposes to Canon's own records (docs/modules.md, "Writes to Canon records"): a registry Canon owns of
 * the operations a manifest may list in `proposes`, each one's arguments, and how Canon judges each record when the
 * plan applies. A call never writes a Canon record itself. It returns a `propose` intent; Canon expands it into one
 * row per record it would change, as the person who ran the call reads them, and holds the rows as a patch plan that a
 * person approves on the Patch plans page. Pure, with no Node-only imports.
 */
import { factsProposeArgsProblem, type FactRejection } from "./facts.ts";

/** The patch plan operation every module's record proposal is held under. */
export const MODULE_RECORDS = "module.records";

/** The operations a module may propose, by name, with what each one's `args` hold and what an install screen says. */
export const PROPOSAL_OPERATIONS = {
  /**
   * Move every company `from` owns, as the person who proposes reads them, to `to`: a member leaving hands their
   * book to their manager. Canon lists the companies when it proposes, so the plan names each one.
   */
  "accounts.reassign": { label: "Move companies from one owner to another", object: "account", field: "ownerId" },
  /**
   * Give each company the owner of its territory (docs/modules.md, "Territories"): the territories as query lines,
   * each with an owner or none, and companies named to them. A company goes to the owner of the nearest territory on
   * its path that has one; `scope: "unowned"` moves only companies with no owner. Canon lists every company that moves,
   * or the first `limit` of them. An admin may let it run without asking for companies that have no owner (`grantable`).
   */
  "accounts.assignTerritories": { label: "Move companies to their territories' owners", object: "account", field: "ownerId", grantable: "Give companies with no owner their territory's owner" },
  /**
   * Set a fiscal year's company target on Canon's Targets (Reports pacing reads it), as Canon's own Targets editor
   * saves one: the total, and optionally how it spreads over the 12 months. The plan's other choices are kept.
   */
  "targets.set": { label: "Set the company target for a fiscal year", object: "targetPlan", field: "total" },
  "meetings.log": { label: "Log a meeting on a deal", object: "meeting", field: "create" },
  /**
   * Propose facts to Canon's fact ledger, each with its evidence (docs/modules.md, "Proposing facts"): they wait on the
   * fact review queue for a member with `facts.review`, never accepted by a rule or a grant. Granted by the manifest's
   * `facts.<object>.propose`, not `proposes`.
   */
  "facts.propose": { label: "Propose facts, each for a person to review", object: "fact", field: "value", stability: "preview", since: "2026-11-09" },
} as const satisfies Record<string, ProposalOperationDecl>;
/**
 * A proposal operation's declaration. `stability` "preview" marks one whose arguments and outcome may still change
 * before it is stable (docs/modules.md, "Preview reads"), with the date it shipped in `since`; one without is stable.
 */
type ProposalOperationDecl = { label: string; object: string; field: string; grantable?: string; stability?: "stable" | "preview"; since?: string };
export type ProposalOperation = keyof typeof PROPOSAL_OPERATIONS;
/** The operation a module proposes facts with. */
export const FACTS_PROPOSE = "facts.propose";

/**
 * What an admin's standing grant lets an operation do without asking (docs/modules.md, "Standing grants"), or null when
 * every proposal of it waits for a person. A grant only fills an empty field: changing an owner someone holds is never
 * grantable (docs/org-agents.md).
 */
export function grantableLabel(operation: string): string | null {
  const spec = (PROPOSAL_OPERATIONS as Record<string, { grantable?: string }>)[operation];
  return spec?.grantable ?? null;
}

/** Whether a standing grant covers every row of a proposal: a grantable operation that fills only empty fields. */
export const grantFits = (operation: string, rows: readonly ProposalRow[]) => grantableLabel(operation) !== null && rows.length > 0 && rows.every((r) => (r.kind === undefined || r.kind === "set") && !("meeting" in r) && r.before === null && r.field === "ownerId" && typeof r.after === "string" && Number.isFinite(r.version));
/** The operations a manifest lists in `proposes`: every one but `facts.propose`, which `facts.<object>.propose` grants. */
export const PROPOSAL_OPERATION_NAMES = (Object.keys(PROPOSAL_OPERATIONS) as ProposalOperation[]).filter((o) => o !== FACTS_PROPOSE);

/** The most records one proposal names. A plan past it is refused whole: split the work into smaller proposals. */
export const MAX_PROPOSAL_ROWS = 1000;

/** `accounts.reassign`'s arguments: members' ids. */
export type ReassignArgs = { from: string; to: string };
/** `accounts.assignTerritories`'s arguments: the tree, its owners, the companies named to it, and the scope. */
export type AssignTerritoriesArgs = {
  territories: Array<{ key: string; parent?: string; order?: number; query: string; owner?: string }>;
  named?: Array<{ territory: string; company: string }>;
  scope: "all" | "unowned";
  /** Propose only the first this many moves, and leave the rest for a later proposal, rather than refuse past the cap. */
  limit?: number;
};
const MAX_TREE = 200;
/** `targets.set`'s arguments: the fiscal year, its total in minor units, and 12 month weights when not even. */
export type TargetsSetArgs = { year: number; total: number; months?: number[] };
/** A module deals._id and the meeting values a person confirms. Times are epoch milliseconds. */
export type MeetingLogArgs = { deal: string; title: string; startAt: number; endAt?: number; ownerId: string; notes?: string; location?: string };

/** Why `args` aren't `operation`'s arguments, or null. */
export function proposalArgsProblem(operation: string, args: unknown): string | null {
  if (!Object.hasOwn(PROPOSAL_OPERATIONS, operation)) return `${operation} is not an operation a module proposes (${PROPOSAL_OPERATION_NAMES.join(", ")})`;
  if (typeof args !== "object" || args === null || Array.isArray(args)) return `${operation} takes its arguments as an object`;
  const a = args as Record<string, unknown>;
  if (operation === FACTS_PROPOSE) return factsProposeArgsProblem(a);
  if (operation === "meetings.log") {
    const extra = Object.keys(a).filter((k) => !["deal", "title", "startAt", "endAt", "ownerId", "notes", "location"].includes(k));
    if (extra.length) return `${operation} takes no ${extra.join(", ")}`;
    if (typeof a.deal !== "string" || !a.deal || typeof a.ownerId !== "string" || !a.ownerId) return `${operation} needs a deal and an ownerId`;
    if (typeof a.title !== "string" || !a.title.trim() || a.title.length > 1000) return `${operation} needs a title of 1 to 1000 characters`;
    const instant = (v: unknown) => typeof v === "number" && Number.isInteger(v) && new Date(v).getUTCFullYear() >= 1 && new Date(v).getUTCFullYear() <= 9999;
    if (!instant(a.startAt) || (a.endAt !== undefined && (!instant(a.endAt) || (a.endAt as number) < (a.startAt as number)))) return `${operation} needs valid epoch millisecond times, with endAt at or after startAt`;
    for (const field of ["notes", "location"]) if (a[field] !== undefined && (typeof a[field] !== "string" || (a[field] as string).length > 4000)) return `${operation}'s ${field} is text of at most 4000 characters`;
    return null;
  }
  if (operation === "targets.set") {
    const extra = Object.keys(a).filter((k) => !["year", "total", "months"].includes(k));
    if (extra.length) return `${operation} takes no ${extra.join(", ")}`;
    if (!Number.isInteger(a.year) || (a.year as number) < 2000 || (a.year as number) > 2100) return `${operation} needs year, a fiscal year from 2000 to 2100`;
    if (typeof a.total !== "number" || !Number.isFinite(a.total) || a.total < 0) return `${operation} needs total, an amount of at least 0`;
    if (a.months !== undefined && (!Array.isArray(a.months) || a.months.length !== 12 || !a.months.every((x) => typeof x === "number" && Number.isFinite(x) && x >= 0)))
      return `${operation}'s months are 12 weights of at least 0`;
    return null;
  }
  if (operation === "accounts.assignTerritories") {
    const extra = Object.keys(a).filter((k) => !["territories", "named", "scope", "limit"].includes(k));
    if (extra.length) return `${operation} takes no ${extra.join(", ")}`;
    if (a.scope !== "all" && a.scope !== "unowned") return `${operation} needs scope, all or unowned`;
    if (a.limit !== undefined && (!Number.isInteger(a.limit) || (a.limit as number) < 1 || (a.limit as number) > MAX_PROPOSAL_ROWS)) return `${operation}'s limit is 1 to ${MAX_PROPOSAL_ROWS} companies`;
    const t = a.territories;
    if (!Array.isArray(t) || !t.length || t.length > MAX_TREE) return `${operation} needs 1 to ${MAX_TREE} territories`;
    const str = (x: unknown) => typeof x === "string" && x.length > 0 && x.length <= 2000;
    if (!t.every((x) => x && typeof x === "object" && str(x.key) && typeof x.query === "string" && (x.parent === undefined || str(x.parent)) && (x.owner === undefined || str(x.owner)) && (x.order === undefined || typeof x.order === "number")))
      return `${operation}'s territories are { key, parent?, order?, query, owner? }`;
    if (!t.some((x) => x.owner)) return `${operation} needs at least one territory with an owner`;
    const n = a.named;
    if (n !== undefined && (!Array.isArray(n) || n.length > 2000 || !n.every((x) => x && typeof x === "object" && str(x.territory) && str(x.company))))
      return `${operation}'s named companies are { territory, company }`;
    return null;
  }
  const extra = Object.keys(a).filter((k) => k !== "from" && k !== "to");
  if (extra.length) return `${operation} takes no ${extra.join(", ")}`;
  if (typeof a.from !== "string" || !a.from || typeof a.to !== "string" || !a.to) return `${operation} needs from and to, each a member's id`;
  if (a.from === a.to) return `${operation} moves companies to someone else: from and to are the same member`;
  return null;
}

/**
 * One record a proposal would change, as Canon read it when it proposed: its id and name, the field's value then, and
 * the record's version (its `updatedAt` then). Apply writes `after` only while the record still holds that version.
 */
export type ProposalSetRow = { kind?: "set"; id: string; name: string; field: string; before: string | null; after: string; version: number };
export type MeetingCreateRow = { kind: "meeting.create"; id: string; name: string; meeting: MeetingLogArgs; dealStreamId: string };
export type ProposalRow = ProposalSetRow | MeetingCreateRow;

/** What applying one row found. */
export type RowOutcome = { status: "write" } | { status: "conflict"; why: string };

/**
 * Judge one row at apply against the record as it is now (null: gone, or the person applying can't read it). A record
 * changed since the proposal read it is skipped and named, never overwritten.
 */
export function judgeRow(row: ProposalSetRow, now: { version: number; value: string | null } | null): RowOutcome {
  if (!now) return { status: "conflict", why: "gone, or not one you can see" };
  if (now.value === row.after) return { status: "conflict", why: "already set" };
  if (now.version !== row.version || now.value !== row.before) return { status: "conflict", why: "changed since it was proposed" };
  return { status: "write" };
}

/**
 * A proposal's outcome as a module reads it (`proposals.byIds`): its plan's status, and its rows counted by what
 * happened to them, the skipped ones named (at most `MAX_SKIPPED_NAMED`).
 */
export type ProposalOutcome = {
  id: string; operation: string; status: string; reason: string | null; createdAt: number; decidedAt: number | null;
  total: number; applied: number; skipped: number; failed: number; pending: number;
  skippedRows: Array<{ id: string; name: string; why: string }>;
  created: Array<{ operation: "meetings.log"; object: "meeting"; streamId: string }>;
  /**
   * A `facts.propose`'s facts the ledger didn't store, by their index in the proposal, and those it already held with
   * the same value and evidence. Always empty and 0 for other operations.
   */
  rejected: Array<{ index: number; reason: FactRejection }>;
  unchanged: number;
};
export const MAX_SKIPPED_NAMED = 100;

/** "3 companies: 2 from Ava to Ben, 1 from Ava to Cal": every row counted by its move, never cut short. */
export function moveSummary(rows: readonly ProposalSetRow[], nameOf: (id: string | null) => string, noun = ["company", "companies"]): string {
  const moves = new Map<string, number>();
  for (const r of rows) moves.set(`${nameOf(r.before)} to ${nameOf(r.after)}`, (moves.get(`${nameOf(r.before)} to ${nameOf(r.after)}`) ?? 0) + 1);
  const parts = [...moves.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([m, n]) => `${n} from ${m}`);
  return `${rows.length} ${rows.length === 1 ? noun[0] : noun[1]}${parts.length ? `: ${parts.join(", ")}` : ""}`;
}
