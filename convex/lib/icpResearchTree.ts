import { formatQuery, parseQuery, specToQuery, type NodeKind } from "./icpQuery.ts";
import type { IcpSpec } from "./icpSpec.ts";

export type ResearchTreeNode = { kind: Exclude<NodeKind, "icp">; name: string; query: string; parent?: number };

/** Keep the root gate intact. Its company target and buyer become editable descendants. */
export function researchTree(spec: IcpSpec): ResearchTreeNode[] {
  const { query, errors } = parseQuery(specToQuery(spec), "icp");
  if (errors.length) throw new Error(errors.join("; "));
  return [
    { kind: "segment", name: "Target companies", query: formatQuery({ clauses: query.clauses, has: [] }) },
    ...query.has.filter((h) => !h.neg).map((h): ResearchTreeNode => ({
      kind: "persona", name: "Buyers", parent: 0, query: formatQuery({ clauses: h.clauses, has: [] }),
    })),
  ];
}
