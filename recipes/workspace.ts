/**
 * Workspace recipes (docs/recipes.md, "Customizing in the app"): a workspace's own copy of a recipe, made with
 * Customize and edited as markdown in the app. Pure, so the editor checks a draft in the browser with the same rules
 * the save checks on the server.
 */
import { codeNames } from "./compose.ts";
import { parseRecipe, type CompiledRecipe, type Problem, type Runnable } from "./md/parse.ts";

/** The scope of every workspace recipe's id. A package from GitHub can't take it. */
export const WORKSPACE_SCOPE = "@workspace";
export const isWorkspaceId = (id: string) => id.startsWith(`${WORKSPACE_SCOPE}/`);
export const workspaceId = (slug: string) => `${WORKSPACE_SCOPE}/${slug}`;

/**
 * Where a workspace recipe comes from: the recipe it copied, and the markdown in force now. `bundle` is `builtins`
 * when its code is Canon's built-ins bundle carrying its own markdown, rebuilt on every save, and `kept` when it
 * runs the TypeScript bundle of the recipe it copied, unchanged.
 */
export type WorkspaceSource = {
  kind: "workspace";
  markdownHash: string;
  bundle: "builtins" | "kept";
  forkedFrom: { id: string; version: string; markdownHash: string };
};

export const CODE_REFUSED = "code changes need a package from GitHub";
const TITLE_MAX = 80;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** Routes under /dashboard/customization that a slug would shadow. */
const RESERVED = new Set(["data-model", "pipelines"]);

/** The slug a copy of `sourceId` takes: the source's name, or with -2, -3 … when the workspace already used it. */
export function copySlug(sourceId: string, taken: ReadonlySet<string>): string {
  const base = (sourceId.split("/").pop() ?? sourceId).replace(/[^a-z0-9-]/g, "-").replace(/^-+/, "").slice(0, 58) || "recipe";
  for (let n = 1; ; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    if (SLUG.test(slug) && !RESERVED.has(slug) && !taken.has(workspaceId(slug))) return slug;
  }
}

export const copyTitle = (org: string, title: string) => `${org}'s ${title}`.slice(0, TITLE_MAX);

const quoted = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** `markdown` with its frontmatter's id, title and author rewritten to the copy's. Everything else stays as written. */
export function forkMarkdown(markdown: string, copy: { id: string; title: string; org: string }): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const end = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
  if (end < 0) throw new Error("customization.md has no frontmatter");
  const set: Record<string, string> = { id: quoted(copy.id), title: quoted(copy.title), author: `{ org: ${copy.org}, kind: agency }` };
  for (let n = 1; n < end; n++) {
    const key = /^(id|title|author):/.exec(lines[n])?.[1];
    if (key) lines[n] = `${key}: ${set[key]}`;
  }
  return lines.join("\n");
}

/** A workspace slug for an org name: what the copy's author.org must look like. */
export const orgSlug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "workspace";

const lineOf = (lines: readonly string[], test: (l: string) => boolean) => Math.max(1, lines.findIndex(test) + 1);

/**
 * A draft of a workspace recipe's recipe.md, parsed, with every problem at its line: the parser's, and the rules a
 * workspace recipe adds. It keeps its id. It runs no code of its own, so it has no ```ts blocks. On Canon's built-ins
 * every ```logic line names a built-in. On a kept bundle its prompts and logic must stay as the bundle has them:
 * the bundle carries both, so an edit there would never run.
 */
export function workspaceProblems(markdown: string, rules: { id: string; frozen: Runnable | null }): { recipe: CompiledRecipe; problems: Problem[] } {
  const { recipe, problems } = parseRecipe(markdown);
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const at = (line: number, message: string) => problems.push({ line, level: "error", message });
  if (recipe.meta.id !== rules.id) at(lineOf(lines, (l) => l.startsWith("id:")), `a workspace customization keeps its id, ${rules.id}`);
  for (const block of recipe.code) at(block.line, `\`\`\`ts blocks don't run in a workspace customization: ${CODE_REFUSED}`);
  if (rules.frozen === null) {
    for (const n of codeNames(recipe)) at(n.line, `${n.kind} ${n.name} isn't a Canon built-in, and this customization has no TypeScript: ${CODE_REFUSED}`);
  } else {
    const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    const plays = new Set([...Object.keys(recipe.logic), ...Object.keys(rules.frozen.logic)]) as Set<keyof Runnable["logic"]>;
    for (const play of plays) {
      const now = recipe.logic[play] ?? [], was = rules.frozen.logic[play] ?? [];
      const strip = (s: typeof now) => s.map(({ line: _, ...rest }) => rest);
      if (!same(strip(now), strip(was))) at(now[0]?.line ?? lineOf(lines, (l) => l.startsWith("```logic")), `${play} runs from this customization's TypeScript bundle, so its logic stays as copied: ${CODE_REFUSED}`);
    }
    const ids = new Set([...Object.keys(recipe.prompts), ...Object.keys(rules.frozen.prompts)]);
    for (const id of ids) {
      if (same(recipe.prompts[id], rules.frozen.prompts[id])) continue;
      const attr = new RegExp(`\\{[^}]*\\b(prompt|partial)=${id.replace(/\./g, "\\.")}\\b`);
      at(lineOf(lines, (l) => /^#{1,6}\s/.test(l) && attr.test(l)), `the ${id} prompt runs from this customization's TypeScript bundle, so it stays as copied: ${CODE_REFUSED}`);
    }
  }
  problems.sort((a, b) => a.line - b.line);
  return { recipe, problems };
}

export type LineDiff = { added: number; removed: number; text: string };
const DIFF_CONTEXT = 2;
const DIFF_TEXT_MAX = 16_000;
/** Past this many cells the middle is shown as replaced whole, which is still correct, only coarser. */
const LCS_MAX_CELLS = 4_000_000;

/** A unified line diff from `a` to `b`: `@@ -l,n +l,n @@` hunks with two lines of context, cut at 16,000 characters. */
export function lineDiff(a: string, b: string): LineDiff {
  const x = a.split("\n"), y = b.split("\n");
  let pre = 0;
  while (pre < x.length && pre < y.length && x[pre] === y[pre]) pre++;
  let suf = 0;
  while (suf < x.length - pre && suf < y.length - pre && x[x.length - 1 - suf] === y[y.length - 1 - suf]) suf++;
  const xs = x.slice(pre, x.length - suf), ys = y.slice(pre, y.length - suf);
  type Op = { kind: " " | "-" | "+"; text: string; a: number; b: number };
  const ops: Op[] = [];
  for (let i = 0; i < pre; i++) ops.push({ kind: " ", text: x[i], a: i, b: i });
  if (xs.length * ys.length <= LCS_MAX_CELLS) {
    const w = ys.length + 1;
    const len = new Uint32Array((xs.length + 1) * w);
    for (let i = xs.length - 1; i >= 0; i--) for (let j = ys.length - 1; j >= 0; j--) {
      len[i * w + j] = xs[i] === ys[j] ? len[(i + 1) * w + j + 1] + 1 : Math.max(len[(i + 1) * w + j], len[i * w + j + 1]);
    }
    let i = 0, j = 0;
    while (i < xs.length || j < ys.length) {
      if (i < xs.length && j < ys.length && xs[i] === ys[j]) { ops.push({ kind: " ", text: xs[i], a: pre + i++, b: pre + j++ }); continue; }
      if (j < ys.length && (i === xs.length || len[i * w + j + 1] >= len[(i + 1) * w + j])) ops.push({ kind: "+", text: ys[j], a: pre + i, b: pre + j++ });
      else ops.push({ kind: "-", text: xs[i], a: pre + i++, b: pre + j });
    }
  } else {
    xs.forEach((t, i) => ops.push({ kind: "-", text: t, a: pre + i, b: pre }));
    ys.forEach((t, j) => ops.push({ kind: "+", text: t, a: pre + xs.length, b: pre + j }));
  }
  for (let i = 0; i < suf; i++) ops.push({ kind: " ", text: x[x.length - suf + i], a: x.length - suf + i, b: y.length - suf + i });
  const added = ops.filter((o) => o.kind === "+").length, removed = ops.filter((o) => o.kind === "-").length;
  const changed = ops.flatMap((o, k) => (o.kind === " " ? [] : [k]));
  const out: string[] = [];
  for (let g = 0; g < changed.length;) {
    let last = g;
    while (last + 1 < changed.length && changed[last + 1] - changed[last] <= DIFF_CONTEXT * 2 + 1) last++;
    const hunk = ops.slice(Math.max(0, changed[g] - DIFF_CONTEXT), Math.min(ops.length, changed[last] + DIFF_CONTEXT + 1));
    const aLen = hunk.filter((o) => o.kind !== "+").length, bLen = hunk.filter((o) => o.kind !== "-").length;
    out.push(`@@ -${hunk[0].a + 1},${aLen} +${hunk[0].b + 1},${bLen} @@`, ...hunk.map((o) => `${o.kind}${o.text}`));
    g = last + 1;
  }
  const text = out.join("\n");
  return { added, removed, text: text.length > DIFF_TEXT_MAX ? `${text.slice(0, DIFF_TEXT_MAX)}\n…` : text };
}
