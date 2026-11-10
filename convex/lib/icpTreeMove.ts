export type MovableNode = {
  id: string;
  parent: string | null;
  kind: "icp" | "segment" | "persona";
};

/** Validate the resulting tree, including the deepest child of a moved segment. */
export function treeMoveError(nodes: MovableNode[], sourceId: string, targetId: string): string | null {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const source = byId.get(sourceId);
  const target = byId.get(targetId);
  if (!source || !target) return "Row not found.";
  if (source.kind === "icp") return "Move a segment or persona, not an ICP.";
  if (target.kind === "persona") return "Personas cannot contain other rows.";
  if (source.parent === targetId) return "This row is already here.";
  const root = (id: string): string | undefined => {
    const seen = new Set<string>();
    let node = byId.get(id);
    while (node?.parent) {
      if (seen.has(node.id)) return undefined;
      seen.add(node.id);
      node = byId.get(node.parent);
    }
    return node?.kind === "icp" ? node.id : undefined;
  };
  if (!root(sourceId) || root(sourceId) !== root(targetId)) return "Move rows within the same ICP.";
  for (const node of nodes) {
    let current: MovableNode | undefined = node;
    const seen = new Set<string>();
    let depth = 0;
    while (current && current.kind !== "icp") {
      if (seen.has(current.id)) return "A row cannot move inside itself or its descendants.";
      seen.add(current.id);
      depth++;
      current = byId.get(current.id === sourceId ? targetId : current.parent ?? "");
    }
    if (!current) return "Row not found.";
    if (depth > 4) return "Segments go at most 4 deep.";
  }
  return null;
}
