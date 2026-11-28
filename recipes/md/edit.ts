import { validPageSlug, PAGE_ICONS } from "../pages.ts";
import { isDataComponent, validateDataQuery, type DataQuery } from "../data.ts";
import { CONTAINERS, CONTAINER_PATCHES, PAGE_STYLE, completeTree, pageKeys, printLayout, sectionKey, validateTree, type LayoutNode, type LayoutTree, type ContainerKind, type ContainerProps, type ContainerPropsPatch, type PageStyle } from "../layout.ts";
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
import { BLOCKS, componentsOf, pageKind, isRecordBlock, parseRecordProps, type RecordProps } from "../blocks.ts";
import { pageOf, PAGE_KEYS, isComponentOf, type PageComponent, type PageObject, type PageSection, type PageSpec } from "../kernel.ts";
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
export type TreeOp =
  | { op: "setPageStyle"; object: string; style: PageStyle }
  | { op: "wrapSections"; object: string; sections: SectionRef[]; kind: ContainerKind; id: string; props?: ContainerProps }
  | { op: "unwrap"; object: string; container: string }
  | { op: "moveIntoContainer"; object: string; section: SectionRef; container: string; before: SectionRef | null }
  | { op: "setContainerProps"; object: string; container: string; props: ContainerPropsPatch };
export type PageOp = { op: "addPage"; slug: string; title: string; icon?: string; record?: boolean } | { op: "removePage"; slug: string };
export type LayoutOp = PageOp | TreeOp
  | { op: "setProps"; object: string; section: SectionRef; props: RecordProps }
  | { op: "setQuery"; object: string; section: SectionRef; query: DataQuery }
  | { op: "moveSection"; object: string; section: SectionRef; before: SectionRef | null }
  | { op: "setCollapsed"; object: string; section: SectionRef; collapsed: boolean }
  | { op: "setWhen"; object: "deal"; section: SectionRef; when: When | null }
  | { op: "renameSection"; object: string; section: SectionRef; title: string }
  | { op: "removeSection"; object: string; section: SectionRef }
  | { op: "addSection"; object: string; component: PageComponent; title: string; fields?: readonly string[]; query?: DataQuery; props?: RecordProps; before: SectionRef | null }
  | { op: "moveAction"; object: string; section: SectionRef; action: string; before: string | null }
  | { op: "setActionLabel"; object: string; section: SectionRef; action: string; label: string }
  | { op: "removeAction"; object: string; section: SectionRef; action: string }
  | { op: "addAction"; object: string; section: SectionRef; runs: ActionId; panel?: Panel; id?: string; label?: string }
  /** `undefined` leaves a condition as it is, `null` removes it. */
  | { op: "setActionCondition"; object: string; section: SectionRef; action: string; shows?: string | null; enabled?: string | null }
  | { op: "moveField"; object: string; field: string; to: SectionRef; before: string | null };

export type EditResult = { markdown: string } | { error: string; problems?: Problem[] };

/** What a visual editor draws for one section: its props, its actions in order, and the actions it could add. */
export type LayoutSection = {
  ref: SectionRef;
  component: PageComponent;
  title: string;
  collapsed: boolean;
  when: When | null;
  fields?: readonly string[];
  props?: RecordProps;
  query?: DataQuery;
  asQuery?: DataQuery;
  actions: Array<Pick<PageAction, "id" | "runs" | "label" | "labelAfter" | "panel" | "shows" | "enabled">>;
  addable: Array<{ runs: ActionId; panel?: Panel }>;
};
export type Layout = { tree: LayoutTree; style?: PageStyle; object: string; sections: LayoutSection[]; addable: PageComponent[] };

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
const objectOf = (h: Head): string => {
  const page = enclosing(h, "page")?.attrs.page;
  return page ?? "deal";
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
function locate(doc: Doc, page: PageSpec, object: string): Located[] | null {
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
  if (op.op === "addPage" || op.op === "removePage") {
    const pages = recipe.workspacePages ?? [];
    const own = pages.find((p) => p.slug === op.slug);
    const lines = [...doc.lines];
    let want: CompiledRecipe;
    if (op.op === "addPage") {
      if (own || !(op.record ? pageKind(op.slug) === "custom" : validPageSlug(op.slug)) || !op.title.trim() || /[\r\n{}]/.test(op.title) || (op.icon && !(PAGE_ICONS as readonly string[]).includes(op.icon))) return { error: "a page needs a unique lowercase kebab slug, a title and a sidebar icon" };
      const contributes = lines.findIndex((l) => /^contributes:/.test(l));
      if (contributes < 0) return { error: "cannot locate contributes" };
      if (!recipe.meta.contributes.includes("workspace.pages")) lines[contributes] = lines[contributes].replace(/\]/, ", workspace.pages]").replace("[,", "[");
      put(lines, lines.at(-1) === "" ? lines.length - 1 : lines.length, [`# ${op.title} {page=${op.slug}${op.icon ? ` icon=${op.icon}` : ""}}`, ""]);
      want = { ...recipe, meta: { ...recipe.meta, permissions: { ...recipe.meta.permissions, slots: [...new Set([...recipe.meta.permissions.slots, "workspace.pages" as const])] }, contributes: [...new Set([...recipe.meta.contributes, "workspace.pages" as const])] }, workspacePages: [...pages, { slug: op.slug, title: op.title, nav: op.record ? "hidden" : "main", ...(op.icon ? { icon: op.icon } : {}), sections: [] }] };
    } else {
      const head = doc.heads.find((h) => h.attrs.page === op.slug);
      if (!own || !head) return { error: "page does not exist" };
      lines.splice(head.at, head.end - head.at);
      const remaining = pages.filter((p) => p !== own);
      if (!remaining.length) {
        const n = lines.findIndex((l) => /^contributes:/.test(l));
        lines[n] = lines[n].replace(/,\s*workspace.pages|workspace.pages,?\s*/, "");
      }
      const { workspacePages: _, layouts: oldLayouts, ...rest } = recipe;
      const layouts = Object.fromEntries(Object.entries(oldLayouts ?? {}).filter(([slug]) => slug !== op.slug));
      want = { ...rest, meta: { ...recipe.meta, permissions: { ...recipe.meta.permissions, slots: remaining.length ? recipe.meta.permissions.slots : recipe.meta.permissions.slots.filter((p) => p !== "workspace.pages") }, contributes: remaining.length ? recipe.meta.contributes : recipe.meta.contributes.filter((p) => p !== "workspace.pages") }, ...(remaining.length ? { workspacePages: remaining } : {}), ...(Object.keys(layouts).length ? { layouts } : {}) };
    }
    const next = lines.join(doc.eol), after = parse(next);
    return hasErrors(after.problems) || !same(after.recipe, want) ? { error: "page edit failed exactness check", problems: after.problems } : { markdown: next };
  }
  if (!Object.hasOwn(PAGE_KEYS, op.object) && !recipe.workspacePages?.some((p) => p.slug === op.object)) return { error: "page does not exist" };
  const page = pageOf(recipe, op.object);
  const at = locate(doc, page, op.object);
  if (!at) return { error: `can't find the ${op.object} page's sections in the text` };
  if (["setPageStyle", "wrapSections", "unwrap", "moveIntoContainer", "setContainerProps"].includes(op.op)) return applyTree(markdown, recipe, doc, op as TreeOp);
  if (recipe.layouts?.[op.object]?.children.length && op.op === "moveSection") return moveInTree(markdown, recipe, doc, op);
  const plan = planOf(doc, page, at, op as Exclude<LayoutOp, TreeOp | PageOp>);
  if ("error" in plan) return plan;
  let next = plan.lines.join(doc.eol);
  let layouts = recipe.layouts;
  if (layouts?.[op.object]?.children.length && (op.op === "removeSection" || op.op === "addSection")) {
    const oldKeys = pageKeys(page), newKeys = pageKeys(plan.page);
    const remap = (n: LayoutNode): LayoutNode[] => {
      if ("section" in n) { const section = page[oldKeys.indexOf(n.section)]; const i = plan.page.indexOf(section); return i < 0 ? [] : [{ section: newKeys[i] }]; }
      const children = n.children.flatMap(remap);
      if (!children.length) return [];
      if (n.kind === "columns" && children.length < 2) return children;
      return [{ ...n, children, ...(n.kind === "tabs" ? { labels: n.children.flatMap((c, i) => remap(c).length ? [n.labels![i]] : []) } : {}), ...(n.kind === "columns" && n.widths ? { widths: n.children.flatMap((c, i) => remap(c).length ? [n.widths![i]] : []) } : {}) }];
    };
    const tree = remap(layouts[op.object]!)[0] as LayoutTree | undefined;
    const root: LayoutTree = tree ?? { ...layouts[op.object]!, children: newKeys.map((section) => ({ section })) };
    if (op.op === "addSection") {
      const addedIndex = plan.page.findIndex((s) => !page.includes(s));
      const key = newKeys[addedIndex];
      const beforeIndex = op.before ? indexOf(page, op.before) : -1;
      const before = beforeIndex < 0 ? null : newKeys[plan.page.indexOf(page[beforeIndex])];
      const parent = before ? containers(root).find((n) => n.children.some((c) => "section" in c && c.section === before)) : root;
      if (parent) parent.children.splice(before ? parent.children.findIndex((c) => "section" in c && c.section === before) : parent.children.length, 0, { section: key });
    }
    layouts = { ...layouts, [op.object]: root };
    next = writeTree(next, read(next), op.object, root);
  }
  const after = parse(next);
  const errors = after.problems.filter((p) => p.level === "error");
  if (errors.length) return { error: `the edit would break the customization: ${errors.map((p) => p.message).join("; ")}`, problems: errors };
  const want: CompiledRecipe = { ...recipe, ...(!Object.hasOwn(PAGE_KEYS, op.object) ? { workspacePages: recipe.workspacePages?.map((p) => p.slug === op.object ? { ...p, sections: plan.page } : p) } : { [PAGE_KEYS[op.object as PageObject]]: plan.page }), ...(layouts ? { layouts } : {}) };
  const norm = (r: CompiledRecipe) => ({ ...r, dealPage: rendered(r.dealPage), accountPage: rendered(r.accountPage), contactPage: rendered(r.contactPage) });
  if (!same(norm(after.recipe), norm(want))) return { error: "the edit would change more than the layout it names" };
  return { markdown: next };
}

function planOf(doc: Doc, page: PageSpec, at: Located[], op: Exclude<LayoutOp, TreeOp | PageOp>): Plan {
  const lines = [...doc.lines];
  const sectionAt = (ref: SectionRef): { error: string } | { i: number; s: PageSection; loc: Located } => {
    const i = indexOf(page, ref);
    return i < 0 ? { error: `the ${op.object} page has no ${ref.component} section${ref.nth ? ` number ${ref.nth + 1}` : ""}` } : { i, s: page[i], loc: at[i] };
  };
  const last = at.at(-1);

  if (op.op === "addSection") {
    if (!isComponentOf(op.object, op.component)) return { error: `${op.component} is not a component of the ${op.object} page (${componentsOf(pageKind(op.object)).join(", ")})` };
    const pageHead = doc.heads.find((h) => h.attrs.page === op.object);
    if (!last && !pageHead) return { error: `this customization lays out no ${op.object} page to add to` };
    const title = op.title.trim();
    if (!title || /[\r\n{}]/.test(title)) return { error: "a section's title is one line of text, without braces" };
    if ((op.component === "fields") !== (op.fields !== undefined)) return { error: "a fields section, and only a fields section, names its fields" };
    const fields = op.fields ?? [];
    if (op.component === "fields" && !fields.length) return { error: "a fields section names at least one field" };
    let query: DataQuery | undefined;
    if (isDataComponent(op.component)) {
      try { query = validateDataQuery(op.component, op.query, pageKind(op.object)); }
      catch (e) { return { error: String(e) }; }
    } else if (op.query) return { error: "only data sections accept queries" };
    let props: RecordProps | undefined;
    try {
      if (isRecordBlock(op.component)) props = parseRecordProps(op.component, op.props, pageKind(op.object));
      else if (op.props !== undefined) return { error: "only record building blocks take props" };
    } catch (e) { return { error: String(e) }; }
    const before = op.before && sectionAt(op.before);
    if (before && "error" in before) return before;
    const block = [`${"#".repeat((at[0]?.head.level ?? pageHead!.level + 1))} ${title} {section=${op.component}}`, ...(op.component === "fields" ? ["", "```fields", fields.join(", "), "```"] : [])];
    if (props) block.push("", "```props", ...JSON.stringify(props, null, 2).split("\n"), "```");
    if (query) block.push("", "```query", ...JSON.stringify(query, null, 2).split("\n"), "```");
    const runs = op.component === "form" ? "kernel.createRecord" : op.component === "board" || op.component === "detail" ? "kernel.editField" : undefined;
    const takenActions = new Set(page.flatMap((s) => s.actions?.map((a) => a.id) ?? []));
    let actionId: string = op.component;
    for (let n = 2; takenActions.has(actionId); n++) actionId = `${op.component}${n}`;
    const actions: PageAction[] | undefined = runs ? [{ id: actionId, label: op.component === "form" ? "Create" : "Edit", runs }] : undefined;
    if (actions) for (const a of actions) block.push("", "```action", `id: ${a.id}`, `label: ${a.label}`, `runs: ${a.runs}`, "```");
    put(lines, before ? before.loc.head.at : (last?.head.end ?? pageHead!.end), block);
    const section = { component: op.component, title, ...(op.component === "fields" ? { fields } : {}), ...(query ? { query } : {}), ...(props ? { props } : {}), ...(actions ? { actions } : {}) } as PageSection;
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
    case "setProps": {
      if (!isRecordBlock(s.component)) return { error: "only record building blocks take props" };
      let props: RecordProps;
      try { props = parseRecordProps(s.component, op.props, pageKind(op.object)); } catch (e) { return { error: String(e) }; }
      const fence = doc.fences.find((f) => f.lang === "props" && f.head === head);
      const content = JSON.stringify(props, null, 2).split("\n");
      if (fence) lines.splice(fence.at + 1, fence.close - fence.at - 1, ...content);
      else put(lines, head.at + 1, ["```props", ...content, "```"]);
      return { lines, page: withSection(page, i, { ...s, props } as PageSection) };
    }
    case "setQuery": {
      if (!isDataComponent(s.component)) return { error: "only data sections accept queries" };
      let query: DataQuery;
      try { query = validateDataQuery(s.component, op.query, pageKind(op.object)); } catch (e) { return { error: String(e) }; }
      const fence = doc.fences.find((f) => f.lang === "query" && enclosing(f.head, "section") === head);
      if (!fence) return { error: "section has no query" };
      lines.splice(fence.at + 1, fence.close - fence.at - 1, ...JSON.stringify(query, null, 2).split("\n"));
      return { lines, page: withSection(page, i, { ...s, query } as unknown as PageSection) };
    }
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
      if (!placements().some((p) => p.id === op.runs && p.object === pageKind(op.object) && p.host === host)) return { error: `${op.runs} can't sit in the ${op.object} page's ${host}` };
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
export function describeLayout(markdown: string, object: string): Layout | { error: string; problems?: Problem[] } {
  const { recipe, problems } = parse(markdown);
  if (hasErrors(problems)) return { error: "the customization has problems to fix before its layout can be edited", problems: problems.filter((p) => p.level === "error") };
  if (!Object.hasOwn(PAGE_KEYS, object) && !recipe.workspacePages?.some((p) => p.slug === object)) return { error: "page does not exist" };
  const page = pageOf(recipe, object);
  const present = new Set(page.map((s) => s.component));
  const tree = completeTree(recipe.layouts?.[object], pageKeys(page));
  return {
    object,
    tree,
    ...(tree.style ? { style: tree.style } : {}),
    sections: page.map((s, i): LayoutSection => {
      const actions = s.actions ?? [];
      const asQuery = BLOCKS[s.component].asQuery?.[pageKind(object)];
      const hosts = new Map<string, Panel | undefined>([[s.component, undefined], ...Object.entries(PANELS).filter(([, c]) => c === s.component).map(([p]) => [p, p as Panel] as const)]);
      return {
        ref: refOf(page, i), component: s.component, title: s.title ?? s.component, collapsed: Boolean(s.collapsed), when: (s.when as When | undefined) ?? null,
        ...(s.component === "fields" ? { fields: s.fields } : {}),
        ...("props" in s ? { props: s.props } : {}),
        ...("query" in s ? { query: s.query } : {}),
        ...(asQuery ? { asQuery } : {}),
        actions: actions.map((a) => ({ id: a.id, runs: a.runs, label: a.label, ...(a.labelAfter !== undefined ? { labelAfter: a.labelAfter } : {}), ...(a.panel ? { panel: a.panel } : {}), ...(a.shows !== undefined ? { shows: a.shows } : {}), ...(a.enabled !== undefined ? { enabled: a.enabled } : {}) })),
        addable: BLOCKS[s.component].actions.filter((p) => p.object === pageKind(object) && hosts.has(p.host) && !actions.some((a) => a.runs === p.id && a.panel === hosts.get(p.host)))
          .map((p) => ({ runs: p.id, ...(hosts.get(p.host) ? { panel: hosts.get(p.host) } : {}) })),
      };
    }),
    addable: componentsOf(pageKind(object)).filter((c) => c === "fields" || c === "relatedList" || c === "fieldSection" || c === "relatedRecord" || c === "richText" || !present.has(c)),
  };
}

function writeTree(markdown: string, doc: Doc, object: string, tree: LayoutTree, rootOnly = false): string {
  const fence = doc.fences.find((f) => f.lang === "layout" && (f.head ? objectOf(f.head) : "deal") === object);
  const lines = [...doc.lines];
  const block = ["```layout", ...printLayout(tree).split("\n"), "```"];
  if (fence && rootOnly) {
    const root = lines.findIndex((line, i) => i > fence.at && i < fence.close && line.trim());
    lines[root] = block[1];
  } else if (fence) lines.splice(fence.at, fence.close - fence.at + 1, ...block);
  else {
    const first = doc.heads.find((h) => h.attrs.section && objectOf(h) === object);
    const heading = doc.heads.find((h) => h.attrs.page === object);
    if (!first && !(rootOnly && heading)) throw new Error("page has no sections");
    put(lines, first?.at ?? heading!.at + 1, block);
  }
  return lines.join(doc.eol);
}
function treeEdit(markdown: string, recipe: CompiledRecipe, doc: Doc, object: string, change: (tree: LayoutTree) => void, rootOnly = false): EditResult {
  try {
    const existing = recipe.layouts?.[object];
    const keys = pageKeys(pageOf(recipe, object));
    const source: LayoutTree = rootOnly ? existing ?? { kind: "stack", id: "root", children: [] } : completeTree(existing, keys);
    const tree = structuredClone(source);
    change(tree);
    if (rootOnly && same(existing?.style ?? {}, tree.style)) return { markdown };
    validateTree(tree, keys);
    const next = writeTree(markdown, doc, object, tree, rootOnly);
    const after = parse(next);
    const want = { ...recipe, layouts: { ...recipe.layouts, [object]: tree } };
    if (hasErrors(after.problems) || !same(after.recipe, want)) return { error: "the edit would change more than its tree" };
    return { markdown: next };
  } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
}
function containers(tree: LayoutTree): LayoutTree[] {
  return [tree, ...tree.children.flatMap((n) => "section" in n ? [] : containers(n))];
}
function applyTree(markdown: string, recipe: CompiledRecipe, doc: Doc, op: TreeOp): EditResult {
  if (op.op === "setPageStyle") return treeEdit(markdown, recipe, doc, op.object, (tree) => {
    tree.style = PAGE_STYLE.parse(op.style);
  }, true);
  return treeEdit(markdown, recipe, doc, op.object, (tree) => {
    const all = containers(tree);
    const owner = (key: string) => all.find((c) => c.children.some((n) => "section" in n && n.section === key));
    if (op.op === "wrapSections") {
      const keys = op.sections.map(sectionKey);
      if (!keys.length || new Set(keys).size !== keys.length) throw new Error("pick distinct sections");
      const parent = owner(keys[0]);
      if (!parent || keys.some((key) => owner(key) !== parent)) throw new Error("wrap sections within the same container");
      const first = parent.children.findIndex((n) => "section" in n && keys.includes(n.section));
      parent.children = parent.children.filter((n) => !("section" in n && keys.includes(n.section)));
      const props = CONTAINERS[op.kind].strict().parse(op.props ?? {});
      const group: LayoutTree = { ...props, kind: op.kind, id: op.id, children: keys.map((section) => ({ section })) };
      parent.children.splice(first, 0, group);
    } else {
      const node = all.find((c) => c.id === op.container);
      if (!node) throw new Error("container does not exist");
      if (op.op === "setContainerProps") {
        const props = CONTAINER_PATCHES[node.kind].parse(op.props) as ContainerPropsPatch;
        for (const key of Object.keys(props) as (keyof ContainerPropsPatch)[]) {
          if (props[key] === null) delete node[key];
          else Object.assign(node, { [key]: props[key] });
        }
      } else if (op.op === "unwrap") {
        const parent = all.find((c) => c.children.includes(node));
        if (!parent) throw new Error("cannot unwrap root");
        parent.children.splice(parent.children.indexOf(node), 1, ...node.children);
      } else {
        const key = sectionKey(op.section), parent = owner(key);
        if (!parent) throw new Error("section does not exist");
        parent.children = parent.children.filter((n) => !("section" in n && n.section === key));
        const at = op.before === null ? node.children.length : node.children.findIndex((n) => "section" in n && n.section === sectionKey(op.before!));
        if (at < 0) throw new Error("before must be in the destination container");
        node.children.splice(at, 0, { section: key });
      }
    }
  });
}
function moveInTree(markdown: string, recipe: CompiledRecipe, doc: Doc, op: Extract<LayoutOp, {op: "moveSection"}>): EditResult {
  const tree = completeTree(recipe.layouts?.[op.object], pageKeys(pageOf(recipe, op.object)));
  const parent = containers(tree).find((c) => c.children.some((n) => "section" in n && n.section === sectionKey(op.section)));
  if (!parent) return { error: "section does not exist" };
  if (op.before && sectionKey(op.before) === sectionKey(op.section)) return { markdown };
  return applyTree(markdown, recipe, doc, { ...op, op: "moveIntoContainer", container: parent.id });
}
