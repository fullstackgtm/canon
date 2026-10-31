import { accountFields, editorOptions, editorValue } from "./editor.ts";
import { treeMoveError } from "../../../convex/lib/icpTreeMove.ts";
import { challengeCalls } from "./challenge.ts";
import { researchCalls } from "./research.ts";
import { criteriaOf, editingCalls, validateQuery, vocabulary } from "./editing.ts";
import type { CallFunctions, IcpTreeReadValue, ReadDoc } from "../../kernel/calls.ts";
import { parseQuery, type NodeKind } from "../../../convex/lib/icpQuery.ts";
import { sentence, sentenceText } from "../../../src/lib/icp-sentence.ts";

const gapLabels: Record<string, string> = { covered: "Covered", small: "Too small to fill", too_large: "Too large: narrow it", filling: "Filling", unavailable: "Unavailable", busy: "Busy" };

export const calls: CallFunctions = {
  ...editingCalls, ...researchCalls, ...challengeCalls, validateQuery, vocabulary,
  tree(_ctx, reads) {
    const definitions = [...(reads.definitions as ReadDoc[])].sort((a, b) => Number(b.data.isDefault) - Number(a.data.isDefault) || Number(a.data.createdAt ?? a.createdAt) - Number(b.data.createdAt ?? b.createdAt));
    const nodes = [...(reads.nodes as ReadDoc[])].sort((a, b) => Number(a.data.createdAt ?? a.createdAt) - Number(b.data.createdAt ?? b.createdAt));
    const counts = reads.counts as IcpTreeReadValue;
    const fields = accountFields((reads.fields ?? []) as Array<Record<string, unknown>>);
    const graph = [...definitions.map((d) => ({ id: d.key, parent: null, kind: "icp" as const })), ...nodes.map((d) => ({ id: d.key, parent: String(d.data.parent || d.data.icp), kind: d.data.kind as "segment" | "persona" }))];
    const byKey = new Map(counts.nodes.map((n) => [n.key, n]));
    const names = new Map([...definitions, ...nodes].map((d) => [d.key, String(d.data.name)]));
    const rows: Array<Record<string, unknown>> = [];
    const sets: Array<Record<string, unknown>> = [];
    const row = (d: ReadDoc, depth: number, active: boolean, root = false) => {
      const count = byKey.get(d.key);
      if (!count) throw new Error(`No counts returned for ${d.data.name}`);
      const kind: NodeKind = root ? "icp" : d.data.kind as "segment" | "persona";
      const parsed = parseQuery(String(d.data.query), kind);
      const editor = editorValue(kind, String(d.data.query), fields, d.data);
      const text = parsed.errors.length ? "Some saved conditions need review." : sentenceText(sentence(kind, parsed.query, fields));
      sets.push({
        key: d.key, parent: root ? null : d.data.parent || d.data.icp,
        label: d.data.name, kind: root ? "ICP" : kind === "segment" ? "Segment" : "Persona",
        count: count.accounts, active, accounts: count.accounts, people: count.people,
        size: kind === "persona" ? `${count.people.toLocaleString()} people at ${count.accounts.toLocaleString()} accounts` : `${count.accounts.toLocaleString()} accounts`,
        sentence: text, query: d.data.query,
        market: root ? count.market ?? null : null,
        marketText: root ? count.market == null ? "Unavailable" : count.market.toLocaleString() : "",
        pointOfView: d.data.pointOfView ?? "", offer: d.data.offer ?? "", role: d.data.role ?? "",
      });
      const addChoices = kind !== "persona" && depth < 4 ? [{ value: "segment", label: "+ Add segment" }, { value: "persona", label: "+ Add persona" }] : [];
      const moveTargets = root ? [] : graph.filter((g) => treeMoveError(graph, d.key, g.id) === null).map((g) => ({ value: g.id, label: names.get(g.id)! }));
      rows.push({
        key: d.key, parent: root ? null : d.data.parent || d.data.icp,
        label: d.data.name, nameHint: kind === "persona" && d.data.role ? `${d.data.name} (${d.data.role})` : d.data.name, depth, icon: root ? "target" : kind === "segment" ? "layers" : "users", muted: !active, star: root && d.data.isDefault === true,
        sentence: text, editor, prefix: kind === "persona" ? "reach(" : root ? "" : ">", suffix: kind === "persona" ? ")" : "",
        addChoices, moveTargets, canAdd: addChoices.length > 0, canMove: moveTargets.length > 0,
        kind: root ? "ICP" : d.data.kind === "segment" ? "Segment" : "Persona",
        state: active ? "On" : "Off", query: d.data.query, definitionVersion: d.version, name: d.data.name,
        root: root ? d.key : d.data.icp, queryValid: parsed.errors.length === 0, queryError: parsed.errors.join("; "), criteria: parsed.errors.length ? null : criteriaOf(parsed.query),
        pointOfView: d.data.pointOfView ?? "", offer: d.data.offer ?? "", role: d.data.role ?? "", description: d.data.description ?? "",
        gap: root ? (gapLabels[String((d.data.gapCheck as { outcome?: string } | undefined)?.outcome)] ?? "Not checked") : "",
        definition: d.data.description ?? d.data.role ?? "",
        accounts: count.accounts, people: count.people,
        canViewAccounts: root && active,
        overlaps: counts.overlaps.filter((o) => o.a === d.key || o.b === d.key).map((o) => `${names.get(o.a === d.key ? o.b : o.a)}: ${o.accounts}`).join(", ") || "None",
      });
      for (const child of nodes.filter((n) => (n.data.parent || n.data.icp) === d.key)) row(child, depth + 1, active);
    };
    for (const d of definitions) row(d, 0, d.data.active === true, true);
    if (rows.length !== definitions.length + nodes.length) throw new Error("Some ICP nodes have no readable parent");
    return { value: { rows, sets, editOptions: editorOptions(fields), parentsByIcp: rows.map((r) => ({ key: r.key, options: r.moveTargets })), overlaps: counts.overlaps.map((o) => ({ a: o.a, b: o.b, count: o.accounts })) } };
  },
};
