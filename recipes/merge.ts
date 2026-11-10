/**
 * A three-way merge of a workspace recipe's markdown with its upstream (docs/recipes.md, "Upstream updates"): base is
 * the upstream text the copy was made from, ours the copy now, theirs the upstream now. A change on one side only
 * applies. Changes on both sides whose base lines overlap or touch are a conflict, unless both sides made the same
 * change, and the merged text holds both sides between markers for a person to resolve. Lines, as diff3 does. Pure.
 */

/** Past this many line pairs in the changed middle, the middle is one changed block: still correct, only coarser. */
const MAX_CELLS = 4_000_000;

/** One changed run: base lines [b0, b1) became side lines [s0, s1). */
type Hunk = { b0: number; b1: number; s0: number; s1: number };

function hunks(base: readonly string[], side: readonly string[]): Hunk[] {
  let pre = 0;
  while (pre < base.length && pre < side.length && base[pre] === side[pre]) pre++;
  let suf = 0;
  while (suf < base.length - pre && suf < side.length - pre && base[base.length - 1 - suf] === side[side.length - 1 - suf]) suf++;
  const a = base.slice(pre, base.length - suf), b = side.slice(pre, side.length - suf);
  if (!a.length && !b.length) return [];
  if (a.length * b.length > MAX_CELLS) return [{ b0: pre, b1: pre + a.length, s0: pre, s1: pre + b.length }];
  const w = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
  }
  const out: Hunk[] = [];
  let i = 0, j = 0, open: Hunk | null = null;
  const close = () => { if (open) out.push(open); open = null; };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { close(); i++; j++; continue; }
    open ??= { b0: pre + i, b1: pre + i, s0: pre + j, s1: pre + j };
    if (j < b.length && (i === a.length || lcs[i * w + j + 1] >= lcs[(i + 1) * w + j])) open.s1 = pre + ++j;
    else open.b1 = pre + ++i;
  }
  close();
  return out;
}

export const MARK_OURS = "<<<<<<< yours";
export const MARK_SPLIT = "=======";
export const markTheirs = (label: string) => `>>>>>>> ${label}`;

export type Merge = { text: string; conflicts: number; applied: number };

/** `ours` with every change from `base` to `theirs` that doesn't clash with one of ours; a clash between markers. */
export function merge3(base: string, ours: string, theirs: string, label = "upstream"): Merge {
  const B = base.split("\n"), O = ours.split("\n"), T = theirs.split("\n");
  const all = [...hunks(B, O).map((h) => ({ ...h, side: "o" as const })), ...hunks(B, T).map((h) => ({ ...h, side: "t" as const }))]
    .sort((x, y) => x.b0 - y.b0 || x.b1 - y.b1);
  const out: string[] = [];
  let at = 0, conflicts = 0, applied = 0;
  for (let k = 0; k < all.length;) {
    const group = [all[k]];
    let hi = all[k].b1;
    // A hunk joins the group when its base lines overlap or touch the group's (an insertion at its edge included).
    while (++k < all.length && all[k].b0 <= hi) { group.push(all[k]); hi = Math.max(hi, all[k].b1); }
    const lo = group[0].b0;
    out.push(...B.slice(at, lo));
    at = hi;
    const span = (side: "o" | "t", lines: readonly string[]) => {
      const hs = group.filter((h) => h.side === side);
      if (!hs.length) return B.slice(lo, hi);
      return lines.slice(hs[0].s0 - (hs[0].b0 - lo), hs[hs.length - 1].s1 + (hi - hs[hs.length - 1].b1));
    };
    const o = span("o", O), t = span("t", T);
    const sides = new Set(group.map((h) => h.side));
    if (!sides.has("t")) out.push(...o);
    else if (!sides.has("o") || o.join("\n") === t.join("\n")) { out.push(...t); applied++; }
    else { out.push(MARK_OURS, ...o, MARK_SPLIT, ...t, markTheirs(label)); conflicts++; }
  }
  out.push(...B.slice(at));
  return { text: out.join("\n"), conflicts, applied };
}

export type Conflict = { line: number; ours: string[]; theirs: string[]; start: number; end: number };

/** The conflicts left in `text`, each with its 1-based first line and its line indices [start, end]. */
export function conflictsIn(text: string): Conflict[] {
  const lines = text.split("\n");
  const out: Conflict[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== MARK_OURS) continue;
    const split = lines.indexOf(MARK_SPLIT, i + 1);
    const end = split < 0 ? -1 : lines.findIndex((l, n) => n > split && l.startsWith(">>>>>>> "));
    if (end < 0) break;
    out.push({ line: i + 1, ours: lines.slice(i + 1, split), theirs: lines.slice(split + 1, end), start: i, end });
    i = end;
  }
  return out;
}

/** `text` with its `index`th conflict resolved to one side, or to both, yours first. */
export function resolveConflict(text: string, index: number, pick: "ours" | "theirs" | "both"): string {
  const c = conflictsIn(text)[index];
  if (!c) return text;
  const lines = text.split("\n");
  const keep = pick === "ours" ? c.ours : pick === "theirs" ? c.theirs : [...c.ours, ...c.theirs];
  return [...lines.slice(0, c.start), ...keep, ...lines.slice(c.end + 1)].join("\n");
}
