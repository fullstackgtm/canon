/**
 * A recipe's `recipe.md` read into the data Canon stores and runs (docs/recipes.md, "Writing a recipe"): the
 * frontmatter, the `## Settings` table, the page's sections, its actions, its prompts, which logic runs each play
 * (a Canon built-in or a name the recipe's TypeScript registers), the plays data and the evals. Every problem comes
 * with its line. Pure and dependency-free, so it runs in a Convex action at install time, in the browser and in Node.
 */
import { themeDeclProblems, type ThemeDecl } from "../theme.ts";
import { DEAL_ROLES } from "../../convex/lib/objects/registry.ts";
import { DEAL_STAGES, PLAY_CHANNELS, type DealStage } from "../../convex/lib/plays/model.ts";
import { REFRESH_CADENCES } from "../../convex/lib/research/runPlan.ts";
import { BINDINGS, KERNEL_ACTIONS, PANELS, actionProblems, isActionId, placements, scopeOf, type Host, type PageAction, type Panel } from "../actions.ts";
import { BUILTINS, RULES, type TableRows } from "../builtins.ts";
import {
  BINDABLE, COMPONENTS, LOGIC_PLAYS, OUTPUTS, PAGE_COMPONENTS, PAGE_OBJECTS, PARTS, PLAY_COMPONENTS, PROMPT_ARITY, PROMPT_PLAYS, RECIPE_FORMAT, RECIPE_OBJECTS, RECIPE_SOURCES, REST_FIELDS, bindingProblems, checkSetting, isComponentOf, resolveData,
  type AnyDescriptor, type BoundData, type LogicPlay, type PageComponent, type PageObject, type PageSection, type PageSpec, type Permissions, type PromptPlay, type Settings,
} from "../kernel.ts";
import type { RecipeEval } from "../evals.ts";
import { AUTO_ACCEPT_RANGE, fieldProblems, type RecipeField } from "../fields.ts";
import { FIT_CHOICES, playsDataErrors } from "../manifest.ts";
import { LEVEL_IDS, MODEL_POINTS, MODEL_POINT_IDS, isModelPoint, type ModelPart, type TableCells } from "../models.ts";
import { POINTS, POINT_IDS, isPointId, pointOf, withImplied, type PointId } from "../points.ts";
import { PLAY_FNS } from "../run.ts";
import { TEMPLATE_KIND_IDS, checkTemplate, type Template } from "../templates.ts";
import { slowPattern } from "../regex.ts";
import { KINDS, NAME, type Kind } from "../sdk.ts";
import { HELPERS, parseTemplate, templateRefs } from "../template.ts";

/** A warning leaves the recipe usable (a field the object lacks is skipped); an error means there is no recipe. */
export type Problem = { line: number; level: "error" | "warning"; message: string };

export type RecipeMeta = {
  id: string;
  version: string;
  title: string;
  description: string;
  author: { org: string; kind: "canon" | "agency" };
  engines: { canon: typeof RECIPE_FORMAT };
  /** The points it contributes to, each found in the body by convention (recipes/points.ts). */
  contributes: PointId[];
  permissions: Permissions;
};

/** What runs a play: a Canon built-in (`canon.keeper`, with its table's configuration) or a name the TypeScript registers. */
export type Source = { kind: Kind; name: string; line: number; config?: unknown };
export type Prompt = { args: string[]; paragraphs: string[] };

/** A recipe as Canon keeps it: plain JSON, so it crosses the wire and embeds in a bundle. */
export type CompiledRecipe = {
  meta: RecipeMeta;
  settingsSchema: AnyDescriptor[];
  defaults: Settings;
  dealPage: PageSpec;
  /** The ```theme block (recipes/theme.ts), its values bound to settings; null for a recipe without one. */
  theme: ThemeDecl | null;
  accountPage: PageSpec;
  contactPage: PageSpec;
  /** What it contributes at each model point, from its {model=<point>} headings. */
  models: Partial<Record<PointId, ModelPart>>;
  /** The rows it offers a workspace to install, one per ```template block (recipes/templates.ts). */
  templates: Template[];
  /** The AI fields it offers, from its ```ai-fields block (recipes/fields.ts). */
  fields: RecipeField[];
  /** The plays data, its values bound to settings; null for a recipe without plays. */
  data: BoundData | null;
  /** Every prompt and partial by id. */
  prompts: Record<string, Prompt>;
  logic: Partial<Record<LogicPlay, Source[]>>;
  evals: RecipeEval[];
  /** The ```ts blocks, compiled with the package's .ts files. */
  code: Array<{ line: number; source: string }>;
};

/** The part of a recipe its play code needs at run time: its prompts and what runs each play. */
export type Runnable = Pick<CompiledRecipe, "prompts" | "logic">;

/** A recipe can run in-process or as a package only once nothing in it is an error. */
export const hasErrors = (problems: readonly Problem[]) => problems.some((p) => p.level === "error");
/** The problems as `file:line: level: message` lines. */
export const formatProblems = (file: string, problems: readonly Problem[]) => problems.map((p) => `${file}:${p.line}: ${p.level}: ${p.message}`);

// ───────────────────────────── Values: YAML's flow and block subsets ─────────────────────────────
//
// Frontmatter is flow only, and every value stays a string: `version: 1.10` is "1.10" and `llm: no` is "no". Fenced
// blocks also nest by indentation (`key:` then indented lines, `- item` lists), and an unquoted true, false, null or
// number is that value, as YAML reads it.

export type Flow = string | number | boolean | null | Flow[] | { [key: string]: Flow };

class ValueError extends Error {
  line: number;
  constructor(message: string, line = 0) { super(message); this.line = line; }
}

const TYPED = (s: string): Flow => (s === "true" ? true : s === "false" ? false : s === "null" ? null : /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : s);

function readFlow(text: string, typed: boolean): Flow {
  let i = 0;
  const space = () => { while (text[i] === " " || text[i] === "\t") i++; };
  const value = (stops: string): Flow => {
    space();
    const c = text[i];
    if (c === "[") {
      i++;
      const out: Flow[] = [];
      space();
      if (text[i] === "]") { i++; return out; }
      for (;;) {
        out.push(value(",]"));
        space();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "]") { i++; return out; }
        throw new ValueError("a list needs , or ]");
      }
    }
    if (c === "{") {
      i++;
      const out: Record<string, Flow> = {};
      space();
      if (text[i] === "}") { i++; return out; }
      for (;;) {
        space();
        const key = /^[\w.-]+/.exec(text.slice(i))?.[0];
        if (!key) throw new ValueError("a map key is a name");
        i += key.length;
        space();
        if (text[i] !== ":") throw new ValueError(`${key} needs a :`);
        i++;
        if (Object.hasOwn(out, key)) throw new ValueError(`${key} is set twice`);
        out[key] = value(",}");
        space();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "}") { i++; return out; }
        throw new ValueError("a map needs , or }");
      }
    }
    if (c === '"' || c === "'") {
      let s = "";
      for (i++; i < text.length; i++) {
        if (text[i] === c) {
          if (c === "'" && text[i + 1] === "'") { s += "'"; i++; continue; }
          i++;
          return s;
        }
        if (c === '"' && text[i] === "\\") {
          const next = text[++i];
          s += next === "n" ? "\n" : next === "t" ? "\t" : next ?? "";
        } else s += text[i];
      }
      throw new ValueError("a quoted value is never closed");
    }
    const start = i;
    while (i < text.length && !stops.includes(text[i])) i++;
    const s = text.slice(start, i).trim();
    if (!s && stops) throw new ValueError("a value is missing");
    return typed ? TYPED(s) : s;
  };
  const out = value("");
  space();
  if (i < text.length) throw new ValueError(`unexpected ${text.slice(i)}`);
  return out;
}

type Line = { text: string; line: number };
const KEY_LINE = /^([A-Za-z_][\w.-]*):(?:[ \t]+(.*))?$/;
const isItem = (t: string) => t === "-" || t.startsWith("- ");

/** A fenced block's value, and the line of each of its top-level keys or items. */
export function readBlock(lines: readonly Line[]): { value: Flow; lines: Map<string | number, number> } {
  const rows = lines.filter((l) => l.text.trim() && !/^\s*#/.test(l.text)).map((l) => {
    if (/^\s*\t/.test(l.text)) throw new ValueError("indent with spaces, not tabs", l.line);
    return { indent: /^ */.exec(l.text)![0].length, text: l.text.trim(), line: l.line };
  });
  const top = new Map<string | number, number>();
  let i = 0;
  const flow = (text: string, line: number) => {
    try { return readFlow(text, true); } catch (e) { throw e instanceof ValueError ? new ValueError(e.message, line) : e; }
  };
  const block = (indent: number, depth: number): Flow => (isItem(rows[i].text) ? seq(indent, depth) : map(indent, depth));
  const map = (indent: number, depth: number): Flow => {
    const out: Record<string, Flow> = {};
    while (i < rows.length && rows[i].indent === indent && !isItem(rows[i].text)) {
      const r = rows[i];
      const m = KEY_LINE.exec(r.text);
      if (!m) throw new ValueError(`expected key: value, not "${r.text}"`, r.line);
      if (Object.hasOwn(out, m[1])) throw new ValueError(`${m[1]} is set twice`, r.line);
      if (depth === 0) top.set(m[1], r.line);
      i++;
      if (m[2] !== undefined && m[2].trim()) out[m[1]] = flow(m[2], r.line);
      else if (i < rows.length && (rows[i].indent > indent || (rows[i].indent === indent && isItem(rows[i].text)))) out[m[1]] = block(rows[i].indent, depth + 1);
      else throw new ValueError(`${m[1]} needs a value`, r.line);
    }
    if (i < rows.length && rows[i].indent > indent) throw new ValueError("this line is indented more than the one above it", rows[i].line);
    return out;
  };
  const seq = (indent: number, depth: number): Flow => {
    const out: Flow[] = [];
    while (i < rows.length && rows[i].indent === indent && isItem(rows[i].text)) {
      const r = rows[i];
      if (depth === 0) top.set(out.length, r.line);
      const rest = r.text.slice(1).trimStart();
      if (!rest) {
        i++;
        if (i >= rows.length || rows[i].indent <= indent) throw new ValueError("a - item needs a value", r.line);
        out.push(block(rows[i].indent, depth + 1));
      } else if (KEY_LINE.test(rest) && !/^["'[{]/.test(rest)) {
        // `- key: value` opens a map whose other keys line up under `key`.
        rows[i] = { indent: indent + r.text.length - rest.length, text: rest, line: r.line };
        out.push(map(rows[i].indent, depth + 1));
      } else {
        i++;
        out.push(flow(rest, r.line));
      }
    }
    return out;
  };
  if (!rows.length) return { value: null, lines: top };
  const value = block(rows[0].indent, 0);
  if (i < rows.length) throw new ValueError("this line is indented less than the block's first line", rows[i].line);
  return { value, lines: top };
}

const isMap = (x: Flow | undefined): x is Record<string, Flow> => typeof x === "object" && x !== null && !Array.isArray(x);

// ───────────────────────────── Frontmatter ─────────────────────────────

const FRONT_KEYS = ["id", "version", "title", "description", "author", "engines", "contributes", "permissions"] as const;
const FIRST_PARTY_ID = /^[a-z][a-z0-9-]{1,62}$/;
const PACKAGE_ID = /^@[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9-]{0,62}$/;
const SEMVER = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

function frontmatter(lines: readonly string[], at: (line: number, message: string) => void): { meta: RecipeMeta; body: number; contributesLine: number } {
  const raw: Record<string, { value: Flow; line: number }> = {};
  let body = 0;
  if (lines[0] !== "---") at(1, "a customization starts with frontmatter between --- lines");
  else {
    const end = lines.indexOf("---", 1);
    if (end < 0) at(1, "the frontmatter is never closed with ---");
    body = end < 0 ? lines.length : end + 1;
    for (let n = 1; n < (end < 0 ? lines.length : end); n++) {
      const l = lines[n];
      if (!l.trim() || /^\s*#/.test(l)) continue;
      const m = /^([a-z][\w-]*):\s*(.*)$/.exec(l);
      if (!m) { at(n + 1, "each frontmatter line is key: value, with lists and maps written inline ([a, b] or { k: v })"); continue; }
      const [, key, text] = m;
      if (!(FRONT_KEYS as readonly string[]).includes(key)) { at(n + 1, `${key} is not a frontmatter key (${FRONT_KEYS.join(", ")}); settings go in a ## Settings table`); continue; }
      if (raw[key]) { at(n + 1, `${key} is set twice`); continue; }
      try {
        raw[key] = { value: readFlow(text, false), line: n + 1 };
      } catch (e) {
        if (!(e instanceof ValueError)) throw e;
        at(n + 1, `${key}: ${e.message}`);
      }
    }
  }
  for (const key of FRONT_KEYS) if (!raw[key] && body) at(1, `the frontmatter needs ${key}`);

  const str = (key: string, ok: (s: string) => boolean, what: string): string => {
    const r = raw[key];
    if (!r) return "";
    if (typeof r.value !== "string" || !ok(r.value)) { at(r.line, `${key} must be ${what}`); return ""; }
    return r.value;
  };
  const map = (key: string): Record<string, Flow> => {
    const r = raw[key];
    if (!r) return {};
    if (!isMap(r.value)) { at(r.line, `${key} must be a map, like { k: v }`); return {}; }
    return r.value;
  };
  const oneOf = <T extends string>(key: string, x: Flow | undefined, values: readonly T[]): T => {
    if (typeof x === "string" && (values as readonly string[]).includes(x)) return x as T;
    at(raw[key]?.line ?? 1, `${key} must be one of ${values.join(", ")}`);
    return values[0];
  };
  const subset = <T extends string>(key: string, x: Flow | undefined, values: readonly T[]): T[] => {
    if (Array.isArray(x) && x.every((v): v is T => typeof v === "string" && (values as readonly string[]).includes(v))) return x;
    at(raw[key]?.line ?? 1, `${key} must be a list of ${values.join(", ")}`);
    return [];
  };
  const orgOf = (x: Flow | undefined): string => {
    if (typeof x === "string" && /^[a-z0-9][a-z0-9-]*$/.test(x)) return x;
    at(raw.author.line, "author.org must be an org name of a-z, 0-9 and -");
    return "";
  };
  const author = map("author"), engines = map("engines"), perms = map("permissions");
  const contributes: PointId[] = [];
  if (raw.contributes) {
    const { value, line } = raw.contributes;
    if (!Array.isArray(value) || !value.length) at(line, `contributes is a list of the points the customization adds to, like [${POINT_IDS[0]}]`);
    else for (const p of value) {
      if (typeof p !== "string" || !isPointId(p)) at(line, `contributes: ${String(p)} is not a point Canon has (${POINT_IDS.join(", ")})`);
      else if (contributes.includes(p)) at(line, `contributes lists ${p} twice`);
      else contributes.push(p);
    }
  }
  const meta: RecipeMeta = {
    id: str("id", (s) => FIRST_PARTY_ID.test(s) || PACKAGE_ID.test(s), "a customization id like canon-base or @agency/customization-name"),
    version: str("version", (s) => SEMVER.test(s), "a version like 1.2.0"),
    title: str("title", (s) => s.length > 0 && s.length <= 80, "text of 1 to 80 characters"),
    description: str("description", (s) => s.length > 0 && s.length <= 600, "text of 1 to 600 characters"),
    author: { org: raw.author ? orgOf(author.org) : "", kind: raw.author ? oneOf("author", author.kind, ["canon", "agency"] as const) : "agency" },
    engines: { canon: raw.engines ? oneOf("engines", engines.canon, [RECIPE_FORMAT] as const) : RECIPE_FORMAT },
    contributes,
    permissions: withImplied({
      read: raw.permissions ? subset("permissions", perms.read, RECIPE_OBJECTS) : [],
      llm: raw.permissions ? oneOf("permissions", perms.llm, ["owner", "none"] as const) : "none",
      sources: raw.permissions ? subset("permissions", perms.sources, RECIPE_SOURCES) : [],
    }, contributes),
  };
  for (const [key, r] of Object.entries(raw)) {
    const known = { author: ["org", "kind"], engines: ["canon"], permissions: ["read", "llm", "sources"] }[key];
    if (known && isMap(r.value)) for (const k of Object.keys(r.value)) if (!known.includes(k)) at(r.line, `${key}.${k} is not a known key${key === "permissions" && k === "slots" ? "; the points a customization fills are its contributes" : ""}`);
  }
  return { meta, body, contributesLine: raw.contributes?.line ?? 1 };
}

/**
 * The format a recipe says it was written for, read before anything else: its frontmatter's `engines: { canon: … }`
 * line, or null when there is none to read.
 */
function formatOf(lines: readonly string[]): { canon: string; line: number } | null {
  if (lines[0] !== "---") return null;
  for (let n = 1; n < lines.length && lines[n] !== "---"; n++) {
    const m = /^engines:\s*(.*)$/.exec(lines[n]);
    if (!m) continue;
    try {
      const v = readFlow(m[1], false);
      return isMap(v) && typeof v.canon === "string" ? { canon: v.canon, line: n + 1 } : null;
    } catch { return null; }
  }
  return null;
}

// ───────────────────────────── Body: headings, fences, tables, prose ─────────────────────────────

const HEADING = /^(#{1,6})\s+(.*?)(?:\s+\{([^}]*)\})?\s*$/;
const FENCE = /^(`{3,})\s*([\w-]*)\s*(.*)$/;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/;
const HEADING_ATTRS: Record<string, readonly string[]> = {
  page: ["page"],
  section: ["section", "when", "collapsed", "show"],
  panel: ["panel"],
  prompt: ["prompt", "args", "kind", "min_confidence", "tool"],
  partial: ["partial"],
  model: ["model"],
};

type Heading = { level: number; title: string; attrs: Record<string, string>; line: number; role: keyof typeof HEADING_ATTRS | null; parent: Heading | null };
type Fence = { lang: string; info: string; lines: Line[]; line: number; heading: Heading | null };
type Table = { header: string[]; rows: Array<{ line: number; cells: string[] }>; line: number; heading: Heading | null };

/** `key=value key2="two words"` from a heading's braces, or the problem with them. */
function attrsOf(text: string): { attrs: Record<string, string>; error?: string } {
  const attrs: Record<string, string> = {};
  const rest = text.replace(/([\w.-]+)=("([^"]*)"|[^\s"]+)/g, (_, key: string, raw: string, quoted?: string) => {
    attrs[key] = quoted ?? raw;
    return "";
  });
  return rest.trim() ? { attrs, error: `can't read "${rest.trim()}": attributes are key=value or key="two words"` } : { attrs };
}

/** `stage = in`, `stage != in`, `stage in [in, case]` or `stage not in [...]`. */
function whenOf(text: string): PageSection["when"] | null {
  const m = /^stage\s*(=|!=|in|not in)\s*(\[[\w,\s]*\]|\w+)$/.exec(text.trim());
  const stages = m?.[2].replace(/[[\]]/g, "").split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  if (!m || !stages.length || !stages.every((s) => (DEAL_STAGES as readonly string[]).includes(s))) return null;
  return m[1] === "=" || m[1] === "in" ? { stage: stages as DealStage[] } : { notStage: stages as DealStage[] };
}

/** A table row's cells, `\|` read as a pipe inside a cell. */
const cellsOf = (row: string) => row.trim().replace(/^\|/, "").replace(/(?<!\\)\|\s*$/, "").split(/(?<!\\)\|/).map((c) => c.trim().replaceAll("\\|", "|"));
const SEPARATOR = /^\|?(\s*:?-{3,}:?\s*\|)*\s*:?-{3,}:?\s*\|?$/;
/** A cell's value without the backticks around it. */
const unticked = (c: string) => (/^`[^`]*`$/.test(c) ? c.slice(1, -1) : c);

// ───────────────────────────── Settings ─────────────────────────────

const SETTING_COLUMNS = ["setting", "kind", "default", "limits", "group", "label", "help"];
const SETTING_KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
export const KIND_LIMITS: Record<AnyDescriptor["kind"], string> = {
  int: "<min> to <max>",
  number: "<min> to <max> by <step>",
  roles: `the roles to choose from (${DEAL_ROLES.join(", ")})`,
  channels: `the channels to choose from (${PLAY_CHANNELS.join(", ")})`,
  phrases: "up to <n> characters",
  text: "<min> to <max> characters",
  color: "any",
  choice: "the options, comma-separated",
  bool: "true or false",
  rules: "the audit rules to choose from, comma-separated",
  ints: "<min> to <max>, up to <n> values",
  levels: `the levels to choose from (${LEVEL_IDS.join(", ")})`,
};
const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

/** A settings table's rows, added to `schema` and `defaults`: a recipe's Settings table, then each model point's. */
function settingsOf(table: Table, at: (line: number, message: string) => void, schema: AnyDescriptor[] = [], defaults: Record<string, Settings[string]> = {}): { schema: AnyDescriptor[]; defaults: Record<string, Settings[string]> } {
  if (table.header.map((h) => h.toLowerCase()).join("|") !== SETTING_COLUMNS.join("|")) {
    at(table.line, `the Settings table's columns are ${SETTING_COLUMNS.map((c) => c[0].toUpperCase() + c.slice(1)).join(", ")}`);
    return { schema, defaults };
  }
  for (const { line, cells } of table.rows) {
    const [key, kind, rawDefault, limits, group, label, help] = cells.map(unticked);
    const no = (message: string) => { at(line, `setting ${key || "(no key)"}: ${message}`); };
    if (!SETTING_KEY.test(key)) { no("a key is letters, digits and _, starting with a letter"); continue; }
    if (schema.some((d) => d.key === key)) { no("is in the table twice"); continue; }
    if (!Object.hasOwn(KIND_LIMITS, kind)) { no(`kind must be one of ${Object.keys(KIND_LIMITS).join(", ")}`); continue; }
    if (!label) { no("needs a label"); continue; }
    if (!group) { no("needs a group"); continue; }
    const about = { key, label, help, group };
    let d: AnyDescriptor | null = null;
    let m: RegExpExecArray | null;
    const k = kind as AnyDescriptor["kind"];
    if (k === "int" && (m = /^(-?\d+) to (-?\d+)$/.exec(limits))) d = { ...about, kind: k, min: Number(m[1]), max: Number(m[2]) };
    else if (k === "number" && (m = /^(-?\d+(?:\.\d+)?) to (-?\d+(?:\.\d+)?) by (\d+(?:\.\d+)?)$/.exec(limits))) d = { ...about, kind: k, min: Number(m[1]), max: Number(m[2]), step: Number(m[3]) };
    else if (k === "roles" && list(limits).length && list(limits).every((r) => (DEAL_ROLES as readonly string[]).includes(r))) d = { ...about, kind: k, options: list(limits) as never };
    else if (k === "channels" && list(limits).length && list(limits).every((c) => (PLAY_CHANNELS as readonly string[]).includes(c))) d = { ...about, kind: k, options: list(limits) as never };
    else if (k === "phrases" && (m = /^up to (\d+) characters$/.exec(limits))) d = { ...about, kind: k, maxLength: Number(m[1]) };
    else if (k === "text" && (m = /^(\d+) to (\d+) characters$/.exec(limits))) d = { ...about, kind: k, minLength: Number(m[1]), maxLength: Number(m[2]) };
    else if (k === "color" && limits === "any") d = { ...about, kind: k };
    else if (k === "choice" && list(limits).length) d = { ...about, kind: k, options: list(limits) };
    else if (k === "bool" && limits === "true or false") d = { ...about, kind: k };
    else if (k === "rules" && list(limits).length && list(limits).every((r) => /^[a-z][a-z0-9-]{0,59}$/.test(r))) d = { ...about, kind: k, options: list(limits) };
    else if (k === "levels" && list(limits).length && list(limits).every((l) => LEVEL_IDS.includes(l))) d = { ...about, kind: k, options: list(limits) };
    else if (k === "ints" && (m = /^(-?\d+) to (-?\d+), up to (\d+) values$/.exec(limits))) d = { ...about, kind: k, min: Number(m[1]), max: Number(m[2]), maxItems: Number(m[3]) };
    if (!d) { no(`the limits of a ${kind} setting are ${KIND_LIMITS[k]}, not "${limits}"`); continue; }
    const [lo, hi] = d.kind === "text" ? [d.minLength, d.maxLength] : d.kind === "int" || d.kind === "number" || d.kind === "ints" ? [d.min, d.max] : [0, 0];
    if (lo > hi) { no("its limits run from high to low"); continue; }
    const value = k === "int" || k === "number" ? (/^-?\d+(\.\d+)?$/.test(rawDefault) ? Number(rawDefault) : NaN)
      : k === "roles" || k === "channels" || k === "rules" || k === "levels" ? list(rawDefault)
      : k === "ints" ? list(rawDefault).map((x) => (/^-?\d+$/.test(x) ? Number(x) : NaN)) : k === "bool" ? (rawDefault === "true" ? true : rawDefault === "false" ? false : rawDefault) : rawDefault;
    const checked = checkSetting(d, value);
    if (!checked.ok) { no(`the default must be ${checked.error}`); continue; }
    if (d.kind === "phrases" && slowPattern(String(checked.value))) { no("the default takes too long on a long draft"); continue; }
    schema.push(d);
    defaults[key] = checked.value;
  }
  return { schema, defaults };
}

// ───────────────────────────── The parser ─────────────────────────────

const PEOPLE_KEYS = ["fields", "refresh", "everyDays", "buyers"];
const PEOPLE_FIELD_KEYS = ["slug", "label", "answer", "question", "role", "judgment", "replaces"];
/** A people field the ```ai-fields block declares is named here by its slug, with the role people research reads it for. */
const PEOPLE_REF_KEYS = ["slug", "role"];
const AI_FIELD_KEYS = ["slug", "label", "object", "kind", "question", "options", "answer", "judgment", "refresh", "autoAccept", "replaces"];
const DATA_KEYS = ["terms", "qualification", "coreRoles", "quietDays", "drafts", "research"];
const EVAL_KEYS = ["name", "description", "call", "expect"];
const ACTION_KEYS = ["id", "label", "label_after", "runs", "prompt", "prompts", "review", "input", "writes", "fields", "shows", "enabled", "llm", "gate", "done", "note"];
const ACTION_ID = /^[a-z][A-Za-z0-9]{0,39}$/;
const PLAYS_FENCES = ["stages", "data", "people"];
const KNOWN_FENCES = ["fields", "action", "logic", "evals", "ts", "choices", "schema", "output", "theme", "template", "ai-fields", ...PLAYS_FENCES];
const TEMPLATE_ATTRS = ["kind", "key"];
/** Questions Jev answers rather than prompts a model is sent: the remit (people.center) and the buyer fit (people.fit). */
const JEV_PROMPTS = ["people.center", "people.fit"];

/**
 * The recipe `source` describes. With `objectFields` (the api names of each object whose page it lays out), a field
 * the object doesn't have is a warning: the page skips it, so a recipe written for one workspace still opens in another.
 */
export function parseRecipe(source: string, opts: { objectFields?: Partial<Record<PageObject, readonly string[]>> } = {}): { recipe: CompiledRecipe; problems: Problem[] } {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const problems: Problem[] = [];
  const at = (line: number, message: string, level: Problem["level"] = "error") => { problems.push({ line, level, message }); };
  // Another format's grammar differs, so its recipe gets this one line rather than an error for every difference.
  const format = formatOf(lines);
  if (format && format.canon !== RECIPE_FORMAT) {
    const message = `written for customization format ${format.canon}; this Canon reads format ${RECIPE_FORMAT} (what changed: "Format changelog" in Canon's docs/recipes.md)`;
    const recipe: CompiledRecipe = { meta: frontmatter(lines, () => {}).meta, settingsSchema: [], defaults: {}, dealPage: [], theme: null, accountPage: [], contactPage: [], models: {}, templates: [], fields: [], data: null, prompts: {}, logic: {}, evals: [], code: [] };
    return { recipe, problems: [{ line: format.line, level: "error", message }] };
  }
  const { meta, body, contributesLine } = frontmatter(lines, at);

  // One pass: each heading, fence, table and prose line, under the heading it sits beneath.
  const headings: Heading[] = [];
  const fences: Fence[] = [];
  const tables: Table[] = [];
  const prose = new Map<Heading, Line[]>();
  let current: Heading | null = null;
  for (let n = body; n < lines.length; n++) {
    const fence = FENCE.exec(lines[n]);
    if (fence) {
      const start = n;
      const close = new RegExp(`^${fence[1]}\\s*$`);
      const block: Line[] = [];
      for (n++; n < lines.length && !close.test(lines[n]); n++) block.push({ text: lines[n], line: n + 1 });
      if (n >= lines.length) at(start + 1, "this fenced block is never closed");
      fences.push({ lang: fence[2], info: fence[3].trim(), lines: block, line: start + 1, heading: current });
      continue;
    }
    const h = HEADING.exec(lines[n]);
    if (h) {
      const level = h[1].length;
      let parent = current as Heading | null;
      while (parent && parent.level >= level) parent = parent.parent;
      const { attrs, error } = h[3] === undefined ? { attrs: {} } : attrsOf(h[3]);
      if (error) at(n + 1, error);
      const roles = Object.keys(HEADING_ATTRS).filter((r) => attrs[r] !== undefined) as Array<keyof typeof HEADING_ATTRS>;
      if (roles.length > 1) at(n + 1, `a heading is one of ${roles.map((r) => `${r}=`).join(" or ")}, not both`);
      if (h[3] !== undefined && !roles.length && !error) at(n + 1, "a heading's braces name a page=, section=, panel=, prompt=, partial= or model=");
      const role = roles[0] ?? null;
      if (role) for (const k of Object.keys(attrs)) if (!HEADING_ATTRS[role].includes(k)) at(n + 1, `${k}= doesn't go with ${role}= (${HEADING_ATTRS[role].join(", ")})`);
      current = { level, title: h[2].trim(), attrs, line: n + 1, role, parent };
      headings.push(current);
      continue;
    }
    const inPrompt = current?.role === "prompt" || current?.role === "partial";
    if (!inPrompt && lines[n].startsWith("|")) {
      const start = n;
      const rows: string[] = [];
      for (; n < lines.length && lines[n].startsWith("|"); n++) rows.push(lines[n]);
      n--;
      if (rows.length < 2 || !SEPARATOR.test(rows[1].trim())) { at(start + 1, "a table needs a header row, then a row of ---"); continue; }
      const header = cellsOf(rows[0]);
      tables.push({ header, line: start + 1, heading: current, rows: rows.slice(2).map((r, i) => ({ line: start + 3 + i, cells: cellsOf(r) })) });
      continue;
    }
    if (current) prose.set(current, [...(prose.get(current) ?? []), { text: lines[n], line: n + 1 }]);
  }
  const enclosing = (h: Heading | null, role: Heading["role"]): Heading | null => { for (let x = h; x; x = x.parent) if (x.role === role) return x; return null; };
  const blockOf = (f: Fence) => {
    try { return readBlock(f.lines); } catch (e) {
      if (!(e instanceof ValueError)) throw e;
      at(e.line || f.line, `${f.lang}: ${e.message}`);
      return null;
    }
  };
  for (const f of fences) if (f.lang && !KNOWN_FENCES.includes(f.lang)) at(f.line, `\`\`\`${f.lang} is not a customization block (${KNOWN_FENCES.join(", ")}); a code sample with no language is fine`, "warning");

  // ── Settings ──
  const settingsHeading = headings.find((h) => h.title === "Settings" && !h.role);
  const settingsTable = settingsHeading && tables.find((t) => t.heading === settingsHeading);
  if (settingsHeading && !settingsTable) at(settingsHeading.line, "the Settings section needs its table");
  const { schema: settingsSchema, defaults } = settingsTable ? settingsOf(settingsTable, at) : { schema: [], defaults: {} };

  // ── Model points: a {model=<point>} heading holds the settings the point reads and its built-in tables ──
  const models: Partial<Record<PointId, ModelPart>> = {};
  const modelLines = new Map<PointId, number>();
  const isSettingsTable = (t: Table) => t.header.map((h) => h.toLowerCase()).join("|") === SETTING_COLUMNS.join("|");
  for (const h of headings.filter((x) => x.role === "model")) {
    const id = h.attrs.model;
    if (!isModelPoint(id)) { at(h.line, `model=${id} is not a model point (${MODEL_POINT_IDS.join(", ")})`); continue; }
    if (models[id]) { at(h.line, `${id} has a second {model=${id}} heading (the first is on line ${modelLines.get(id)})`); continue; }
    const point = MODEL_POINTS[id];
    const tablesHere: Record<string, TableCells> = {};
    for (const t of tables.filter((x) => enclosing(x.heading, "model") === h)) {
      if (isSettingsTable(t)) { settingsOf(t, at, settingsSchema, defaults); continue; }
      const cols = t.header.map((c) => c.toLowerCase());
      const name = Object.keys(point.tables).find((n) => point.tables[n].columns.join("|") === cols.join("|"));
      const named = Object.entries(point.tables).map(([n, x]) => `${n} (${x.columns.join(", ")})`);
      if (!name) { at(t.line, `the ${point.title} model reads ${named.length ? named.join(" and ") : "only its settings table"}; this table's columns are ${t.header.join(", ")}`); continue; }
      if (tablesHere[name]) { at(t.line, `${point.title} has a second ${name} table`); continue; }
      const rows = t.rows.map((r) => ({ line: r.line, cells: Object.fromEntries(cols.map((c, i) => [c, r.cells[i] ?? ""])) }));
      if (!rows.length) at(t.line, `the ${name} table has no rows`);
      point.tables[name].configure(rows, (message, line) => at(line ?? t.line, `${name}: ${message}`));
      tablesHere[name] = rows.map((r) => r.cells);
    }
    models[id] = { tables: tablesHere };
    modelLines.set(id, h.line);
  }
  const settingByKey = new Map(settingsSchema.map((d) => [d.key, d]));

  // ── Pages: the sections under a {page=<object>} heading lay out that object's page, and any others the deal's ──
  for (const h of headings.filter((x) => x.role === "page")) {
    if (!(PAGE_OBJECTS as readonly string[]).includes(h.attrs.page)) at(h.line, `page=${h.attrs.page} is not a page a customization lays out (${PAGE_OBJECTS.join(", ")})`);
    if (enclosing(h.parent, "page") || enclosing(h.parent, "section")) at(h.line, "a {page=…} heading sits above its sections, not under another page or section");
  }
  const objectOf = (h: Heading): PageObject => {
    const page = enclosing(h, "page")?.attrs.page;
    return (PAGE_OBJECTS as readonly string[]).includes(page ?? "") ? (page as PageObject) : "deal";
  };

  // ── Sections ──
  type Open = { section: PageSection; object: PageObject; line: number; fieldsLine: number | null; heading: Heading };
  const sections: Open[] = [];
  for (const h of headings.filter((x) => x.role === "section")) {
    const component = h.attrs.section;
    const object = objectOf(h);
    if (!isComponentOf(object, component)) {
      const elsewhere = (PAGE_COMPONENTS as readonly string[]).includes(component) ? `; ${component} sits on the ${PAGE_OBJECTS.filter((o) => isComponentOf(o, component)).join(" and ")} page` : "";
      at(h.line, `section=${component} is not a component of the ${object} page (${COMPONENTS[object].join(", ")})${elsewhere}`);
      continue;
    }
    const section = { component: component as PageComponent, title: h.title, ...(component === "fields" ? { fields: [] } : {}) } as PageSection;
    if (h.attrs.when !== undefined && object !== "deal") at(h.line, "when= picks a deal's stages, so it is only for sections of the deal page");
    else if (h.attrs.when !== undefined) {
      const when = whenOf(h.attrs.when);
      if (when) section.when = when;
      else at(h.line, `when="${h.attrs.when}" must be stage = <${DEAL_STAGES.join("|")}>, stage != …, or stage in [ … ]`);
    }
    if (h.attrs.collapsed !== undefined) {
      if (h.attrs.collapsed === "true") section.collapsed = true;
      else if (h.attrs.collapsed !== "false") at(h.line, "collapsed= is true or false");
    }
    if (h.attrs.show !== undefined) {
      const parts = PARTS[component as PageComponent];
      const named = h.attrs.show.split(",").map((x) => x.trim()).filter(Boolean);
      if (!parts) at(h.line, `show= picks a component's parts, and ${component} has none to pick`);
      else if (named.some((x) => !parts.includes(x))) at(h.line, `show= names ${component}'s parts: ${parts.join(", ")}`);
      else section.show = parts.filter((x) => named.includes(x));
    }
    if (!h.title) at(h.line, "a section needs a title");
    sections.push({ section, object, line: h.line, fieldsLine: null, heading: h });
  }
  for (const f of fences.filter((x) => x.lang === "fields")) {
    const open = sections.find((s) => s.heading === f.heading);
    // Under a section heading that was refused, the heading's own problem says enough.
    if (!open) { if (f.heading?.role !== "section") at(f.line, "a ```fields block sits under a {section=fields} heading"); continue; }
    if (open.section.component !== "fields") { at(f.line, `a ${open.section.component} section takes no fields block`); continue; }
    if (open.fieldsLine !== null) { at(f.line, `section ${open.section.title} has a second fields block (the first is on line ${open.fieldsLine})`); continue; }
    open.fieldsLine = f.line;
    const names: string[] = [];
    for (const l of f.lines) {
      for (const name of list(l.text)) {
        if (!FIELD_NAME.test(name)) { at(l.line, `${name} is not a field name`); continue; }
        // Kept in the page: another workspace's object may have it, and the page skips it where it's missing.
        const known = opts.objectFields?.[open.object];
        if (name !== REST_FIELDS && known && !known.includes(name)) at(l.line, `${name} is not a field of the ${open.object} object; the page skips it`, "warning");
        names.push(name);
      }
    }
    open.section = { ...open.section, fields: names } as PageSection;
  }
  for (const s of sections) if (s.section.component === "fields" && s.fieldsLine === null) at(s.line, `section ${s.section.title} needs a \`\`\`fields block naming its fields`);

  // ── Prompts ──
  const prompts: Record<string, Prompt> = {};
  const promptLines = new Map<string, number>();
  for (const h of headings.filter((x) => x.role === "prompt" || x.role === "partial")) {
    const id = h.attrs.prompt ?? h.attrs.partial;
    if (Object.hasOwn(prompts, id)) { at(h.line, `prompt ${id} is written twice (also line ${promptLines.get(id)})`); continue; }
    if (h.role === "prompt" && !(PROMPT_PLAYS as readonly string[]).includes(id) && !JEV_PROMPTS.includes(id)) { at(h.line, `prompt=${id} is not a prompt Canon sends (${[...PROMPT_PLAYS, ...JEV_PROMPTS].join(", ")})`); continue; }
    if (h.role === "partial" && !/^[a-z][\w-]*(\.[\w-]+)+$/.test(id)) { at(h.line, `partial=${id} is a dotted name, like shape.email`); continue; }
    const arity = h.role === "prompt" && !JEV_PROMPTS.includes(id) ? PROMPT_ARITY[id as PromptPlay] : 1;
    const args = (h.attrs.args ?? "_").split(",").map((x) => x.trim());
    if (args.length !== arity || !args.every((a) => a === "_" || /^[a-z]\w*$/.test(a))) at(h.line, `prompt ${id} takes ${arity} argument${arity === 1 ? "" : "s"}: args="${Array.from({ length: arity }, (_, i) => (i ? `arg${i + 1}` : "_")).join(", ")}", where _ spreads the first one's fields`);
    if (h.attrs.kind !== undefined && !(JEV_PROMPTS.includes(id) && h.attrs.kind === "jev")) at(h.line, `kind=jev is only for prompt=${JEV_PROMPTS.join(" or prompt=")}`);
    if (h.attrs.min_confidence !== undefined && id !== "people.center") at(h.line, "min_confidence= is only for prompt=people.center");
    if (h.attrs.tool !== undefined && id !== "people.capability.prompt") at(h.line, "tool= is only for prompt=people.capability.prompt");
    const paragraphs: Line[][] = [];
    for (const l of prose.get(h) ?? []) {
      if (!l.text.trim()) { if (paragraphs.at(-1)?.length) paragraphs.push([]); continue; }
      if (!paragraphs.length) paragraphs.push([]);
      paragraphs.at(-1)!.push(l);
    }
    const kept = paragraphs.filter((p) => p.length);
    if (!kept.length) at(h.line, `prompt ${id} has no text`);
    for (const p of kept) {
      const parsed = parseTemplate(p.map((l) => l.text).join("\n"));
      if ("error" in parsed) {
        const before = p.map((l) => l.text).join("\n").slice(0, parsed.error.offset).split("\n").length - 1;
        at(p[0].line + before, `prompt ${id}: ${parsed.error.message}`);
        continue;
      }
      for (const name of templateRefs(parsed.nodes).helpers) if (!Object.hasOwn(HELPERS, name)) at(p[0].line, `prompt ${id}: {{${name} …}} names no helper (${Object.keys(HELPERS).join(", ")})`);
    }
    prompts[id] = { args, paragraphs: kept.map((p) => p.map((l) => l.text).join("\n").trim()) };
    promptLines.set(id, h.line);
  }
  for (const [id, p] of Object.entries(prompts)) {
    for (const src of p.paragraphs) {
      const parsed = parseTemplate(src);
      if ("error" in parsed) continue;
      for (const name of templateRefs(parsed.nodes).partials) if (!Object.keys(prompts).some((x) => x.startsWith(`${name}.`) || x === name)) at(promptLines.get(id)!, `prompt ${id}: {{> ${name}}} names no partial`);
    }
  }

  // A partial under a {model=…} heading is that model's prose, read by the point rather than by a prompt.
  for (const h of headings.filter((x) => x.role === "partial" && Object.hasOwn(prompts, x.attrs.partial))) {
    const model = enclosing(h.parent, "model");
    const part = model && isModelPoint(model.attrs.model) ? models[model.attrs.model] : undefined;
    if (!part) continue;
    part.prose = { ...part.prose, [h.attrs.partial]: prompts[h.attrs.partial].paragraphs };
    delete prompts[h.attrs.partial];
  }

  // ── Logic: which built-in or registered name runs each play ──
  const logic: Partial<Record<LogicPlay, Source[]>> = {};
  for (const f of fences.filter((x) => x.lang === "logic")) {
    for (const l of f.lines) {
      if (!l.text.trim() || /^\s*#/.test(l.text)) continue;
      const m = /^\s*([\w.]+):\s*(.+)$/.exec(l.text);
      if (!m) { at(l.line, "a logic line is <play>: <kind> <name>, like keeper: rule canon.keeper"); continue; }
      const play = m[1] as LogicPlay;
      if (!Object.hasOwn(LOGIC_PLAYS, play)) { at(l.line, `${m[1]} is not a play logic runs (${Object.keys(LOGIC_PLAYS).join(", ")}); prompts are {prompt=…} headings`); continue; }
      if (logic[play]) { at(l.line, `${play} is bound twice (also line ${logic[play]![0].line})`); continue; }
      const want = LOGIC_PLAYS[play];
      const sources: Source[] = [];
      for (const part of m[2].split(",").map((x) => x.trim())) {
        const s = /^(\w+)\s+((?:canon\.)?\w+)$/.exec(part);
        if (!s || !(KINDS as readonly string[]).includes(s[1])) { at(l.line, `"${part}" must be <kind> <name> with a kind of ${KINDS.join(", ")}`); continue; }
        if (s[1] !== want) { at(l.line, `${play} runs a ${want}, not a ${s[1]}`); continue; }
        const source: Source = { kind: want, name: s[2], line: l.line };
        if (s[2].startsWith("canon.")) {
          const b = Object.hasOwn(BUILTINS, s[2]) ? BUILTINS[s[2]] : undefined;
          if (!b) { at(l.line, `${s[2]} is not a Canon built-in (${Object.keys(BUILTINS).join(", ")})`); continue; }
          if (b.play !== play) { at(l.line, `${s[2]} runs ${b.play}, not ${play}`); continue; }
          for (const [key, kinds] of Object.entries(b.settings)) {
            const d = settingByKey.get(key);
            if (!d || !kinds.includes(d.kind)) at(l.line, `${s[2]} reads the ${kinds.join(" or ")} setting ${key}, which ${d ? `is ${d.kind}` : "the Settings table doesn't have"}`);
          }
          if (b.table && b.configure) {
            const cols = b.table;
            const t = tables.find((x) => x.heading === f.heading && x.header.map((c) => c.toLowerCase()).join("|") === cols.join("|"));
            if (!t) { at(l.line, `${s[2]} reads a table with the columns ${cols.map((c) => c[0].toUpperCase() + c.slice(1)).join(", ")} in this section`); continue; }
            const rows: TableRows = t.rows.map((r) => ({ line: r.line, cells: Object.fromEntries(cols.map((c, i) => [c, r.cells[i] ?? ""])) }));
            if (!rows.length) at(t.line, `${s[2]}'s table has no rows`);
            source.config = b.configure(rows, settingByKey, (message, line) => at(line ?? t.line, message));
          }
        } else if (!NAME.test(s[2])) { at(l.line, `${s[2]}: a name is letters, digits and _`); continue; }
        sources.push(source);
      }
      if (sources.length > 1 && want !== "check") at(l.line, `${play} runs one ${want}; only checks combine`);
      if (sources.length) logic[play] = sources;
    }
  }

  const one = (lang: string) => {
    const all = fences.filter((f) => f.lang === lang);
    if (all.length > 1) at(all[1].line, `a customization has one \`\`\`${lang} block (the first is on line ${all[0].line})`);
    return all[0];
  };

  // ── AI fields: one ```ai-fields block, a list of fields (recipes/fields.ts) ──
  const aiFence = one("ai-fields");
  const aiRead = aiFence && blockOf(aiFence);
  const aiRaw = aiRead ? aiRead.value : undefined;
  const aiFields: RecipeField[] = [];
  if (aiFence && aiRead && !Array.isArray(aiRaw)) at(aiFence.line, "ai-fields: a list of - slug: … items");
  if (aiFence && aiRead && Array.isArray(aiRaw)) aiRaw.forEach((item, i) => {
    const line = aiRead.lines.get(i) ?? aiFence.line;
    if (!isMap(item)) return at(line, `ai-fields: each item is a field (${AI_FIELD_KEYS.join(", ")})`);
    const name = typeof item.slug === "string" ? item.slug : `item ${i + 1}`;
    const unknown = Object.keys(item).filter((k) => !AI_FIELD_KEYS.includes(k));
    if (unknown.length) return at(line, `ai-fields ${name}: ${unknown.join(", ")} ${unknown.length > 1 ? "are not keys" : "is not a key"} (${AI_FIELD_KEYS.join(", ")})`);
    if (aiFields.some((f) => f.slug === item.slug)) return at(line, `ai-fields: ${name} is there twice`);
    const { answer, ...rest } = item;
    const field = { ...rest, ...(answer === undefined ? {} : { answerType: answer }) };
    const errors = fieldProblems(field, settingsSchema);
    for (const e of errors) at(line, `ai-fields ${name}: ${e}`);
    if (!errors.length) aiFields.push(field as unknown as RecipeField);
  });
  const aiField = (slug: unknown) => aiFields.find((f) => f.slug === slug);

  // ── Plays data: stages, bindings, people research ──
  const hasPlays = Object.keys(logic).length > 0 || PROMPT_PLAYS.some((p) => Object.hasOwn(prompts, p));
  const [stagesFence, dataFence, peopleFence] = PLAYS_FENCES.map(one);
  let data: BoundData | null = null;
  if (hasPlays) {
    for (const fn of Object.keys(LOGIC_PLAYS) as LogicPlay[]) if (!logic[fn]) at(1, `a customization with plays binds ${fn} in a \`\`\`logic block`);
    for (const fn of PROMPT_PLAYS) if (!Object.hasOwn(prompts, fn)) at(1, `a customization with plays writes the ${fn} prompt under a {prompt=${fn}} heading`);
    for (const [lang, f] of [["stages", stagesFence], ["data", dataFence], ["people", peopleFence]] as const) if (!f) at(1, `a customization with plays has a \`\`\`${lang} block`);
    const stagesRaw = stagesFence && blockOf(stagesFence)?.value;
    const dataRaw = dataFence && blockOf(dataFence)?.value;
    const peopleRaw = peopleFence && blockOf(peopleFence)?.value;
    const stages = {} as Record<DealStage, { label: string; exit: string }>;
    if (stagesFence && isMap(stagesRaw)) {
      for (const k of Object.keys(stagesRaw)) if (!(DEAL_STAGES as readonly string[]).includes(k)) at(stagesFence.line, `stages: ${k} is not a stage (${DEAL_STAGES.join(", ")})`);
      for (const s of DEAL_STAGES) {
        const v = stagesRaw[s];
        if (!isMap(v) || typeof v.label !== "string" || typeof v.exit !== "string") at(stagesFence.line, `stages: ${s} needs a label and an exit`);
        else stages[s] = { label: v.label, exit: v.exit };
      }
    } else if (stagesFence && stagesRaw !== undefined) at(stagesFence.line, "stages: each stage is a line like in: { label: …, exit: … }");
    const headingOf = (prompt: string) => headings.find((h) => h.attrs.prompt === prompt);
    /** A Jev prompt's question: its prose and its ```choices, with exactly `want` when the kernel reads the choice. */
    const jev = (prompt: string, why: string, want?: readonly string[]) => {
      const h = headingOf(prompt);
      const choices = h && fences.find((f) => f.heading === h && f.lang === "choices");
      if (!h || h.attrs.kind !== "jev" || !choices) { at(h?.line ?? 1, `${why} asks Jev a {prompt=${prompt} kind=jev} question with a \`\`\`choices block`); return { type: "choice", instructions: "", criteria: {} }; }
      const criteria = blockOf(choices)?.value;
      if (!(isMap(criteria) && Object.values(criteria).every((x) => typeof x === "string"))) at(choices.line, "choices: each line is <choice>: <what it means>");
      else if (want && Object.keys(criteria).sort().join() !== [...want].sort().join()) at(choices.line, `choices: ${prompt} chooses ${want.join(", ")}, which the kernel reads`);
      return { type: "choice", instructions: (prompts[prompt]?.paragraphs ?? []).join("\n\n"), criteria: isMap(criteria) ? criteria : {} };
    };
    const center = headingOf("people.center");
    const capability = headingOf("people.capability.prompt");
    const schemaFence = capability && fences.find((f) => f.heading === capability && f.lang === "schema");
    if (!capability?.attrs.tool || !schemaFence) at(capability?.line ?? 1, "the capability prompt names its tool= and has a ```schema block");
    const toolSchema = schemaFence && blockOf(schemaFence)?.value;
    if (schemaFence && !isMap(toolSchema)) at(schemaFence.line, "schema: a JSON schema written as a block");
    /** What a prompt's ```output block says each field of the model's answer holds: exactly the fields the kernel stores. */
    const output = (prompt: keyof typeof OUTPUTS): Record<string, string> => {
      const h = headingOf(prompt);
      const f = h && fences.find((x) => x.heading === h && x.lang === "output");
      const want: readonly string[] = OUTPUTS[prompt];
      if (!f) { if (h) at(h.line, `prompt ${prompt} has an \`\`\`output block describing ${want.join(", ")}`); return {}; }
      const value = blockOf(f)?.value;
      if (!isMap(value) || Object.keys(value).sort().join() !== [...want].sort().join() || !Object.values(value).every((x) => typeof x === "string" && x.trim())) {
        at(f.line, `output: one line per field, ${want.map((k) => `${k}: <what it holds>`).join(", ")}`);
        return {};
      }
      for (const [k, text] of Object.entries(value) as Array<[string, string]>) {
        const parsed = parseTemplate(text);
        if ("error" in parsed) at(f.line, `output ${k}: ${parsed.error.message}`);
        else for (const name of templateRefs(parsed.nodes).helpers) if (!Object.hasOwn(HELPERS, name)) at(f.line, `output ${k}: {{${name} …}} names no helper (${Object.keys(HELPERS).join(", ")})`);
      }
      return value as Record<string, string>;
    };
    const fieldsRaw = isMap(peopleRaw) ? peopleRaw.fields : undefined;
    const fields = Array.isArray(fieldsRaw) ? fieldsRaw.filter(isMap) : [];
    if (peopleFence && (!isMap(peopleRaw) || !Array.isArray(fieldsRaw) || fields.length !== fieldsRaw.length || !fields.length)) at(peopleFence.line, "people: fields is a list of { slug, role } naming an ai-fields field, or { slug, label, answer, question, role }");
    for (const k of isMap(peopleRaw) ? Object.keys(peopleRaw) : []) if (!PEOPLE_KEYS.includes(k)) at(peopleFence!.line, `people: ${k} is not a key (${PEOPLE_KEYS.join(", ")})`);
    const refresh = isMap(peopleRaw) ? (peopleRaw.refresh ?? "monthly") : "monthly";
    if (typeof refresh !== "string" || !(REFRESH_CADENCES as readonly string[]).includes(refresh)) at(peopleFence?.line ?? 1, `people: refresh must be one of ${REFRESH_CADENCES.join(", ")}`);
    const slug = (role: string) => String(fields.find((f) => f.role === role)?.slug ?? "");
    if (peopleFence) for (const role of ["employed", "goal", "systems"]) if (!slug(role)) at(peopleFence.line, `people: one field has role: ${role}`);
    for (const f of fields) {
      const ai = aiField(f.slug);
      if (ai) {
        for (const k of Object.keys(f)) if (!PEOPLE_REF_KEYS.includes(k)) at(peopleFence!.line, `people: field ${ai.slug} is written in the ai-fields block; here it takes only ${PEOPLE_REF_KEYS.join(" and ")}`);
        if (ai.object !== "contact" || ai.kind !== "qa" || !["text", "boolean"].includes(ai.answerType ?? "text")) at(peopleFence!.line, `people: field ${ai.slug} must ask about contacts (object: contact, kind: qa) with a text or boolean answer`);
        continue;
      }
      if (!["text", "boolean"].includes(String(f.answer))) at(peopleFence!.line, `people: field ${String(f.slug)}'s answer is text or boolean`);
      for (const k of Object.keys(f)) if (!PEOPLE_FIELD_KEYS.includes(k)) at(peopleFence!.line, `people: field ${String(f.slug)} has an unknown key ${k}`);
    }
    const minConfidence = center?.attrs.min_confidence;
    const centerMin: Flow = minConfidence === undefined ? 0.6 : /^\d+(\.\d+)?$/.test(minConfidence) ? Number(minConfidence) : { setting: minConfidence };
    const d = isMap(dataRaw) ? dataRaw : {};
    for (const k of Object.keys(d)) if (!DATA_KEYS.includes(k)) at(dataFence!.line, `data: ${k} is not a key (${DATA_KEYS.join(", ")})`);
    /** A data map with the prompts' ```output blocks added, which the data block itself doesn't write. */
    const withOutputs = (key: string, outputs: Record<string, Record<string, string>>) => {
      const v = d[key];
      if (!isMap(v)) return v;
      for (const k of Object.keys(outputs)) if (Object.hasOwn(v, k)) at(dataFence!.line, `data: ${key}.${k} is written in its prompt's \`\`\`output block`);
      return { ...v, ...outputs };
    };
    const people = isMap(peopleRaw) ? peopleRaw : {};
    data = {
      ...(d.qualification ? { qualification: d.qualification } : {}),
      ...(d.terms !== undefined ? { terms: d.terms } : {}),
      coreRoles: d.coreRoles, quietDays: d.quietDays, stages,
      drafts: withOutputs("drafts", { output: output("drafts.prompt"), review: output("drafts.reviewPrompt") }),
      research: withOutputs("research", { output: output("research.briefPrompt") }),
      people: {
        fields: fields.map((f) => {
          // A field from the ai-fields block keeps its definition there; people research reads the same shape.
          const ai = aiField(f.slug);
          const { slug, label, answer, question, judgment, replaces } = ai ? { ...ai, answer: ai.answerType ?? "text" } : f;
          return { slug: String(slug), label, kind: "qa", answerType: answer, question, ...(judgment === undefined ? {} : { judgment }), ...(replaces === undefined ? {} : { replaces }) };
        }),
        refresh,
        slugs: { employed: slug("employed"), goal: slug("goal"), systems: slug("systems") },
        center: jev("people.center", "people research"),
        centerMinConfidence: centerMin,
        capability: { tool: capability?.attrs.tool ?? "", schema: isMap(toolSchema) ? toolSchema : {} },
        everyDays: people.everyDays, buyers: people.buyers,
        fit: jev("people.fit", "ordering the ICP's buyers", FIT_CHOICES),
      },
    } as unknown as BoundData;
    const dataLine = dataFence?.line ?? peopleFence?.line ?? 1;
    const unbound = bindingProblems(data, settingsSchema);
    for (const message of unbound) at(dataLine, message);
    if (!unbound.length && !hasErrors(problems)) for (const message of playsDataErrors(resolveData(data, defaults))) at(dataLine, message);
  } else {
    for (const f of [stagesFence, dataFence, peopleFence]) if (f) at(f.line, `\`\`\`${f.lang} is plays data, and this customization has no plays (no \`\`\`logic block and no prompts)`);
  }

  // ── Actions: each one in its section, in file order ──
  const fieldSlugs = data ? (data.people.fields as ReadonlyArray<{ slug: string }>).map((f) => f.slug) : [];
  for (const f of fences.filter((x) => x.lang === "action")) {
    const read = blockOf(f);
    if (!read) continue;
    const raw = read.value;
    const lineOf = (key: string) => read.lines.get(key) ?? f.line;
    if (!isMap(raw)) { at(f.line, "an action is a block of key: value lines"); continue; }
    for (const k of Object.keys(raw)) if (!ACTION_KEYS.includes(k)) at(lineOf(k), `action ${String(raw.id ?? "")}: ${k} is not an action key (${ACTION_KEYS.join(", ")})`);
    const id = typeof raw.id === "string" ? raw.id : "";
    const page = enclosing(f.heading, "section");
    // An id is unique on its page: the account and contact pages each have their own merge.
    const declared = sections.filter((s) => page && s.object === objectOf(page)).flatMap((s) => s.section.actions ?? []);
    if (!ACTION_ID.test(id)) at(lineOf("id"), "an action needs an id of letters and digits, like researchAccount");
    else if (declared.some((a) => a.id === id)) at(lineOf("id"), `action ${id} is declared twice on the ${page ? objectOf(page) : "deal"} page`);
    if (typeof raw.label !== "string" || !raw.label) at(lineOf("label"), `action ${id} needs a label`);
    const runs = typeof raw.runs === "string" ? raw.runs : "";
    if (!isActionId(runs)) at(lineOf("runs"), `action ${id}: runs ${runs || "(nothing)"} is not a kernel action (${Object.keys(KERNEL_ACTIONS).join(", ")}); page controls such as search, toggles and copy are the page's own`);
    const refs = [raw.prompt, ...(Array.isArray(raw.prompts) ? raw.prompts : raw.prompts === undefined ? [] : [raw.prompts]), raw.review].filter((x) => x !== undefined);
    for (const [key, r] of [["prompt", raw.prompt], ["prompts", raw.prompts], ["review", raw.review]] as const) {
      if (r === undefined) continue;
      for (const p of Array.isArray(r) ? r : [r]) if (typeof p !== "string" || !Object.hasOwn(prompts, p)) at(lineOf(key), `action ${id}: prompt ${String(p)} isn't written in this customization`);
    }
    const fieldsRef = raw.fields;
    if (fieldsRef !== undefined && (!Array.isArray(fieldsRef) || fieldsRef.some((s) => typeof s !== "string" || !fieldSlugs.includes(s)))) at(lineOf("fields"), `action ${id}: fields names the people research fields (${fieldSlugs.join(", ") || "none"})`);
    for (const k of ["label_after", "shows", "enabled", "llm", "gate", "done", "note"]) if (raw[k] !== undefined && typeof raw[k] !== "string") at(lineOf(k), `action ${id}: ${k} is text`);
    const heading = enclosing(f.heading, "section");
    const open = heading && sections.find((s) => s.heading === heading);
    if (!open) { if (!heading) at(f.line, `action ${id} sits outside any {section=…} heading`); continue; }
    const panelHeading = enclosing(f.heading, "panel");
    const panel = panelHeading?.attrs.panel;
    if (panel !== undefined && !Object.hasOwn(PANELS, panel)) { at(panelHeading!.line, `panel=${panel} is not a kernel panel (${Object.keys(PANELS).join(", ")})`); continue; }
    if (panel !== undefined && PANELS[panel as Panel] !== open.section.component) { at(panelHeading!.line, `the ${panel} sits in a {section=${PANELS[panel as Panel]}} section`); continue; }
    const host = (panel ?? open.section.component) as Host;
    if (!placements().some((p) => p.object === open.object && p.host === host)) { at(f.line, `action ${id}: a ${open.section.component} section has no actions`); continue; }
    const text = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : undefined);
    const action: PageAction = {
      id, label: String(raw.label ?? ""), runs: runs as PageAction["runs"],
      ...(text("label_after") !== undefined ? { labelAfter: text("label_after") } : {}),
      ...(panel !== undefined ? { panel: panel as Panel } : {}),
      ...Object.fromEntries((["shows", "enabled", "llm", "gate", "done", "note"] as const).flatMap((k) => (text(k) !== undefined ? [[k, text(k)]] : []))),
      ...(refs.length ? { prompts: refs.flat().filter((x): x is string => typeof x === "string") } : {}),
      ...(Array.isArray(fieldsRef) ? { fields: fieldsRef as string[] } : {}),
    };
    if (isActionId(runs)) for (const p of actionProblems(action, host, open.object)) at(lineOf(p.key === "label_after" ? "label_after" : p.key), `action ${id}: ${p.message}`);
    open.section = { ...open.section, actions: [...(open.section.actions ?? []), action] };
  }
  const opened = (object: PageObject) => sections.filter((s) => s.object === object);
  const [dealPage, accountPage, contactPage] = PAGE_OBJECTS.map((o) => opened(o).map((s) => s.section));
  if (!hasErrors(problems)) {
    for (const object of PAGE_OBJECTS) {
      const own = opened(object);
      for (const p of POINTS[`${object}.page`].problems(own.map((s) => s.section))) at(own[p.at].fieldsLine ?? own[p.at].line, p.message);
    }
  }

  // ── Templates: a spec in YAML's subset or JSON under ```template kind=<kind> key=<key> ──
  const templateFences = fences.filter((f) => f.lang === "template").map((f) => {
    const { attrs, error } = attrsOf(f.info);
    if (error) at(f.line, `template: ${error}`);
    for (const k of Object.keys(attrs)) if (!TEMPLATE_ATTRS.includes(k)) at(f.line, `template: ${k}= is not an attribute (${TEMPLATE_ATTRS.join(", ")})`);
    if (!attrs.kind || !attrs.key) at(f.line, `a template names its kind (${TEMPLATE_KIND_IDS.join(", ")}) and key: \`\`\`template kind=report key=open_pipeline`);
    const text = f.lines.map((l) => l.text).join("\n").trim();
    let spec: unknown = null;
    if (text.startsWith("{")) {
      try { spec = JSON.parse(text); } catch (e) { at(f.line, `template: the JSON doesn't parse (${(e as Error).message})`); }
    } else spec = blockOf(f)?.value ?? null;
    return { f, kind: attrs.kind ?? "", key: attrs.key ?? "", spec };
  });
  const declaredTemplates = templateFences.map(({ kind, key, spec }) => ({ kind, key, spec }) as Template);
  const templates: Template[] = [];
  for (const [i, t] of templateFences.entries()) {
    if (!t.kind || !t.key) continue;
    if (templateFences.findIndex((x) => x.kind === t.kind && x.key === t.key) !== i) { at(t.f.line, `template ${t.kind} ${t.key} is already on line ${templateFences.find((x) => x.kind === t.kind && x.key === t.key)!.f.line}`); continue; }
    const checked = checkTemplate(t.kind, t.key, t.spec, declaredTemplates);
    if (checked.ok) templates.push(checked.template);
    else for (const e of checked.errors) at(t.f.line, `template ${t.kind} ${t.key}: ${e}`);
  }

  // ── Theme: one ```theme block, each value a literal or a color/choice setting ──
  const themeFence = one("theme");
  const themeRead = themeFence && blockOf(themeFence);
  let theme: ThemeDecl | null = null;
  if (themeFence && themeRead) {
    const problems = themeDeclProblems(themeRead.value, settingsSchema);
    for (const message of problems) at(themeFence.line, `theme: ${message}`);
    if (!problems.length) theme = themeRead.value as ThemeDecl;
  }

  // ── Contributions: what each point finds in the body, against what the frontmatter declares ──
  // A people field written inline in the ```people block is a field too (recipes/fields.ts fieldsOf), but recipes wrote
  // those before fields were a point, so only the ```ai-fields block declares the point.
  const declaredFields = (Array.isArray(aiRaw) ? aiRaw : []) as unknown as RecipeField[];
  const parts = { dealPage, accountPage, contactPage, theme, templates: declaredTemplates, fields: declaredFields, data: null };
  const firstLine = (id: PointId) => {
    const page = PAGE_OBJECTS.find((o) => `${o}.page` === id);
    if (id === "workspace.theme") return themeFence?.line;
    return page ? opened(page)[0]?.line : id === "fields" ? aiFence?.line : templateFences.find((t) => `templates.${t.kind}s` === id)?.f.line;
  };
  for (const id of POINT_IDS) {
    const offers = pointOf(id).discover({ ...parts, models, settingsSchema });
    const declared = meta.contributes.includes(id);
    const what = id === "workspace.theme" ? "a theme" : POINTS[id].kind === "page" ? `a ${POINTS[id].title.toLowerCase()}` : id === "fields" ? "a list of AI fields" : isModelPoint(id) ? `a ${POINTS[id].title.toLowerCase()} model` : `a template for ${POINTS[id].title.toLowerCase()}`;
    const line = modelLines.get(id) ?? firstLine(id) ?? contributesLine;
    if (declared && !offers.length) at(contributesLine, `contributes ${id}, and the customization has no ${POINTS[id].title.toLowerCase()}: ${POINTS[id].missing}`);
    if (offers.length && !declared) at(line, `this is ${what}; add ${id} to contributes`);
    if (isModelPoint(id)) for (const o of offers) for (const p of MODEL_POINTS[id].problems(o.declares as never)) at(line, p.message);
  }

  // ── Evals ──
  const evals: RecipeEval[] = [];
  const evalsFence = one("evals");
  const evalsRead = evalsFence && blockOf(evalsFence);
  if (evalsFence && evalsRead) {
    const raw = evalsRead.value;
    if (!Array.isArray(raw)) at(evalsFence.line, "evals: a list of - name: … items");
    else raw.forEach((e, i) => {
      const line = evalsRead.lines.get(i) ?? evalsFence.line;
      const call = isMap(e) ? e.call : undefined;
      if (!isMap(e) || typeof e.name !== "string" || !e.name || (e.description !== undefined && typeof e.description !== "string") || !Object.hasOwn(e, "expect")) { at(line, "an eval has a name, a description, a call and an expect"); return; }
      for (const k of Object.keys(e)) if (!EVAL_KEYS.includes(k)) at(line, `eval ${e.name}: ${k} is not a key (${EVAL_KEYS.join(", ")})`);
      if (!isMap(call) || typeof call.fn !== "string" || !(PLAY_FNS as readonly string[]).includes(call.fn) || !Array.isArray(call.input)) { at(line, `eval ${e.name}: call is { fn: <a play>, input: [ … ] }, and fn is one of ${PLAY_FNS.join(", ")}`); return; }
      evals.push({ name: e.name, description: (e.description as string | undefined) ?? "", call: call as unknown as RecipeEval["call"], expect: e.expect as RecipeEval["expect"] });
    });
  }

  const code = fences.filter((f) => f.lang === "ts").map((f) => ({ line: f.line, source: f.lines.map((l) => l.text).join("\n") }));
  problems.sort((a, b) => a.line - b.line);
  return { recipe: { meta, settingsSchema, defaults, dealPage, theme, accountPage, contactPage, models, templates, fields: aiFields, data, prompts, logic, evals, code }, problems };
}

/**
 * Every table that decides what a recipe.md may say, as plain data: tests/recipeFormat.test.ts hashes it against
 * RECIPE_GRAMMAR_SHA256, so the grammar can't change without the format's record of it (recipes/kernel.ts).
 */
export const RECIPE_GRAMMAR = {
  frontmatter: { keys: FRONT_KEYS, objects: RECIPE_OBJECTS, sources: RECIPE_SOURCES, permissions: ["read", "llm", "sources"] },
  points: Object.fromEntries(POINT_IDS.map((id) => [id, { kind: POINTS[id].kind, cardinality: POINTS[id].cardinality, binds: POINTS[id].binds }])),
  models: Object.fromEntries(MODEL_POINT_IDS.map((id) => [id, { settings: MODEL_POINTS[id].settings, tables: Object.fromEntries(Object.entries(MODEL_POINTS[id].tables).map(([n, t]) => [n, t.columns])), prose: MODEL_POINTS[id].prose }])),
  settings: { columns: SETTING_COLUMNS, kinds: Object.keys(KIND_LIMITS), roles: DEAL_ROLES, channels: PLAY_CHANNELS, levels: LEVEL_IDS },
  headings: HEADING_ATTRS,
  stages: DEAL_STAGES,
  components: { page: PAGE_COMPONENTS, play: PLAY_COMPONENTS, objects: COMPONENTS, panels: PANELS, rest: REST_FIELDS, parts: PARTS },
  fences: KNOWN_FENCES,
  templates: { attrs: TEMPLATE_ATTRS, kinds: TEMPLATE_KIND_IDS },
  fields: { keys: AI_FIELD_KEYS, objects: ["account", "contact"], kinds: ["classify", "qa"], answers: ["text", "number", "boolean"], autoAccept: AUTO_ACCEPT_RANGE, people: PEOPLE_REF_KEYS },
  actions: {
    keys: ACTION_KEYS,
    placeholders: Object.fromEntries(Object.entries(BINDINGS).map(([k, b]) => [k, b.placeholders])),
    kernel: Object.fromEntries(Object.keys(KERNEL_ACTIONS).map((id) => [id, placements().filter((p) => p.id === id).map((p) => ({
      object: p.object, host: p.host, binding: p.on, requires: p.requires ?? null, ready: p.ready ?? null, after: p.after ?? null, scope: scopeOf(p.id, p.host, p.object),
    }))])),
  },
  prompts: { arity: PROMPT_ARITY, jev: JEV_PROMPTS, outputs: OUTPUTS, helpers: Object.keys(HELPERS) },
  logic: { plays: LOGIC_PLAYS, kinds: KINDS, builtins: Object.fromEntries(Object.entries(BUILTINS).map(([name, b]) => [name, { play: b.play, settings: b.settings, table: b.table ?? null }])), checkRules: Object.keys(RULES) },
  data: { bindable: BINDABLE, data: DATA_KEYS, people: PEOPLE_KEYS, field: PEOPLE_FIELD_KEYS, refresh: REFRESH_CADENCES, fit: FIT_CHOICES },
  evals: { keys: EVAL_KEYS, fns: PLAY_FNS },
};
