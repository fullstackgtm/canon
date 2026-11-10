// Territory trees (contract 1.37.0, docs/modules.md "Territories"): a tree of query lines over the workspace's accounts,
// counted as a sales plan carves them. Unlike an ICP tree (icpTree.ts), siblings don't overlap in the answer: an account
// belongs to the first sibling (by `order`) whose criteria it passes, and an account named to a node belongs there
// whatever the rules say. Pure, over rows already read: the service reads them in one query (app.ts) and Convex's fake
// record client passes its own, so both count the same way.
import { sameIndustry } from "./core/kernel/industries.ts";
import { NONE, regionOf, sizeBandOf } from "./core/kernel/dimensions.ts";

/**
 * Company criteria, as an ICP tree node's (contract.ts IcpAccount): each include set must hold the value. 1.40.0: cities
 * (lowercase), owners (member ids, NONE for no owner, either way round with `excludeOwners`) and annual revenue ranges
 * in cents.
 */
export type TerritoryCriteria = {
  industries?: string[]; countries?: string[]; employees?: Array<{ min: number; max: number }>;
  excludeIndustries?: string[]; excludeCountries?: string[];
  cities?: string[]; owners?: string[]; excludeOwners?: string[]; revenue?: Array<{ min: number; max: number }>;
};
/** One node: its parent (named before it), its place among its siblings, its rules and the accounts named to it. */
export type TerritoryNode = { id: string; parent?: string; order?: number; account?: TerritoryCriteria; named?: string[] };
export type CellDimension = "country" | "region" | "sizeBand" | "industry";
export type TerritoryTreeBody = {
  nodes: TerritoryNode[];
  /** Each node's accounts by owner (a plan's moves: who holds what each territory would take). */
  owners?: boolean;
  /** Account ids to place: the leaf each one lands in, or null (a deal's company, for pipeline by territory). */
  assign?: string[];
  /** Domains to place, for a deal whose company is known only by its CRM account's domain: the leaf, or null. */
  assignDomains?: string[];
  /** The accounts of one node grouped by up to two dimensions, each cell with its owners: what a carve partitions. */
  cells?: { node: string; by: CellDimension[] };
  /**
   * The owner moves the tree implies (contract 1.39.0): each company goes to the owner of the nearest node on its path
   * that has one (`owners`, node to member), and a company whose owner would change is a move. `scope: "unowned"`
   * moves only companies with no owner. At most `limit` moves are listed; `movesTotal` and `moveSummary` count them all.
   */
  moves?: { owners: Record<string, string>; scope: "all" | "unowned"; limit: number };
};
export type OwnerCount = { ownerId: string | null; accounts: number };
export type TerritoryTreeResult = {
  nodes: Array<{ id: string; accounts: number; icp: number; owners?: OwnerCount[] }>;
  /** Accounts two siblings' rules both admit, before precedence gives each to the first: a carve to tidy. */
  overlaps: Array<{ a: string; b: string; accounts: number }>;
  /** Accounts in no top-level territory. */
  uncovered: number;
  assigned?: Record<string, string | null>;
  assignedDomains?: Record<string, string | null>;
  cells?: Array<{ key: Partial<Record<CellDimension, string>>; accounts: number; owners: OwnerCount[] }>;
  /** Companies named to the cells' node itself: they stay there whatever its children say, so no cell holds them. */
  pinnedToCellNode?: number;
  moves?: Array<{ id: string; name: string; from: string | null; to: string; node: string; version: number }>;
  movesTotal?: number;
  moveSummary?: Array<{ from: string | null; to: string; accounts: number }>;
};
export type TerritoryAccountRow = { id: string; name?: string | null; updatedAt?: number | null; domain?: string | null; industry?: string | null; country?: string | null; employees?: number | null; ownerId?: string | null; icpIds?: readonly string[] | null; city?: string | null; annualRevenue?: number | null };

export const MAX_TERRITORY_NODES = 200;
export const MAX_NAMED = 2000;
export const MAX_ASSIGN = 5000;
export const MAX_MOVES_LISTED = 5000;

/** Whether a company passes company criteria: territories here, and Convex's fake record client for ICP trees and lists. */
export function passes(row: TerritoryAccountRow, x: TerritoryCriteria): boolean {
  const country = (row.country ?? "").toLowerCase();
  const city = (row.city ?? "").trim().toLowerCase();
  const owner = row.ownerId || NONE;
  if (x.cities?.length && !(city && x.cities.includes(city))) return false;
  if (x.owners?.length && !x.owners.includes(owner)) return false;
  if (x.excludeOwners?.includes(owner)) return false;
  if (x.revenue?.length && !x.revenue.some((b) => row.annualRevenue != null && row.annualRevenue >= b.min && row.annualRevenue <= b.max)) return false;
  if (x.industries?.length && !x.industries.some((i) => sameIndustry(i, row.industry ?? undefined))) return false;
  if (x.countries?.length && !(country && x.countries.some((c) => c.toLowerCase() === country))) return false;
  if (x.employees?.length && !x.employees.some((b) => row.employees != null && row.employees >= b.min && row.employees <= b.max)) return false;
  if (x.excludeIndustries?.some((i) => sameIndustry(i, row.industry ?? undefined))) return false;
  if (x.excludeCountries?.some((c) => country && c.toLowerCase() === country)) return false;
  return true;
}

const dimension = (row: TerritoryAccountRow, d: CellDimension): string =>
  d === "country" ? (row.country ? row.country.toLowerCase() : NONE)
    : d === "region" ? regionOf(row.country)
      : d === "sizeBand" ? sizeBandOf(row.employees)
        : row.industry ? row.industry.toLowerCase() : NONE;

function ownersOf(rows: Iterable<TerritoryAccountRow>): OwnerCount[] {
  const by = new Map<string | null, number>();
  for (const r of rows) by.set(r.ownerId || null, (by.get(r.ownerId || null) ?? 0) + 1);
  return [...by.entries()].map(([ownerId, accounts]) => ({ ownerId, accounts })).sort((a, b) => b.accounts - a.accounts || String(a.ownerId).localeCompare(String(b.ownerId)));
}

/** Why `body` isn't a tree to count, or null. */
export function territoryTreeProblem(body: TerritoryTreeBody): string | null {
  if (!body.nodes.length || body.nodes.length > MAX_TERRITORY_NODES) return `a tree has 1 to ${MAX_TERRITORY_NODES} nodes`;
  const seen = new Set<string>();
  let named = 0;
  for (const n of body.nodes) {
    if (seen.has(n.id)) return `node ${n.id} appears twice`;
    if (n.parent !== undefined && !seen.has(n.parent)) return `node ${n.id} names parent ${n.parent} before it`;
    seen.add(n.id);
    named += n.named?.length ?? 0;
  }
  if (named > MAX_NAMED) return `a tree names at most ${MAX_NAMED} accounts`;
  if ((body.assign?.length ?? 0) + (body.assignDomains?.length ?? 0) > MAX_ASSIGN) return `assign takes at most ${MAX_ASSIGN} accounts`;
  if (body.cells && !seen.has(body.cells.node)) return `cells names ${body.cells.node}, which isn't a node`;
  if (body.moves && Object.keys(body.moves.owners).some((id) => !seen.has(id))) return "moves names an owner for a node that isn't in the tree";
  if (body.moves && (body.moves.limit < 1 || body.moves.limit > MAX_MOVES_LISTED)) return `moves lists 1 to ${MAX_MOVES_LISTED}`;
  if (body.cells && (!body.cells.by.length || body.cells.by.length > 2)) return "cells groups by one or two dimensions";
  return null;
}

/**
 * Count a territory tree over `rows`. Each account walks down from the top: at each level it goes to the first child (by
 * `order`, then as listed) whose rules it passes, and stops where none does. An account named to a node goes there
 * instead, with every node above it. A node counts the accounts under it.
 */
export function countTerritoryTree(rows: readonly TerritoryAccountRow[], body: TerritoryTreeBody): TerritoryTreeResult {
  const nodes = body.nodes;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map<string | undefined, TerritoryNode[]>();
  nodes.forEach((n, i) => children.set(n.parent, [...(children.get(n.parent) ?? []), { ...n, order: n.order ?? i }]));
  for (const list of children.values()) list.sort((a, b) => a.order! - b.order!);
  const pinned = new Map<string, string>();
  for (const n of nodes) for (const id of n.named ?? []) if (!pinned.has(id)) pinned.set(id, n.id);
  const ancestry = (id: string): string[] => { const out: string[] = []; for (let n = byId.get(id); n; n = n.parent !== undefined ? byId.get(n.parent) : undefined) out.unshift(n.id); return out; };

  // Each account's path from the top, by its rules or its pin.
  const path = (row: TerritoryAccountRow): string[] => {
    const pin = pinned.get(row.id);
    if (pin) return ancestry(pin);
    const out: string[] = [];
    let level = children.get(undefined) ?? [];
    for (;;) {
      const hit = level.find((n) => passes(row, n.account ?? {}));
      if (!hit) return out;
      out.push(hit.id);
      level = children.get(hit.id) ?? [];
    }
  };
  const members = new Map<string, TerritoryAccountRow[]>(nodes.map((n) => [n.id, []]));
  const paths = new Map<string, string[]>();
  const leafOf = new Map<string, string | null>();
  const leafOfDomain = new Map<string, string | null>();
  let uncovered = 0;
  for (const row of rows) {
    const p = path(row);
    paths.set(row.id, p);
    if (!p.length) uncovered++;
    for (const id of p) members.get(id)!.push(row);
    leafOf.set(row.id, p.length ? p[p.length - 1] : null);
    if (row.domain) leafOfDomain.set(row.domain.toLowerCase(), p.length ? p[p.length - 1] : null);
  }

  // Overlap among siblings by their rules alone, within what their parent holds.
  const overlaps: TerritoryTreeResult["overlaps"] = [];
  for (const [parent, list] of children) {
    const pool = parent === undefined ? rows : members.get(parent)!;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      overlaps.push({ a: a.id, b: b.id, accounts: pool.filter((r) => passes(r, a.account ?? {}) && passes(r, b.account ?? {})).length });
    }
  }
  const result: TerritoryTreeResult = {
    nodes: nodes.map((n) => {
      const m = members.get(n.id)!;
      return { id: n.id, accounts: m.length, icp: m.filter((r) => (r.icpIds?.length ?? 0) > 0).length, ...(body.owners ? { owners: ownersOf(m) } : {}) };
    }),
    overlaps, uncovered,
  };
  if (body.assign) result.assigned = Object.fromEntries(body.assign.map((id) => [id, leafOf.get(id) ?? null]));
  if (body.assignDomains) result.assignedDomains = Object.fromEntries(body.assignDomains.map((d) => [d, leafOfDomain.get(d.toLowerCase()) ?? null]));
  if (body.moves) {
    const { owners, scope, limit } = body.moves;
    const all: NonNullable<TerritoryTreeResult["moves"]> = [];
    for (const row of rows) {
      const p = paths.get(row.id) ?? [];
      const node = [...p].reverse().find((id) => owners[id]);
      if (!node) continue;
      const from = row.ownerId || null, to = owners[node];
      if (from === to || (scope === "unowned" && from)) continue;
      all.push({ id: row.id, name: row.name ?? row.id, from, to, node, version: Number(row.updatedAt ?? 0) });
    }
    all.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const summary = new Map<string, { from: string | null; to: string; accounts: number }>();
    for (const m of all) { const k = `${m.from}>${m.to}`; summary.set(k, { from: m.from, to: m.to, accounts: (summary.get(k)?.accounts ?? 0) + 1 }); }
    result.moves = all.slice(0, limit);
    result.movesTotal = all.length;
    result.moveSummary = [...summary.values()].sort((a, b) => b.accounts - a.accounts || `${a.from}${a.to}`.localeCompare(`${b.from}${b.to}`));
  }
  if (body.cells) {
    const cells = new Map<string, TerritoryAccountRow[]>();
    // A company named to the node stays at it (it never walks into a child), so a carve can't move it: no cell holds it.
    const here = members.get(body.cells.node)!.filter((r) => pinned.get(r.id) === body.cells!.node);
    result.pinnedToCellNode = here.length;
    for (const r of members.get(body.cells.node)!) {
      if (pinned.get(r.id) === body.cells.node) continue;
      const key = JSON.stringify(body.cells.by.map((d) => dimension(r, d)));
      cells.set(key, [...(cells.get(key) ?? []), r]);
    }
    result.cells = [...cells.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, rs]) => ({
      key: Object.fromEntries(body.cells!.by.map((d, i) => [d, (JSON.parse(k) as string[])[i]])), accounts: rs.length, owners: ownersOf(rs),
    }));
  }
  return result;
}
