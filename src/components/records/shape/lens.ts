/**
 * Shape mode's reading of a recipe.md (prototype): for each section of the deal page, what it is for, what it reads
 * and what it produces, in the recipe's own words. The parser keeps a section's actions but not its prose or each
 * action's `input`/`writes` lines, so this reads them from the markdown directly. Pure.
 */
import type { PageSpec } from "../../../../recipes";

export type LensAction = { id: string; label: string; input?: string; writes: string[]; prompts: string[]; llm?: string; gate?: string; done?: string };
export type LensSection = { title: string; component: string; purpose: string; settings: string[]; logic: string[]; actions: LensAction[] };

const HEADING = /^###\s+(.+?)\s*\{[^}]*\bsection=(\w+)/;
const list = (v: string | undefined) => (v ? v.replace(/^\[|\]$/g, "").split(",").map((s) => s.trim()).filter(Boolean) : []);

/** The deal page's sections as the markdown describes them, in order. */
export function readLens(markdown: string): LensSection[] {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => /^##\s+The deal page/i.test(l));
  if (start < 0) return [];
  const out: LensSection[] = [];
  let cur: LensSection | null = null;
  let fence: { kind: string; body: string[] } | null = null;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!fence && /^##\s/.test(l)) break;
    if (fence) {
      if (/^```\s*$/.test(l)) {
        if (cur && fence.kind === "action") {
          const kv = Object.fromEntries(fence.body.flatMap((b) => { const m = /^(\w+):\s*(.*)$/.exec(b); return m ? [[m[1], m[2]]] : []; }));
          cur.actions.push({ id: kv.id ?? "", label: (kv.label ?? kv.id ?? "").replace(/<n>/g, "N").replace(/\{[^|}]*\|([^}]*)\}/g, "$1"), input: kv.input, writes: list(kv.writes), prompts: [...list(kv.prompts), ...(kv.prompt ? [kv.prompt] : [])], llm: kv.llm, gate: kv.gate, done: kv.done });
        }
        if (cur && fence.kind === "logic") cur.logic.push(...fence.body.map((b) => b.split(":").slice(1).join(":").trim()).filter(Boolean));
        fence = null;
      } else fence.body.push(l);
      continue;
    }
    const open = /^```(\w+)/.exec(l);
    if (open) { fence = { kind: open[1], body: [] }; continue; }
    const h = HEADING.exec(l);
    if (h) { cur = { title: h[1], component: h[2], purpose: "", settings: [], logic: [], actions: [] }; out.push(cur); continue; }
    // A section's purpose is its first paragraph; later prose (tables, notes) is detail.
    if (cur && l.trim() && !cur.actions.length && !l.startsWith("|")) {
      const paragraphEnded = Boolean(cur.purpose) && !lines[i - 1]?.trim();
      if (!paragraphEnded) cur.purpose = cur.purpose ? `${cur.purpose} ${l.trim()}` : l.trim();
      for (const m of l.matchAll(/`([a-zA-Z.]+)`/g)) if (!cur.settings.includes(m[1])) cur.settings.push(m[1]);
    }
  }
  for (const s of out) s.purpose = s.purpose.replace(/`/g, "");
  return out;
}

/** The lens entry for each section of `page`, matched by component and order (the nth of its component). */
export function lensFor(page: PageSpec, lens: readonly LensSection[]): (LensSection | null)[] {
  const seen = new Map<string, number>();
  return page.map((s) => {
    const n = seen.get(s.component) ?? 0;
    seen.set(s.component, n + 1);
    return lens.filter((l) => l.component === s.component)[n] ?? null;
  });
}
