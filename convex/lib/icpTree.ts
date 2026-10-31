/** An ICP tree as the record service's counts request (contract 1.31.0). Pure and Node-free. */
import type { IcpSpec } from "./icpSpec.ts";
import { specGate } from "./icps.ts";
import { accountCriteria, parseQuery, personCriteria } from "./icpQuery.ts";
import type { IcpTreeNode } from "./recordContract.ts";
import type { FitModel } from "../../recipes/models.ts";

export type TreeRows = { fit: FitModel; icps: Array<{ id: string; spec: IcpSpec }>; nodes: Array<{ id: string; icpId: string; parentId?: string; kind: "segment" | "persona"; query: string }> };

/**
 * The counts request for a workspace's trees: each ICP as its gate counts it (its company criteria and its buyer),
 * then its segments and personas, every node after its parent. A node whose stored query no longer parses (a
 * vocabulary changed under it) is left out, with what sits under it.
 */
export function treeRequest(rows: TreeRows): IcpTreeNode[] {
  const out: IcpTreeNode[] = [];
  const placed = new Set<string>();
  for (const icp of rows.icps) {
    const g = specGate(icp.id, icp.spec, rows.fit);
    out.push({
      id: icp.id,
      account: {
        industries: Object.keys(g.industries), countries: Object.keys(g.countries), employees: g.employees.map(({ min, max }) => ({ min, max })),
        excludeIndustries: g.excludeIndustries, excludeCountries: g.excludeCountries, custom: g.custom,
      },
      ...(g.buyer ? { has: [{ person: g.buyer }] } : {}),
    });
    placed.add(icp.id);
  }
  for (let grew = true; grew;) {
    grew = false;
    for (const n of rows.nodes) {
      const parent = n.parentId ?? n.icpId;
      if (placed.has(n.id) || !placed.has(parent)) continue;
      const { query: q, errors } = parseQuery(n.query, n.kind);
      if (errors.length) continue;
      placed.add(n.id);
      grew = true;
      out.push(n.kind === "persona"
        ? { id: n.id, parent, person: personCriteria(q.clauses) }
        : { id: n.id, parent, account: accountCriteria(q.clauses), has: q.has.map((h) => ({ ...(h.neg ? { neg: true } : {}), person: personCriteria(h.clauses) })) });
    }
  }
  return out;
}

