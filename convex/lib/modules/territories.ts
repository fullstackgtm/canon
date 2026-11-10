/**
 * A module's territory tree read (docs/modules.md, "Territories"): the tree built from an earlier read's docs, each a
 * query line (the grammar ICPs use, convex/lib/icpQuery.ts), in the call's one query (`treeSpecOf`), then counted by the
 * record service as the caller sees companies, in the call's action (`treeValue`): each node's companies, ICP companies,
 * owners, and the pipeline and bookings of the deals at its companies. Pure but for the record client it's handed.
 */
import { marketFilterOfLines, type QueryMarketFilter, type MarketReader } from "../marketSize.ts";
import { accountCriteria, parseQuery } from "../icpQuery.ts";
import type { RecordClient } from "../recordClient";
import type { ReadValue } from "../../../modules/kernel/calls.ts";
import type { TreeRead } from "../../../modules/kernel/manifest.ts";
import type { TerritoryNode, TerritoryTreeBody, TerritoryTreeResult } from "../../../services/record-service/src/territoryTree.ts";

/** The most deals a tree read looks through for its pipeline and bookings. */
export const TREE_DEALS_SCANNED = 8000;

export type TreeSpec = {
  body: TerritoryTreeBody;
  market?: Record<string, QueryMarketFilter>;
  /** Each node's parent, to roll a leaf's deals up the tree. */
  parents: Record<string, string | null>;
  /** Per company: its open pipeline and bookings over the last year, when the read asks for deals. */
  deals: Record<string, { pipeline: number; bookings12m: number }> | null;
  /** Nodes whose query line doesn't read as company criteria: they count nothing, and the value says why. */
  errors: Array<{ key: string; message: string }>;
  /** A company to place (a record page's): which territory it lands in. */
  place?: string;
};
type Doc = { key: string; data: Record<string, unknown> };
const text = (x: unknown) => (typeof x === "string" ? x : "");

/** The tree a `tree` read names, from the docs its earlier reads returned. */
export function treeSpecOf(t: TreeRead, reads: Record<string, ReadValue>, cellNode: string | null, deals: TreeSpec["deals"]): TreeSpec {
  const docs = (Array.isArray(reads[t.nodes]) ? reads[t.nodes] : []) as Doc[];
  const keys = new Set(docs.map((d) => d.key));
  const named = new Map<string, string[]>();
  for (const d of (t.named && Array.isArray(reads[t.named.read]) ? reads[t.named.read] : []) as Doc[]) {
    const node = text(t.named!.node === "key" ? d.key : d.data[t.named!.node]);
    const company = text(d.data[t.named!.company]);
    if (keys.has(node) && company) named.set(node, [...(named.get(node) ?? []), company]);
  }
  const errors: TreeSpec["errors"] = [];
  const parents: Record<string, string | null> = {};
  // Parents before children, as the record service reads the tree: a node whose parent isn't in the read is a root.
  const ordered: Doc[] = [];
  const placed = new Set<string>();
  const parentOf = (d: Doc) => { const p = t.parent ? text(d.data[t.parent]) : ""; return p && keys.has(p) && p !== d.key ? p : null; };
  for (let pass = 0; ordered.length < docs.length && pass <= docs.length; pass++) {
    for (const d of docs) if (!placed.has(d.key) && (parentOf(d) === null || placed.has(parentOf(d)!))) { ordered.push(d); placed.add(d.key); }
  }
  // Territories whose parents lead back to themselves can't be placed: each is named, rather than left out unseen.
  for (const d of docs) if (!placed.has(d.key)) errors.push({ key: d.key, message: "Its parents lead back to it: pick another parent" });
  const lines: Record<string, string[]> = {};
  const market: Record<string, QueryMarketFilter> = {};
  const nodes: TerritoryNode[] = ordered.map((d, i) => {
    const parent = parentOf(d);
    parents[d.key] = parent;
    if (t.market) {
      lines[d.key] = [...(parent ? lines[parent] : []), text(d.data[t.query])];
      market[d.key] = marketFilterOfLines(lines[d.key]);
    }
    const { query, errors: problems } = parseQuery(text(d.data[t.query]), "segment");
    const account = accountCriteria(query.clauses);
    // A territory is companies: AI fields and people (`has(...)`) aren't keys it carves by, and a line naming one would
    // otherwise count wider than it says, so it counts nothing and says why.
    const fields = query.clauses.filter((c) => c.key === "field").length + query.has.length;
    if (problems.length || fields) errors.push({ key: d.key, message: problems[0] ?? "A territory's line takes company keys only (industry, size, country, region, city, owner, revenue)" });
    const { custom: _custom, ...criteria } = account;
    const order = t.order ? Number(d.data[t.order]) : i;
    return { id: d.key, ...(parent ? { parent } : {}), order: Number.isFinite(order) ? order : i, account: problems.length || fields ? { countries: ["__nowhere__"] } : criteria, ...(named.get(d.key) ? { named: named.get(d.key) } : {}) };
  });
  return {
    body: { nodes, ...(t.owners ? { owners: true } : {}), ...(t.cells && cellNode && keys.has(cellNode) ? { cells: { node: cellNode, by: [...t.cells.by] } } : {}) },
    parents, deals, errors, ...(t.market ? { market } : {}),
  };
}

/** A tree read's value: the record service's counts, with each node's deals rolled up from its leaves. */
export async function treeValue(client: RecordClient, orgId: string, spec: TreeSpec, readMarket?: MarketReader): Promise<ReadValue> {
  if (!spec.body.nodes.length) return { nodes: [], overlaps: [], uncovered: 0, errors: spec.errors } as unknown as ReadValue;
  // A deal's company is a register id, or `domain:<d>` for one known only by its CRM account's domain.
  const keys = spec.deals ? Object.keys(spec.deals) : [];
  const ids = [...new Set([...keys.filter((k) => !k.startsWith("domain:")), ...(spec.place ? [spec.place] : [])])];
  const domains = keys.filter((k) => k.startsWith("domain:")).map((k) => k.slice(7));
  const counted: TerritoryTreeResult = await client.territoryTreeCounts(orgId, { ...spec.body, ...(ids.length ? { assign: ids } : {}), ...(domains.length ? { assignDomains: domains } : {}) });
  const sums = new Map<string, { pipeline: number; bookings12m: number }>();
  const placed = [...Object.entries(counted.assigned ?? {}), ...Object.entries(counted.assignedDomains ?? {}).map(([d, leaf]) => [`domain:${d}`, leaf] as const)];
  for (const [company, leaf] of placed) {
    if (!spec.deals?.[company]) continue;
    for (let n: string | null = leaf; n; n = spec.parents[n] ?? null) {
      const s = sums.get(n) ?? { pipeline: 0, bookings12m: 0 };
      s.pipeline += spec.deals![company].pipeline; s.bookings12m += spec.deals![company].bookings12m;
      sums.set(n, s);
    }
  }
  const markets = new Map<string, number | null>();
  if (spec.market) for (const [key, filter] of Object.entries(spec.market)) markets.set(key, (await readMarket?.(filter, "region"))?.total ?? null);
  return {
    nodes: counted.nodes.map((n) => ({ key: n.id, accounts: n.accounts, icp: n.icp, ...(spec.market ? { market: markets.get(n.id) ?? null } : {}), ...(n.owners ? { owners: n.owners } : {}), ...(spec.deals ? sums.get(n.id) ?? { pipeline: 0, bookings12m: 0 } : {}) })),
    ...(spec.place ? { placed: { company: spec.place, node: counted.assigned?.[spec.place] ?? null, named: spec.body.nodes.some((n) => n.named?.includes(spec.place!)) } } : {}),
    overlaps: counted.overlaps, uncovered: counted.uncovered, ...(counted.cells ? { cells: counted.cells, pinnedToCellNode: counted.pinnedToCellNode ?? 0 } : {}), errors: spec.errors,
  } as unknown as ReadValue;
}
