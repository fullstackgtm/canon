import type { ConditionChoice, EditorOptions, RecordEditorValue, TokenChange, ValueControl } from "../../kernel/editor.ts";
import { parseQuery, type Clause, type IcpQuery, type NodeKind } from "../../kernel/icpQuery.ts";
import { sentence, withClause, withValues, type AiField, type ClausePath } from "../../kernel/icpSentence.ts";
import { COUNTRIES, DEPARTMENTS, EMPLOYEE_BANDS, LEVELS } from "../../kernel/icpVocabulary.ts";
import { INDUSTRIES } from "../../kernel/industries.ts";
import { REGIONS } from "../../kernel/dimensions.ts";

type Addable = { label: string; clause: Clause; where: { has?: number; newHas?: { neg: boolean } } };
const options = {
  industry: INDUSTRIES.map((i) => ({ value: i.key, label: i.label })), country: COUNTRIES, location: COUNTRIES,
  size: EMPLOYEE_BANDS.map((value) => ({ value, label: value })), level: LEVELS,
  dept: DEPARTMENTS.map((value) => ({ value, label: value })),
  region: REGIONS.filter((r) => r.key !== "other").map((r) => ({ value: r.key, label: r.label })),
};
export function accountFields(raw: Array<Record<string, unknown>>): AiField[] {
  return raw.filter((f) => f.entity === "account").map((f) => {
    if (typeof f.id !== "string" || typeof f.label !== "string" || ![null, "text", "number", "boolean"].includes(f.answerType as string | null) || !(f.options === null || Array.isArray(f.options))) throw new Error("Account AI-field answer metadata is unavailable.");
    return { slug: f.id, label: f.label, answerType: f.answerType as AiField["answerType"], options: f.options as AiField["options"] };
  });
}
export function editorOptions(fields: readonly AiField[]): EditorOptions {
  return { ...options, ...Object.fromEntries(fields.filter((f) => f.answerType === "boolean" || f.options !== null).map((f) => [`field-${f.slug}`, f.answerType === "boolean" ? [{ value: "true", label: "Yes" }, { value: "false", label: "No" }] : f.options!.map((o) => ({ value: o.key, label: o.label }))])) };
}
function control(c: Clause, fields: readonly AiField[]): ValueControl {
  if (c.key === "field") {
    const f = fields.find((f) => f.slug === c.slug);
    if (!f) throw new Error(`field.${c.slug} is not one of this workspace's account AI fields.`);
    if (f.answerType === "number") return { kind: "range", ...(c.min !== undefined ? { min: c.min } : {}), ...(c.max !== undefined ? { max: c.max } : {}) };
    const choices = f.answerType === "boolean" ? [{ value: "true", label: "Yes" }, { value: "false", label: "No" }]
      : f.options?.map((o) => ({ value: o.key, label: o.label }));
    return choices !== null && choices !== undefined ? { kind: "choices", options: `field-${f.slug}`, values: c.values ?? [] } : { kind: "terms", values: c.values ?? [], placeholder: "An answer, then Enter" };
  }
  return c.key in options ? { kind: "choices", options: c.key, values: c.values }
    : { kind: "terms", values: c.values, placeholder: c.key === "title" ? c.neg ? "A word to never match, e.g. intern" : "A word in the title, then Enter" : "A value, then Enter" };
}
function addable(kind: NodeKind, q: IcpQuery, fields: readonly AiField[]): Addable[] {
  const has = (cs: readonly Clause[], key: string, neg = false) => cs.some((c) => (c.key === "field" ? `field.${c.slug}` : c.key) === key && c.neg === neg);
  const list = (key: Exclude<Clause["key"], "field">, neg = false): Clause => ({ key, neg, values: [] });
  const person = (cs: readonly Clause[], where: Addable["where"], prefix: string): Addable[] => ([
    ["level", false, "seniority"], ["dept", false, "department"], ["title", false, "title contains"], ["title", true, "never titled"], ["location", false, "located in"],
  ] as const).filter(([k, neg]) => !has(cs, k, neg)).map(([k, neg, label]) => ({ label: `${prefix}${label}`, clause: list(k, neg), where }));
  if (kind === "persona") return person(q.clauses, {}, "");
  const company: Addable[] = [
    ...([["industry", false, "Industry"], ["size", false, "Employees"], ["country", false, "Based in"], ["industry", true, "Never these industries"], ["country", true, "Never based in"]] as const)
      .filter(([k, neg]) => !has(q.clauses, k, neg)).map(([k, neg, label]) => ({ label, clause: list(k, neg), where: {} })),
    ...fields.filter((f) => !has(q.clauses, `field.${f.slug}`)).map((f) => ({ label: f.label, clause: { key: "field" as const, slug: f.slug, neg: false as const, ...(f.answerType === "number" ? {} : { values: [] }) }, where: {} })),
  ];
  if (kind === "segment") return [...company,
    ...([["region", false, "Region"], ["region", true, "Never this region"], ["city", false, "City"], ["owner", false, "Owner"], ["owner", true, "Never this owner"], ["revenue", false, "Annual revenue"]] as const)
      .filter(([k, neg]) => !has(q.clauses, k, neg)).map(([k, neg, label]) => ({ label, clause: list(k, neg), where: {} })),
    ...q.has.flatMap((h, i) => person(h.clauses, { has: i }, `${h.neg ? "Employs no one" : "Employs someone"} ${i + 1}: `)),
    ...(q.has.length < 4 ? [{ label: "Employs someone who is…", clause: list("level"), where: { newHas: { neg: false } } }, { label: "Employs no one in…", clause: list("dept"), where: { newHas: { neg: true } } }] : [])];
  const buyer = q.has.findIndex((h) => !h.neg);
  return [...company, ...person(buyer >= 0 ? q.has[buyer].clauses : [], buyer >= 0 ? { has: buyer } : { newHas: { neg: false } }, "Buyer: ")];
}
const pathId = (p: ClausePath) => `${p.has === undefined ? "own" : `has${p.has}`}-${p.index}`;
const addId = (a: Addable) => `${a.where.newHas ? `new${a.where.newHas.neg ? "Not" : "Has"}` : a.where.has !== undefined ? `has${a.where.has}` : "own"}-${a.clause.neg ? "not-" : ""}${a.clause.key === "field" ? `field-${a.clause.slug}` : a.clause.key}`;
export function editorValue(kind: NodeKind, text: string, fields: readonly AiField[], data: Record<string, unknown>): RecordEditorValue {
  const parsed = parseQuery(text, kind);
  const labels = { pointOfView: ["We believe", "What surprises them about their own problem"], offer: ["We'll offer", "One free thing a first email can send"], role: ["Role", "Champion, economic buyer…"] };
  const keys = kind === "icp" ? ["pointOfView", "offer"] as const : kind === "segment" ? ["pointOfView"] as const : ["offer", "role"] as const;
  return {
    parts: parsed.errors.length ? ["Some saved conditions need review."] : sentence(kind, parsed.query, fields).map((p) => typeof p === "string" ? p : { id: pathId(p.path), text: p.text, negative: p.clause.neg || (p.path.has !== undefined && parsed.query.has[p.path.has].neg), control: control(p.clause, fields) }),
    conditions: parsed.errors.length ? [] : addable(kind, parsed.query, fields).map((a): ConditionChoice => ({ id: addId(a), label: a.label, control: control(a.clause, fields) })),
    fields: keys.map((key) => ({ key, label: labels[key][0], placeholder: labels[key][1], value: String(data[key] ?? ""), maxLength: key === "role" ? 40 : 400, rows: key === "role" ? 1 : 2 })),
    help: kind === "icp" ? "" : "Deal drafts still read the ICP's point of view and offer.",
  };
}
export function changeToken(kind: NodeKind, text: string, fields: readonly AiField[], change: TokenChange): string {
  const parsed = parseQuery(text, kind);
  if (parsed.errors.length) throw new Error(parsed.errors.join("; "));
  const q = parsed.query;
  let clause: Clause, path: ClausePath | undefined, addition: Addable | undefined;
  if (change.add) {
    addition = addable(kind, q, fields).find((a) => addId(a) === change.id);
    if (!addition || change.remove) throw new Error("This condition is not available here.");
    clause = addition.clause;
  } else {
    const part = sentence(kind, q, fields).find((p) => typeof p !== "string" && pathId(p.path) === change.id);
    if (!part || typeof part === "string") throw new Error("This sentence value changed. Reload and try again.");
    clause = part.clause; path = part.path;
  }
  if (change.remove) return withValues(q, path!, { values: [], min: undefined, max: undefined });
  const c = control(clause, fields);
  let next: { values?: string[]; min?: number; max?: number };
  if (c.kind === "range") {
    if (change.values !== undefined || change.min === undefined && change.max === undefined || ![change.min, change.max].every((n) => n === undefined || Number.isFinite(n)) || change.min !== undefined && change.max !== undefined && change.min > change.max) throw new Error("Give a valid minimum or maximum.");
    next = { values: undefined, min: change.min, max: change.max };
  } else {
    if (!Array.isArray(change.values) || change.values.length > 60 || change.min !== undefined || change.max !== undefined || change.values.some((v) => typeof v !== "string" || !v.trim() || v.length > 120)) throw new Error("Choose valid condition values.");
    if (c.kind === "choices" && change.values.some((v) => !editorOptions(fields)[c.options].some((o) => o.value === v))) throw new Error("Choose a value from this condition's vocabulary.");
    if (change.add && !change.values.length) throw new Error("Choose a value first.");
    next = { values: change.values };
  }
  return addition ? withClause(q, { ...clause, ...next } as Clause, addition.where) : withValues(q, path!, next);
}
