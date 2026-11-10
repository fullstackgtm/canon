/**
 * A unified line diff of two texts, for the recipe agent's proposals (convex/recipeAgent.ts): the shared head and tail
 * are trimmed first, so an agent's local edit to a long recipe.md diffs only the lines it touched. Pure.
 */

/** Past this many line pairs in the changed middle, the middle is shown as one replaced block. */
const MAX_CELLS = 4_000_000;

type Op = { kind: " " | "-" | "+"; text: string };

function middleOps(a: readonly string[], b: readonly string[]): Op[] {
  if (a.length * b.length > MAX_CELLS) return [...a.map((text): Op => ({ kind: "-", text })), ...b.map((text): Op => ({ kind: "+", text }))];
  const w = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }
  const out: Op[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ kind: " ", text: a[i] }); i++; j++; }
    else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) out.push({ kind: "-", text: a[i++] });
    else out.push({ kind: "+", text: b[j++] });
  }
  while (i < a.length) out.push({ kind: "-", text: a[i++] });
  while (j < b.length) out.push({ kind: "+", text: b[j++] });
  return out;
}

/** `before` to `after` as a unified diff with `context` lines around each change; "" when they're equal. */
export function unifiedDiff(before: string, after: string, opts: { file?: string; context?: number } = {}): string {
  if (before === after) return "";
  const file = opts.file ?? "recipe.md";
  const context = opts.context ?? 3;
  const lines = (t: string) => (t.endsWith("\n") ? t.slice(0, -1) : t).split("\n");
  const a = lines(before), b = lines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const ops: Op[] = [
    ...a.slice(0, head).map((text): Op => ({ kind: " ", text })),
    ...middleOps(a.slice(head, a.length - tail), b.slice(head, b.length - tail)),
    ...a.slice(a.length - tail).map((text): Op => ({ kind: " ", text })),
  ];
  const changed = ops.flatMap((op, k) => (op.kind === " " ? [] : [k]));
  const hunks: Array<[number, number]> = [];
  for (const k of changed) {
    const last = hunks[hunks.length - 1];
    if (last && k - context <= last[1] + context) last[1] = k;
    else hunks.push([k, k]);
  }
  // Each op's line number in a and in b, 1-based, counted before it.
  const at: Array<[number, number]> = [];
  let ai = 1, bi = 1;
  for (const op of ops) {
    at.push([ai, bi]);
    if (op.kind !== "+") ai++;
    if (op.kind !== "-") bi++;
  }
  const out = [`--- a/${file}`, `+++ b/${file}`];
  for (const [first, last] of hunks) {
    const from = Math.max(0, first - context), to = Math.min(ops.length - 1, last + context);
    const slice = ops.slice(from, to + 1);
    const aLen = slice.filter((o) => o.kind !== "+").length, bLen = slice.filter((o) => o.kind !== "-").length;
    const [aStart, bStart] = at[from];
    out.push(`@@ -${aLen ? aStart : aStart - 1},${aLen} +${bLen ? bStart : bStart - 1},${bLen} @@`);
    for (const op of slice) out.push(`${op.kind}${op.text}`);
  }
  return `${out.join("\n")}\n`;
}
