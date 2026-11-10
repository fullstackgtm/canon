import { valueAt, type Doc } from "./text.ts";
import type { FormExpr } from "./manifest.ts";

export type EditorCall = { call: string; args?: Record<string, FormExpr> };
export type InlineEdit = EditorCall & {
  field: string; arg: string; version: string; versionArg: string; maxLength: number; nonempty?: true;
  validate?: EditorCall; prefix?: string; suffix?: string;
};
export type DefinitionEdit = { sentence: string; param: string; query: InlineEdit };
export type EditableHierarchy = {
  parent: string; depth: string; icon: string; muted: string; star: string;
  add?: EditorCall & { choices: string; arg: string };
  move?: EditorCall & { targets: string; arg: string };
};
export type EditorOptions = Record<string, Array<{ value: string; label: string }>>;
export type ValueControl =
  | { kind: "choices"; values: string[]; options: string }
  | { kind: "terms"; values: string[]; placeholder: string }
  | { kind: "range"; min?: number; max?: number };
export type SentenceToken = { id: string; text: string; negative: boolean; control: ValueControl };
export type ConditionChoice = { id: string; label: string; control: ValueControl };
export type MessageField = { key: string; label: string; value: string; maxLength: number; placeholder: string; rows: number };
export type RecordEditorValue = {
  parts: Array<string | SentenceToken>; conditions: ConditionChoice[]; fields: MessageField[]; help: string;
};
export type TokenChange = { id: string; add?: boolean; remove?: boolean; values?: string[]; min?: number; max?: number };

const object = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
const exact = (x: Record<string, unknown>, keys: string[]) => Object.keys(x).every((k) => keys.includes(k));
const text = (x: unknown, max: number) => typeof x === "string" && x.length <= max;
const strings = (x: unknown, max: number) => Array.isArray(x) && x.length <= max && x.every((v) => text(v, 400));
const finite = (x: unknown) => x === undefined || typeof x === "number" && Number.isFinite(x);
function control(x: unknown, options: EditorOptions): boolean {
  if (!object(x)) return false;
  if (x.kind === "range") return exact(x, ["kind", "min", "max"]) && finite(x.min) && finite(x.max);
  if (!strings(x.values, 60)) return false;
  if (x.kind === "terms") return exact(x, ["kind", "values", "placeholder"]) && text(x.placeholder, 200);
  return x.kind === "choices" && exact(x, ["kind", "values", "options"]) && typeof x.options === "string" && Object.hasOwn(options, x.options);
}

/** Returned editor data contains values only. Calls and argument expressions come from the checked manifest. */
export function editorOptions(x: unknown): EditorOptions {
  if (!object(x) || Object.keys(x).length > 150 || !Object.values(x).every((list) => Array.isArray(list) && list.length <= 500 && list.every((o) => object(o) && exact(o, ["value", "label"]) && text(o.value, 200) && text(o.label, 200)))) throw new Error("Invalid editor options.");
  return x as EditorOptions;
}
export function recordEditorValue(x: unknown, options: EditorOptions): RecordEditorValue {
  if (!object(x) || !exact(x, ["parts", "conditions", "fields", "help"]) || !text(x.help, 1000)
    || !Array.isArray(x.parts) || x.parts.length > 200 || !x.parts.every((p) => typeof p === "string" ? text(p, 4000) : object(p) && exact(p, ["id", "text", "negative", "control"]) && text(p.id, 120) && p.id !== "" && text(p.text, 4000) && typeof p.negative === "boolean" && control(p.control, options))
    || !Array.isArray(x.conditions) || x.conditions.length > 150 || !x.conditions.every((c) => object(c) && exact(c, ["id", "label", "control"]) && text(c.id, 120) && c.id !== "" && text(c.label, 200) && control(c.control, options))
    || !Array.isArray(x.fields) || x.fields.length > 12 || !x.fields.every((f) => object(f) && exact(f, ["key", "label", "value", "maxLength", "placeholder", "rows"]) && text(f.key, 40) && f.key !== "" && text(f.label, 80) && text(f.value, 100_000) && Number.isInteger(f.maxLength) && Number(f.maxLength) > 0 && Number(f.maxLength) <= 100_000 && text(f.placeholder, 300) && Number.isInteger(f.rows) && Number(f.rows) >= 1 && Number(f.rows) <= 10)) throw new Error("Invalid record editor metadata.");
  const ids = [...x.parts.filter(object).map((p) => p.id), ...x.conditions.map((c) => c.id)];
  if (new Set(ids).size !== ids.length || new Set(x.fields.map((f) => f.key)).size !== x.fields.length) throw new Error("Repeated editor metadata key.");
  return x as RecordEditorValue;
}

/** A draft retains the version at which editing began, including across validation and page refreshes. */
export class InlineDraft {
  value: string;
  original: string;
  version: number;
  error = "";
  pending = false;
  private currentVersion: number;
  private revision = 0;
  private saved = false;
  constructor(value: string, version: number) { this.value = this.original = value; this.version = this.currentVersion = version; }
  receive(value: string, version: number) {
    const changed = this.currentVersion !== version;
    this.currentVersion = version;
    if (version === this.version) return;
    if (this.saved || this.value === this.original) {
      this.value = this.original = value; this.version = version; this.error = ""; this.pending = false; this.saved = false; this.revision++;
    } else { if (changed) this.revision++; this.error = "This record changed. Press Escape to reload its current value."; }
  }
  change(value: string) { this.value = value; this.error = this.currentVersion === this.version ? "" : "This record changed. Press Escape to reload its current value."; this.revision++; }
  escape(value: string, version: number) { if (!this.pending) { this.value = this.original = value; this.version = this.currentVersion = version; this.error = ""; this.revision++; } }
  async validate(check: (value: string) => Promise<{ text: string; error?: string }>) {
    if (this.currentVersion !== this.version) return;
    const revision = this.revision;
    try { const out = await check(this.value); if (revision === this.revision) this.error = out.error ?? ""; }
    catch (e) { if (revision === this.revision) this.error = e instanceof Error ? e.message : String(e); }
  }
  async commit(check: (value: string) => Promise<{ text: string; error?: string }>, save: (value: string, version: number) => Promise<void>) {
    if (this.pending || this.value === this.original) return;
    if (this.currentVersion !== this.version) { this.error = "This record changed. Press Escape to reload its current value."; return; }
    this.pending = true;
    const revision = this.revision;
    try {
      const out = await check(this.value);
      if (revision !== this.revision) return;
      if (out.error) { this.error = out.error; return; }
      if (this.currentVersion !== this.version) { this.error = "This record changed. Press Escape to reload its current value."; return; }
      if (out.text === this.original) { this.value = this.original; this.error = ""; return; }
      await save(out.text, this.version);
      this.value = this.original = out.text; this.error = ""; this.saved = true;
    } catch (e) { this.error = e instanceof Error ? e.message : String(e); }
    finally { this.pending = this.saved; }
  }
}

export function visibleHierarchy<T extends { key: string }>(rows: readonly T[], parent: (row: T) => string | null, closed: ReadonlySet<string>): T[] {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return rows.filter((row) => {
    const seen = new Set([row.key]);
    let key = parent(row);
    while (key) {
      if (closed.has(key)) return false;
      if (seen.has(key) || !byKey.has(key)) throw new Error("Invalid hierarchy parent.");
      seen.add(key); key = parent(byKey.get(key)!);
    }
    return true;
  });
}

export function hierarchyRows(rows: readonly Doc[], h: EditableHierarchy): void {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  if (rows.length !== byKey.size) throw new Error("Repeated hierarchy key.");
  for (const row of rows) {
    const depth = valueAt(row, h.depth), parent = valueAt(row, h.parent);
    if (!Number.isInteger(depth) || Number(depth) < 0 || Number(depth) > 32 || !(parent === null || typeof parent === "string" && parent !== "") || !["target", "layers", "users"].includes(String(valueAt(row, h.icon))) || typeof valueAt(row, h.muted) !== "boolean" || typeof valueAt(row, h.star) !== "boolean") throw new Error("Invalid hierarchy row metadata.");
    const seen = new Set([row.key]);
    let ancestor: unknown = parent;
    let actualDepth = 0;
    while (ancestor) {
      if (typeof ancestor !== "string" || seen.has(ancestor) || !byKey.has(ancestor)) throw new Error("Invalid hierarchy parent.");
      seen.add(ancestor); actualDepth++; ancestor = valueAt(byKey.get(ancestor), h.parent);
    }
    if (actualDepth !== depth) throw new Error("Hierarchy depth differs from its parents.");
    for (const path of [h.add?.choices, h.move?.targets].filter((p): p is string => !!p)) {
      const choices = valueAt(row, path);
      if (!Array.isArray(choices) || choices.length > 200 || !choices.every((c) => object(c) && exact(c, ["value", "label"]) && text(c.value, 200) && c.value !== "" && text(c.label, 200)) || new Set(choices.map((c) => c.value)).size !== choices.length) throw new Error("Invalid hierarchy choices.");
      if (path === h.move?.targets && choices.some((c) => !byKey.has(c.value))) throw new Error("Unknown hierarchy move target.");
    }
  }
}
