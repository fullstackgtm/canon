/**
 * Layout edits to a recipe.md, made in its text (docs/recipes.md, "Writing a recipe"). A visual layout editor and an
 * agent editing the file write the same recipe.md, so it stays the one source of truth: each operation rewrites only
 * the lines it is about (a heading line, an action's block or one key line, a section's span, a fields line) and
 * leaves every other byte as it was. Every result is parsed again and must lay out the page exactly as the operation
 * says, with the rest of the recipe unchanged, or the operation is refused. A visual edit can't write an invalid file.
 * Pure and dependency-free, like the parser, so it runs in the browser.
 */
import { DEAL_STAGES, type DealStage } from "../../convex/lib/plays/model.ts";
import { PANELS, placements, type ActionId, type PageAction, type Panel } from "../actions.ts";
import { COMPONENTS, PAGE_KEYS, PAGE_OBJECTS, isComponentOf, type PageComponent, type PageObject, type PageSection, type PageSpec } from "../kernel.ts";
import { hasErrors, parseRecipe, readBlock, type CompiledRecipe, type Problem } from "./parse.ts";

/**
 * A section, by its component and which one of that component it is on its page, counting from 0. The component is
 * the kernel's name for the section and every page but a fields-heavy one has each at most once, so `{ component:
 * "plan" }` is enough. A title is prose a person renames and two sections can share, so it is not a reference.
 */
export type SectionRef = { component: PageComponent; nth?: number };
/** The stages a deal page's section shows in, or the ones it hides in. */
export type When = { stage: readonly DealStage[] } | { notStage: readonly DealStage[] };

/** One layout edit. An action is known by its id, which is unique on its page; `before: null` puts a thing last. */
export type LayoutOp =
  | { op: "moveSection"; object: PageObject; section: SectionRef; before: SectionRef | null }
  | { op: "setCollapsed"; object: PageObject; section: SectionRef; collapsed: boolean }
  | { op: "setWhen"; object: "deal"; section: SectionRef; when: When | null }
  | { op: "renameSection"; object: PageObject; section: SectionRef; title: string }
  | { op: "removeSection"; object: PageObject; section: SectionRef }
  | { op: "addSection"; object: PageObject; component: PageComponent; title: string; fields?: readonly string[]; before: SectionRef | null }
  | { op: "moveAction"; object: PageObject; section: SectionRef; action: string; before: string | null }
  | { op: "setActionLabel"; object: PageObject; section: SectionRef; action: string; label: string }
  | { op: "removeAction"; object: PageObject; section: SectionRef; action: string }
  | { op: "addAction"; object: PageObject; section: SectionRef; runs: ActionId; panel?: Panel; id?: string; label?: string }
  /** `undefined` leaves a condition as it is, `null` removes it. */
  | { op: "setActionCondition"; object: PageObject; section: SectionRef; action: string; shows?: string | null; enabled?: string | null }
  | { op: "moveField"; object: PageObject; field: string; to: SectionRef; before: string | null };

export type EditResult = { markdown: string } | { error: string; problems?: Problem[] };

/** What a visual editor draws for one section: its props, its actions in order, and the actions it could add. */
export type LayoutSection = {
  ref: SectionRef;
  component: PageComponent;
  title: string;
  collapsed: boolean;
  when: When | null;
  fields?: readonly string[];
  actions: Array<Pick<PageAction, "id" | "runs" | "label" | "labelAfter" | "panel" | "shows" | "enabled">>;
  addable: Array<{ runs: ActionId; panel?: Panel }>;
};
export type Layout = { object: PageObject; sections: LayoutSection[]; addable: PageComponent[] };

// ───────────────────────────── Reading the text's structure ─────────────────────────────
//
// The parser's HEADING and FENCE grammar (recipes/md/parse.ts), kept here with each line's position. Should the two
// ever drift, an edit is refused when it reparses, never written wrong.

const HEADING = /^(#{1,6})\s+(.*?)(?:\s+\{([^}]*)\})?\s*$/;
const FENCE = /^(`{3,})\s*([\w-]*)\s*(.*)$/;
const ATTR = /([\w.-]+)=("([^"]*)"|[^\s"]+)/g;
const KEY = /^([A-Za-z_][\w.-]*):/;

type Head = { at: number; level: number; title: string; attrs: Record<string, string>; parent: Head | null; end: number };
type Fence = { at: number; close: number; lang: string; head: Head | null };
type Doc = { lines: string[]; eol: string; heads: Head[]; fences: Fence[] };

function read(markdown: string): Doc {
  const eol = markdown.includes("\r\n") ? "\r\n" : "\n";
  const lines = markdown.split(eol);
  const heads: Head[] = [];
  const fences: Fence[] = [];
  let n = 0;
  if (lines[0] === "---") { const end = lines.indexOf("---", 1); n = end < 0 ? lines.length : end + 1; }
  let current: Head | null = null;
  for (; n < lines.length; n++) {
    const fence = FENCE.exec(lines[n]);
    if (fence) {
      const close = new RegExp(`^${fence[1]}\\s*$`);
      const at = n;
      for (n++; n < lines.length && !close.test(lines[n]); n++);
      fences.push({ at, close: n, lang: fence[2], head: current });
      continue;
    }
    const h = HEADING.exec(lines[n]);
    if (!h) continue;
    let parent = current as Head | null;
    while (parent && parent.level >= h[1].length) parent = parent.parent;
    const attrs: Record<string, string> = {};
    for (const m of (h[3] ?? "").matchAll(ATTR)) attrs[m[1]] = m[3] ?? m[2];
    current = { at: n, level: h[1].length, title: h[2].trim(), attrs, parent, end: 0 };
    heads.push(current);
  }
  // A heading's span runs to the next heading at its level or above; the file's last newline belongs to no span.
  const limit = lines.at(-1) === "" ? lines.length - 1 : lines.length;
  heads.forEach((h, i) => { h.end = heads.slice(i + 1).find((x) => x.level <= h.level)?.at ?? limit; });
  return { lines, eol, heads, fences };
}

const enclosing = (h: Head | null, role: string): Head | null => { for (let x = h; x; x = x.parent) if (x.attrs[role] !== undefined) return x; return null; };
const objectOf = (h: Head): PageObject => {
  const page = enclosing(h, "page")?.attrs.page;
  return (PAGE_OBJECTS as readonly string[]).includes(page ?? "") ? (page as PageObject) : "deal";
};

/** A placed action's block in the text: the fence, its id, and the panel heading it sits under. */
type Placed = { fence: Fence; id: string; panel: Head | null };
type Located = { head: Head; actions: Placed[]; fields: Fence | null };

/** An action block's id, read as the parser reads it, so `id: "findEmail"` is findEmail. */
function idOf(doc: Doc, f: Fence): string {
  try {
    const { value } = readBlock(doc.lines.slice(f.at + 1, f.close).map((text, k) => ({ text, line: f.at + 2 + k })));
    return value !== null && typeof value === "object" && !Array.isArray(value) && typeof value.id === "string" ? value.id : "";
  } catch {
    return "";
  }
}

/** The text's sections of `object`'s page, one for each of the parsed page's, or null when they don't line up. */
function locate(doc: Doc, page: PageSpec, object: PageObject): Located[] | null {
  const heads = doc.heads.filter((h) => h.attrs.section !== undefined && objectOf(h) === object && isComponentOf(object, h.attrs.section));
  const out = heads.map((head): Located => ({
    head,
    actions: doc.fences.filter((f) => f.lang === "action" && enclosing(f.head, "section") === head).map((fence) => ({ fence, id: idOf(doc, fence), panel: enclosing(fence.head, "panel") })),
    fields: doc.fences.find((f) => f.lang === "fields" && f.head === head) ?? null,
  }));
  const lined = out.length === page.length && out.every((l, i) => l.head.attrs.section === page[i].component && l.head.title === page[i].title
    && l.actions.map((a) => a.id).join() === (page[i].actions ?? []).map((a) => a.id).join());
  return lined ? out : null;
}

// ───────────────────────────── Text edits ─────────────────────────────

/** A heading line with `key=value` set, replaced in place, or dropped when `value` is null; a new one goes after `after`. */
function withAttr(line: string, key: string, value: string | null, after?: string): string {
  const h = HEADING.exec(line)!;
  const close = line.trimEnd().length - 1;
  const start = close - h[3]!.length;
  const inner = h[3]!;
  const tokens = [...inner.matchAll(ATTR)];
  const own = tokens.find((t) => t[1] === key);
  const text = value === null ? null : `${key}=${/[\s=]/.test(value) ? `"${value}"` : value}`;
  let next: string;
  if (own) {
    const s = own.index!, e = s + own[0].length;
    if (text === null) { let w = s; while (w > 0 && /\s/.test(inner[w - 1])) w--; next = inner.slice(0, w) + inner.slice(e); }
    else next = inner.slice(0, s) + text + inner.slice(e);
  } else {
    if (text === null) return line;
    const anchor = after === undefined ? undefined : tokens.find((t) => t[1] === after);
    const at = anchor ? anchor.index! + anchor[0].length : inner.trimEnd().length;
    next = `${inner.slice(0, at)} ${text}${inner.slice(at)}`;
  }
  return line.slice(0, start) + next + line.slice(close);
}

/** A heading line with its title replaced. */
function withTitle(line: string, title: string): string {
  const h = HEADING.exec(line)!;
  const start = /^#{1,6}\s+/.exec(line)![0].length;
  return line.slice(0, start) + title + line.slice(start + h[2].length);
}

/** `s` as a block value that reads back as exactly that string, or null when no single line can hold it. */
function scalar(s: string): string | null {
  if (!s.trim() || /[\r\n]/.test(s)) return null;
  const bare = s === s.trim() && !/^["'[{#]/.test(s) && !/^(true|false|null|-?\d+(\.\d+)?)$/.test(s);
  return bare ? s : `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

const whenText = (w: When) => ("stage" in w
  ? (w.stage.length === 1 ? `stage = ${w.stage[0]}` : `stage in [${w.stage.join(", ")}]`)
  : (w.notStage.length === 1 ? `stage != ${w.notStage[0]}` : `stage not in [${w.notStage.join(", ")}]`));

/** The line after a block and the blank line that follows it, if one does. */
const unitEnd = (lines: readonly string[], f: Fence) => f.close + 1 + (lines[f.close + 1] === "" ? 1 : 0);

/** `lines` without the block, and the blank line after it (or else before it), so the spacing around it stays one line. */
function cut(lines: string[], f: Fence): void {
  const after = lines[f.close + 1] === "";
  const before = !after && f.at > 0 && lines[f.at - 1] === "";
  lines.splice(before ? f.at - 1 : f.at, f.close + 1 - f.at + (after || before ? 1 : 0));
}

/** `block` inserted at line `at`, with a blank line on each side where there isn't one. */
function put(lines: string[], at: number, block: readonly string[]): void {
  const pre = at > 0 && lines[at - 1].trim() !== "" ? [""] : [];
  const post = at < lines.length && lines[at].trim() !== "" ? [""] : [];
  lines.splice(at, 0, ...pre, ...block, ...post);
}

/** The top-level keys of an action block, each with the lines it spans. */
function keysOf(lines: readonly string[], f: Fence): Array<{ key: string; at: number; end: number }> {
  const out: Array<{ key: string; at: number; end: number }> = [];
  for (let n = f.at + 1; n < f.close; n++) {
    const m = KEY.exec(lines[n]);
    if (m) out.push({ key: m[1], at: n, end: n + 1 });
    else if (out.length && /^\s/.test(lines[n])) out.at(-1)!.end = n + 1;
  }
  return out;
}
/** The keys a condition follows in an action block, in the order recipes write them. */
const BEFORE: Record<"shows" | "enabled", readonly string[]> = {
  shows: ["id", "label", "label_after", "runs", "prompt", "prompts", "review", "input", "writes", "fields"],
  enabled: ["id", "label", "label_after", "runs", "prompt", "prompts", "review", "input", "writes", "fields", "shows"],
};

/** The heading a panel gets when its first action is added to a section whose text has none. */
const PANEL_TITLES: Record<Panel, string> = { draftPanel: "The draft panel" };

const fieldTokens = (line: string) => line.split(",").map((x) => x.trim()).filter(Boolean);

// ───────────────────────────── The page each edit should give ─────────────────────────────

const indexOf = (page: PageSpec, ref: SectionRef): number => { let n = ref.nth ?? 0; return page.findIndex((s) => s.component === ref.component && n-- === 0); };
const refOf = (page: PageSpec, i: number): SectionRef => ({ component: page[i].component, nth: page.slice(0, i).filter((s) => s.component === page[i].component).length });
const withSection = (page: PageSpec, i: number, s: PageSection): PageSpec => page.map((x, j) => (j === i ? s : x));
/** An action's place among the others in its part of the section: its own actions, or a panel's. */
const sameArea = (a: Pick<PageAction, "panel">, b: Pick<PageAction, "panel">) => (a.panel ?? "") === (b.panel ?? "");
/** The page as it renders: a section's own actions and each panel's are separate lists, so their interleaving is moot, and no actions is none. */
const rendered = (page: PageSpec): PageSpec => page.map((s) => ({ ...s, actions: s.actions?.length ? [...s.actions].sort((a, b) => (a.panel ?? "").localeCompare(b.panel ?? "")) : undefined }));
/** `actions` with `a` placed before the action `before`, or last. */
function placeAction(actions: readonly PageAction[], a: PageAction, before: string | null): PageAction[] {
  const rest = actions.filter((x) => x.id !== a.id);
  const at = before === null ? rest.length : rest.findIndex((x) => x.id === before);
  return [...rest.slice(0, at), a, ...rest.slice(at)];
}

/** Two parsed values as equal, ignoring line numbers, which every edit above a block moves, and keys set to undefined. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = (x: object) => Object.keys(x).filter((k) => k !== "line" && (x as Record<string, unknown>)[k] !== undefined);
  const ka = keys(a), kb = keys(b);
  return ka.length === kb.length && ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

// ───────────────────────────── apply ─────────────────────────────

const parsed = new Map<string, ReturnType<typeof parseRecipe>>();
/** The parser's answer, kept for the last few texts: an editor applies its next edit to the text it just checked. */
function parse(markdown: string) {
  let p = parsed.get(markdown);
  if (!p) {
    p = parseRecipe(markdown);
    parsed.set(markdown, p);
    if (parsed.size > 8) parsed.delete(parsed.keys().next().value!);
  }
  return p;
}

type Plan = { lines: string[]; page: PageSpec } | { error: string };

/** The recipe.md with `op` applied, or why it can't be. The result parses with no errors and changes only the layout `op` names. */
export function apply(markdown: string, op: LayoutOp): EditResult {
  const { recipe, problems } = parse(markdown);
  if (hasErrors(problems)) return { error: "the customization has problems to fix before its layout can be edited", problems: problems.filter((p) => p.level === "error") };
  const doc = read(markdown);
  const page = recipe[PAGE_KEYS[op.object]];
  const at = locate(doc, page, op.object);
  if (!at) return { error: `can't find the ${op.object} page's sections in the text` };
  const plan = planOf(doc, page, at, op);
  if ("error" in plan) return plan;
  const next = plan.lines.join(doc.eol);
  const after = parse(next);
  const errors = after.problems.filter((p) => p.level === "error");
  if (errors.length) return { error: `the edit would break the customization: ${errors.map((p) => p.message).join("; ")}`, problems: errors };
  const want: CompiledRecipe = { ...recipe, [PAGE_KEYS[op.object]]: plan.page };
  const norm = (r: CompiledRecipe) => ({ ...r, dealPage: rendered(r.dealPage), accountPage: rendered(r.accountPage), contactPage: rendered(r.contactPage) });
  if (!same(norm(after.recipe), norm(want))) return { error: "the edit would change more than the layout it names" };
  return { markdown: next };
}

function planOf(doc: Doc, page: PageSpec, at: Located[], op: LayoutOp): Plan {
  const lines = [...doc.lines];
  const sectionAt = (ref: SectionRef): { error: string } | { i: number; s: PageSection; loc: Located } => {
    const i = indexOf(page, ref);
    return i < 0 ? { error: `the ${op.object} page has no ${ref.component} section${ref.nth ? ` number ${ref.nth + 1}` : ""}` } : { i, s: page[i], loc: at[i] };
  };
  const last = at.at(-1);

  if (op.op === "addSection") {
    if (!isComponentOf(op.object, op.component)) return { error: `${op.component} is not a component of the ${op.object} page (${COMPONENTS[op.object].join(", ")})` };
    if (!last) return { error: `this customization lays out no ${op.object} page to add to` };
    const title = op.title.trim();
    if (!title || /[\r\n{}]/.test(title)) return { error: "a section's title is one line of text, without braces" };
    if ((op.component === "fields") !== (op.fields !== undefined)) return { error: "a fields section, and only a fields section, names its fields" };
    const fields = op.fields ?? [];
    if (op.component === "fields" && !fields.length) return { error: "a fields section names at least one field" };
    const before = op.before && sectionAt(op.before);
    if (before && "error" in before) return before;
    const block = [`${"#".repeat(at[0].head.level)} ${title} {section=${op.component}}`, ...(op.component === "fields" ? ["", "```fields", fields.join(", "), "```"] : [])];
    put(lines, before ? before.loc.head.at : last.head.end, block);
    const section = { component: op.component, title, ...(op.component === "fields" ? { fields } : {}) } as PageSection;
    const i = before ? before.i : page.length;
    return { lines, page: [...page.slice(0, i), section, ...page.slice(i)] };
  }

  if (op.op === "moveField") {
    const from = page.findIndex((s) => s.component === "fields" && s.fields.includes(op.field));
    if (from < 0) return { error: `no fields section of the ${op.object} page lists ${op.field}` };
    const to = sectionAt(op.to);
    if ("error" in to) return to;
    if (to.s.component !== "fields") return { error: "a field moves to a fields section" };
    if (op.before === op.field) return { lines, page };
    if (op.before !== null && !to.s.fields.includes(op.before)) return { error: `${to.s.title} doesn't list ${op.before}` };
    const edits = new Map<number, string[]>();
    const tokensAt = (n: number) => edits.get(n) ?? fieldTokens(lines[n]);
    const own = at[from].fields!;
    const src = Array.from({ length: own.close - own.at - 1 }, (_, k) => own.at + 1 + k).find((n) => fieldTokens(lines[n]).includes(op.field))!;
    edits.set(src, tokensAt(src).filter((t) => t !== op.field));
    const dst = to.loc.fields!;
    const body = Array.from({ length: dst.close - dst.at - 1 }, (_, k) => dst.at + 1 + k);
    const filled = body.filter((n) => tokensAt(n).length);
    const line = op.before !== null ? body.find((n) => tokensAt(n).includes(op.before!))! : filled.at(-1) ?? body.at(-1)!;
    const tokens = tokensAt(line);
    const k = op.before !== null ? tokens.indexOf(op.before) : tokens.length;
    edits.set(line, [...tokens.slice(0, k), op.field, ...tokens.slice(k)]);
    for (const n of [...edits.keys()].sort((a, b) => b - a)) {
      const t = edits.get(n)!;
      if (t.length) lines[n] = t.join(", ");
      else lines.splice(n, 1);
    }
    let next: PageSpec = page.map((s) => (s.component === "fields" && s.fields.includes(op.field) ? { ...s, fields: s.fields.filter((f) => f !== op.field) } : s));
    const target = next[to.i] as Extract<PageSection, { component: "fields" }>;
    const j = op.before !== null ? target.fields.indexOf(op.before) : target.fields.length;
    next = withSection(next, to.i, { ...target, fields: [...target.fields.slice(0, j), op.field, ...target.fields.slice(j)] });
    return { lines, page: next };
  }

  const found = sectionAt(op.section);
  if ("error" in found) return found;
  const { i, s, loc } = found;
  const head = loc.head;

  switch (op.op) {
    case "moveSection": {
      const before = op.before && sectionAt(op.before);
      if (before && "error" in before) return before;
      if (before && before.i === i) return { lines, page };
      const span = lines.splice(head.at, head.end - head.at);
      const target = before ? before.loc.head.at : last!.head.end;
      lines.splice(target > head.at ? target - span.length : target, 0, ...span);
      const rest = page.filter((_, j) => j !== i);
      const k = before ? rest.indexOf(before.s) : rest.length;
      return { lines, page: [...rest.slice(0, k), s, ...rest.slice(k)] };
    }
    case "setCollapsed": {
      if (Boolean(s.collapsed) === op.collapsed) return { lines, page };
      lines[head.at] = withAttr(lines[head.at], "collapsed", op.collapsed ? "true" : null);
      return { lines, page: withSection(page, i, { ...s, collapsed: op.collapsed || undefined }) };
    }
    case "setWhen": {
      if (op.object !== "deal") return { error: "when= picks a deal's stages, so it is only for sections of the deal page" };
      const stages = op.when ? ("stage" in op.when ? op.when.stage : op.when.notStage) : [];
      if (op.when && (!stages.length || !stages.every((x) => (DEAL_STAGES as readonly string[]).includes(x)))) return { error: `when names some of the stages ${DEAL_STAGES.join(", ")}` };
      lines[head.at] = withAttr(lines[head.at], "when", op.when ? whenText(op.when) : null, "section");
      return { lines, page: withSection(page, i, { ...s, when: op.when ?? undefined }) };
    }
    case "renameSection": {
      const title = op.title.trim();
      if (!title || /[\r\n{}]/.test(title)) return { error: "a section's title is one line of text, without braces" };
      lines[head.at] = withTitle(lines[head.at], title);
      return { lines, page: withSection(page, i, { ...s, title }) };
    }
    case "removeSection":
      lines.splice(head.at, head.end - head.at);
      return { lines, page: page.filter((_, j) => j !== i) };
    case "addAction": {
      const host = op.panel ?? s.component;
      if (op.panel !== undefined && PANELS[op.panel] !== s.component) return { error: `the ${op.panel} sits in a ${PANELS[op.panel]} section` };
      if (!placements().some((p) => p.id === op.runs && p.object === op.object && p.host === host)) return { error: `${op.runs} can't sit in the ${op.object} page's ${host}` };
      const taken = new Set(page.flatMap((x) => (x.actions ?? []).map((a) => a.id)));
      const base = op.runs.slice(op.runs.indexOf(".") + 1);
      let id = op.id ?? base;
      if (op.id === undefined) for (let k = 2; taken.has(id); k++) id = `${base}${k}`;
      if (taken.has(id)) return { error: `the ${op.object} page already has an action ${id}` };
      const label = op.label ?? base.replace(/[A-Z]/g, (c) => ` ${c.toLowerCase()}`).replace(/^./, (c) => c.toUpperCase());
      const labelText = scalar(label);
      if (labelText === null) return { error: "a label is one line of text" };
      const block = ["```action", `id: ${id}`, `label: ${labelText}`, `runs: ${op.runs}`, "```"];
      // An action goes after the last in its area, or else where its area's own text ends: before the section's first
      // subheading, or at the end of the panel.
      const area = loc.actions.filter((a) => a.panel?.attrs.panel === op.panel);
      const region = op.panel === undefined ? head : doc.heads.find((h) => h.attrs.panel === op.panel && enclosing(h, "section") === head);
      if (region) put(lines, area.length ? unitEnd(lines, area.at(-1)!.fence) : doc.heads.find((h) => h.at > region.at && h.at < region.end)?.at ?? region.end, block);
      else put(lines, head.end, [`${"#".repeat(Math.min(head.level + 1, 6))} ${PANEL_TITLES[op.panel!]} {panel=${op.panel}}`, "", ...block]);
      const action: PageAction = { id, label, runs: op.runs, ...(op.panel !== undefined ? { panel: op.panel } : {}) };
      return { lines, page: withSection(page, i, { ...s, actions: placeAction(s.actions ?? [], action, null) }) };
    }
  }

  const placed = loc.actions.find((a) => a.id === op.action);
  const action = (s.actions ?? []).find((a) => a.id === op.action);
  if (!placed || !action) return { error: `${s.title} has no action ${op.action}` };
  const f = placed.fence;
  const withAction = (a: PageAction | null) => withSection(page, i, { ...s, actions: (s.actions ?? []).flatMap((x) => (x.id !== op.action ? [x] : a ? [a] : [])) });

  switch (op.op) {
    case "moveAction": {
      if (op.before === op.action) return { lines, page };
      const target = op.before === null ? null : loc.actions.find((a) => a.id === op.before);
      const targetAction = (s.actions ?? []).find((a) => a.id === op.before);
      if (op.before !== null && (!target || !targetAction || !sameArea(targetAction, action))) return { error: `${op.before} is not an action beside ${op.action} in ${s.title}` };
      const area = loc.actions.filter((a) => a.panel === placed.panel);
      if (!target && area.length < 2) return { lines, page };
      // An action carries the prose between it and the action before it, which introduces it; the area's first
      // action carries none, since what comes before it is the section's own.
      const startOf = (k: number) => {
        const from = k > 0 ? unitEnd(lines, area[k - 1].fence) : area[k].fence.at;
        return lines.slice(from, area[k].fence.at).some((l) => HEADING.test(l) || FENCE.test(l)) ? area[k].fence.at : from;
      };
      const own = area.indexOf(placed);
      const start = startOf(own), end = unitEnd(lines, f);
      const others = area.filter((a) => a !== placed);
      const where = target ? startOf(area.indexOf(target)) : unitEnd(lines, others.at(-1)!.fence);
      const unit = lines.splice(start, end - start);
      if (unit.at(-1) === "") unit.pop();
      put(lines, where > start ? where - (end - start) : where, unit);
      return { lines, page: withSection(page, i, { ...s, actions: placeAction(s.actions ?? [], action, op.before) }) };
    }
    case "removeAction":
      cut(lines, f);
      return { lines, page: withAction(null) };
    case "setActionLabel": {
      const text = scalar(op.label);
      if (text === null) return { error: "a label is one line of text" };
      const key = keysOf(lines, f).find((k) => k.key === "label");
      if (!key) return { error: `action ${op.action} has no label line` };
      lines.splice(key.at, key.end - key.at, `label: ${text}`);
      return { lines, page: withAction({ ...action, label: op.label }) };
    }
    case "setActionCondition": {
      let next: PageAction = action;
      const block = { ...f };
      for (const name of ["shows", "enabled"] as const) {
        const value = op[name];
        if (value === undefined) continue;
        const text = value === null ? null : scalar(value);
        if (value !== null && text === null) return { error: `${name} is one line` };
        const keys = keysOf(lines, block);
        const own = keys.find((k) => k.key === name);
        const line = text === null ? [] : [`${name}: ${text}`];
        const from = own ? own.at : keys.filter((k) => BEFORE[name].includes(k.key)).at(-1)?.end ?? block.at + 1;
        const size = own ? own.end - own.at : 0;
        lines.splice(from, size, ...line);
        block.close += line.length - size;
        next = { ...next, [name]: value ?? undefined };
      }
      return { lines, page: withAction(next) };
    }
  }
}

// ───────────────────────────── describeLayout ─────────────────────────────

/** What a visual layout editor draws for `object`'s page: its sections in order, and what it could add. */
export function describeLayout(markdown: string, object: PageObject): Layout | { error: string; problems?: Problem[] } {
  const { recipe, problems } = parse(markdown);
  if (hasErrors(problems)) return { error: "the customization has problems to fix before its layout can be edited", problems: problems.filter((p) => p.level === "error") };
  const page = recipe[PAGE_KEYS[object]];
  const present = new Set(page.map((s) => s.component));
  return {
    object,
    sections: page.map((s, i): LayoutSection => {
      const actions = s.actions ?? [];
      const hosts = new Map<string, Panel | undefined>([[s.component, undefined], ...Object.entries(PANELS).filter(([, c]) => c === s.component).map(([p]) => [p, p as Panel] as const)]);
      return {
        ref: refOf(page, i), component: s.component, title: s.title ?? s.component, collapsed: Boolean(s.collapsed), when: (s.when as When | undefined) ?? null,
        ...(s.component === "fields" ? { fields: s.fields } : {}),
        actions: actions.map((a) => ({ id: a.id, runs: a.runs, label: a.label, ...(a.labelAfter !== undefined ? { labelAfter: a.labelAfter } : {}), ...(a.panel ? { panel: a.panel } : {}), ...(a.shows !== undefined ? { shows: a.shows } : {}), ...(a.enabled !== undefined ? { enabled: a.enabled } : {}) })),
        addable: placements().filter((p) => p.object === object && hosts.has(p.host) && !actions.some((a) => a.runs === p.id && a.panel === hosts.get(p.host)))
          .map((p) => ({ runs: p.id, ...(hosts.get(p.host) ? { panel: hosts.get(p.host) } : {}) })),
      };
    }),
    addable: COMPONENTS[object].filter((c) => c === "fields" || !present.has(c)),
  };
}
