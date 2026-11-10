import { allCitations, citationKey } from "./research.ts";
import type { HierarchyItem, HierarchyProposal } from "./plan.ts";

const MARK: Record<string, string> = { verified: "verified", attested: "attested", quote_not_found: "QUOTE NOT FOUND", unreachable: "UNREACHABLE" };

export function describeItem(p: HierarchyProposal, it: HierarchyItem): string {
  const nm = (i: string | null) => (i ? `${p.accounts.get(i)?.name ?? i} (${i})` : "none");
  let s: string;
  if (it.op === "merge") {
    s = `Merge ${nm(it.loserId)} into ${nm(it.survivorId)}: ${it.why}. Moves ${it.moves}.`;
    const fill = Object.entries(it.fill);
    if (fill.length) s += ` Survivor takes blank fields: ${fill.map(([k, v]) => `${k} = ${v}`).join(", ")}.`;
  } else if (it.op === "set_parent") {
    s = `Parent of ${nm(it.accountId)}: ${nm(it.from)} -> ${nm(it.to)}. ${it.why}.`;
  } else {
    s = `${nm(it.accountId)}: ${it.why}.`;
  }
  if (it.op !== "merge" && it.citations.length) s += ` Source: ${[...new Set(it.citations.map((c) => c.url))].join(", ")}`;
  for (const w of it.warn) s += ` ⚠ ${w}.`;
  return s;
}

export function proposalToMarkdown(p: HierarchyProposal): string {
  const r = p.research;
  const out = [
    `# ${p.group}: proposed account hierarchy changes (${p.today})`,
    "",
    `Nothing here has been applied. Research: ${r.researchedBy}, ${r.researchedAt}. Only claims whose citation passed the verbatim check (or that a person vouched for) became items.`,
    "",
  ];
  for (const [title, op] of [["Merges", "merge"], ["Parent moves", "set_parent"], ["Region and country fixes", "set_fields"]] as const) {
    const rows = p.items.filter((it) => it.op === op);
    out.push(`## ${title} (${rows.length})`, "", ...rows.map((it, n) => `${n + 1}. ${describeItem(p, it)}`), "");
  }
  out.push("## Flags", "", ...p.flags.map((f) => `- ${f}`), "");
  out.push("## Suggestions not proposed", "", ...p.hints.map((h) => `- ${h}`), "");
  out.push("## Sources", "");
  const seen = new Set<string>();
  for (const e of [{ name: r.ultimateParent.name, citations: r.ultimateParent.citations }, ...r.entities, ...r.entities.flatMap((e) => (e.facts ?? []).map((f) => ({ name: `${e.name} ${f.field}`, citations: f.citations })))]) {
    for (const c of e.citations) {
      const key = citationKey(c);
      if (seen.has(key)) continue;
      seen.add(key);
      const check = p.verification.checks[key];
      out.push(`- ${e.name}: "${c.quote}" ${c.url} [${MARK[check?.result ?? ""] ?? "not checked"}${check?.detail ? `: ${check.detail}` : ""}]`);
    }
  }
  const counts = new Map<string, number>();
  for (const c of allCitations(r)) {
    const res = p.verification.checks[citationKey(c)]?.result ?? "not checked";
    counts.set(res, (counts.get(res) ?? 0) + 1);
  }
  out.push("", `Citation check: ${[...counts].map(([k, v]) => `${v} ${MARK[k] ?? k}`).join(", ")}.`);
  return `${out.join("\n")}\n`;
}
