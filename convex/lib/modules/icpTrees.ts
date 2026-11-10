import type { IcpTreeRead, ModuleManifest } from "../../../modules/kernel/manifest.ts";
import type { IcpTreeReadValue, ReadDoc, ReadValue } from "../../../modules/kernel/calls.ts";
import { ICP_TREE_FIELDS } from "../../../modules/kernel/icpTree.ts";
import { valueProblems } from "../../../modules/kernel/schema.ts";
import { formatQuery, parseQuery, specToQuery } from "../../../modules/kernel/icpQuery.ts";
import { accountCriteria, personCriteria } from "../icpCriteria.ts";
import type { Clause, IcpQuery } from "../../../modules/kernel/icpQuery.ts";
import { specGate } from "../icps.ts";
import type { IcpSpec } from "../../../modules/kernel/icpSpec.ts";
import type { IcpTreeCountsRequest, IcpTreeCounts } from "../recordContract.ts";
import type { FitModel } from "../../../recipes/models.ts";
import { icpMarketFilter } from "../icpGap.ts";
import type { MarketReader, QueryMarketFilter } from "../marketSize.ts";

export type IcpTreeSpec = {
  orgId: string;
  userId: string;
  granted: boolean;
  request: IcpTreeCountsRequest;
  market?: Record<string, QueryMarketFilter>;
};
type Definition = ReadDoc & { data: { spec: IcpSpec; query: string; active: boolean } };
type Node = ReadDoc & { data: { icp: string; parent?: string; kind: "segment" | "persona"; query: string } };

function querySignature(query: IcpQuery): string {
  const clauses = (items: Clause[]) => items.map((c) => formatQuery({
    clauses: [c.values ? { ...c, values: [...c.values].sort() } : c], has: [],
  })).sort();
  return JSON.stringify([clauses(query.clauses), query.has.map((h) => [h.neg, clauses(h.clauses)])]);
}

/** Compile the caller's own-doc reads. Invalid branches refuse the whole read rather than silently widening it. */
export function icpTreeRequest(t: IcpTreeRead, reads: Record<string, ReadValue>, fit: FitModel): IcpTreeCountsRequest {
  const docs = (part: "icps" | "nodes"): ReadDoc[] => {
    const rows = reads[t[part]];
    if (!Array.isArray(rows)) throw new Error(`${part} needs an own-doc list read`);
    const schema = ICP_TREE_FIELDS[part];
    for (const row of rows) {
      if (!("key" in row) || !("data" in row) || !row.data || typeof row.data !== "object") throw new Error(`${part} needs module docs`);
      const data = row.data as Record<string, unknown>;
      const selected = Object.fromEntries(Object.keys(schema.value).filter((k) => data[k] !== undefined).map((k) => [k, data[k]]));
      const errors = valueProblems(selected, schema, String(row.key), () => false);
      if (errors.length) throw new Error(errors.join("; "));
    }
    return rows as ReadDoc[];
  };
  const icps = docs("icps") as Definition[];
  const nodes = docs("nodes") as Node[];
  if (icps.length > 25 || nodes.length > 75) throw new Error("An ICP tree holds at most 25 ICPs and 75 segments and personas");
  const all = [...icps, ...nodes];
  if (all.some((d) => !d.key)) throw new Error("An ICP tree doc needs a nonempty key");
  if (new Set(all.map((d) => d.key)).size !== all.length) throw new Error("ICP tree keys must be unique across definitions and nodes");
  const roots = new Set(icps.map((d) => d.key));
  const byKey = new Map(nodes.map((d) => [d.key, d]));
  const request: IcpTreeCountsRequest = { nodes: [] };
  for (const d of icps) {
    const parsed = parseQuery(d.data.query, "icp");
    const canonical = parseQuery(specToQuery(d.data.spec), "icp");
    if (parsed.errors.length || canonical.errors.length) throw new Error(`${d.key}: ${[...parsed.errors, ...canonical.errors].join("; ")}`);
    if (querySignature(parsed.query) !== querySignature(canonical.query)) throw new Error(`${d.key}: its query and spec disagree`);
    const gate = specGate(d.key, d.data.spec, fit);
    request.nodes.push({ id: d.key, account: {
      industries: Object.keys(gate.industries), countries: Object.keys(gate.countries), employees: gate.employees.map(({ min, max }) => ({ min, max })),
      excludeIndustries: gate.excludeIndustries, excludeCountries: gate.excludeCountries, custom: gate.custom,
    }, ...(gate.buyer ? { has: [{ person: gate.buyer }] } : {}) });
  }
  const placed = new Set(roots);
  const visit = (d: Node, path: Set<string>): void => {
    if (placed.has(d.key)) return;
    if (path.has(d.key)) throw new Error(`${d.key}: its parents form a cycle`);
    if (!roots.has(d.data.icp)) throw new Error(`${d.key}: its ICP is missing from the read`);
    if (d.data.parent === "") throw new Error(`${d.key}: its parent key is empty`);
    const parent = d.data.parent ?? d.data.icp;
    const p = byKey.get(parent);
    if (d.data.parent && (!p || p.data.icp !== d.data.icp || p.data.kind === "persona")) throw new Error(`${d.key}: its parent must be a segment of the same ICP`);
    if (path.size >= 4) throw new Error(`${d.key}: segments go at most 4 deep`);
    if (p) visit(p, new Set([...path, d.key]));
    // Count depth independently of traversal order, including parents already placed by an earlier sibling.
    let depth = 1;
    for (let ancestor = p; ancestor; ancestor = ancestor.data.parent ? byKey.get(ancestor.data.parent) : undefined) if (++depth > 4) throw new Error(`${d.key}: segments go at most 4 deep`);
    const { query, errors } = parseQuery(d.data.query, d.data.kind);
    if (errors.length) throw new Error(`${d.key}: ${errors.join("; ")}`);
    request.nodes.push(d.data.kind === "persona"
      ? { id: d.key, parent, person: personCriteria(query.clauses) }
      : { id: d.key, parent, account: accountCriteria(query.clauses), has: query.has.map((h) => ({ ...(h.neg ? { neg: true } : {}), person: personCriteria(h.clauses) })) });
    placed.add(d.key);
  };
  for (const d of nodes) visit(d, new Set());
  return request;
}

/** Freeze only the market dimensions core uses, from the same validated own-doc definitions as the counts. */
export function icpTreeMarkets(t: IcpTreeRead, reads: Record<string, ReadValue>): Record<string, QueryMarketFilter> | undefined {
  return t.market ? Object.fromEntries((reads[t.icps] as Definition[]).map((d) => [d.key, icpMarketFilter(d.data.spec)])) : undefined;
}

export const icpTreeGranted = (reads: ModuleManifest["reads"], market = false): boolean => !!reads?.companies && !!reads.people?.includes("title") && (!market || !!reads.market?.includes("facets"));

/** Called only after scoped counting succeeds, so unavailable criteria never yield a partial market/count result. */
export async function icpTreeValue(result: IcpTreeCounts, spec: IcpTreeSpec, readMarket: MarketReader): Promise<IcpTreeReadValue> {
  const market = new Map<string, number | null>();
  for (const [key, filter] of Object.entries(spec.market ?? {})) market.set(key, (await readMarket(filter, "sizeBand"))?.total ?? null);
  return {
    nodes: result.nodes.map(({ id, ...counts }) => ({ key: id, ...counts, ...(market.has(id) ? { market: market.get(id)! } : {}) })),
    overlaps: result.overlaps,
  };
}
