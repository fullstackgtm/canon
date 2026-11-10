import { accountFields, changeToken } from "./editor.ts";
import type { TokenChange } from "../../kernel/editor.ts";
import type { CallContext, CallFunctions, CallOutput, Expect, Intent, ReadDoc, ReadValue } from "../../kernel/calls.ts";
import { fieldSlugs, formatQuery, parseQuery, queryToSpec, type Clause, type IcpQuery, type NodeKind } from "../../kernel/icpQuery.ts";
import { treeMoveError } from "../../kernel/icpTreeMove.ts";
import { COUNTRIES, DEPARTMENTS, EMPLOYEE_BANDS, LEVELS } from "../../kernel/icpVocabulary.ts";
import { INDUSTRIES } from "../../kernel/industries.ts";
import { REGIONS } from "../../kernel/dimensions.ts";

type FormClause = { group: number; kind: string; value: { slug?: string; min?: number; max?: number } & Record<string, unknown> };
type Criteria = FormClause[];
const keys: Record<string, string> = { industry: "industry", notIndustry: "-industry", size: "size", country: "country", notCountry: "-country", region: "region", notRegion: "-region", city: "city", owner: "owner", notOwner: "-owner", revenue: "revenue", level: "level", dept: "dept", title: "title", notTitle: "-title", location: "location" };
const listField: Record<string, string> = { industry: "industries", size: "sizes", country: "countries", region: "regions", level: "levels", dept: "departments", location: "countries" };

export function criteriaOf(q: IcpQuery): Criteria {
  const clause = (c: Clause, group: number): FormClause => c.key === "field"
    ? { group, kind: c.values ? "answer" : "number", value: { slug: c.slug, ...(c.values ? { answers: c.values } : {}), ...(c.min !== undefined ? { min: c.min } : {}), ...(c.max !== undefined ? { max: c.max } : {}) } }
    : { group, kind: Object.keys(keys).find((k) => keys[k] === `${c.neg ? "-" : ""}${c.key}`)!, value: { [listField[c.key] ?? "values"]: c.values } };
  return [...q.clauses.map((c) => clause(c, 0)), ...q.has.flatMap((h, i) => h.clauses.map((c) => clause(c, h.neg ? -(i + 1) : i + 1)))];
}
function fromCriteria(c: Criteria): IcpQuery {
  const clause = (c: FormClause): Clause => {
    if (c.kind === "answer" || c.kind === "number") return { key: "field", slug: c.value.slug!, neg: false, ...(c.kind === "answer" ? { values: c.value.answers as string[] ?? [] } : { ...(c.value.min !== undefined ? { min: c.value.min } : {}), ...(c.value.max !== undefined ? { max: c.value.max } : {}) }) };
    const key = keys[c.kind];
    if (!key) throw new Error("Unknown condition.");
    const plain = key.replace(/^-/, "") as Exclude<Clause["key"], "field">;
    return { key: plain, neg: key.startsWith("-"), values: c.value[listField[plain] ?? "values"] as string[] ?? [] };
  };
  const groups = [...new Set(c.map((r) => r.group))];
  if (groups.some((g) => !Number.isInteger(g) || Math.abs(g) > 4)) throw new Error("A condition group is 0, or a people group from 1 to 4.");
  return { clauses: c.filter((r) => r.group === 0).map(clause), has: groups.filter((g) => g !== 0).map((g) => ({ neg: g < 0, clauses: c.filter((r) => r.group === g).map(clause) })) };
}
function queryOf(text: string, kind: NodeKind, fields: Array<Record<string, unknown>>) {
  if (text.length > 4000) throw new Error("A query holds at most 4000 characters.");
  const parsed = parseQuery(text, kind);
  if (parsed.errors.length) throw new Error(parsed.errors.join("; "));
  for (const slug of fieldSlugs(parsed.query)) {
    const field = fields.find((f) => f.id === slug && f.entity === "account");
    if (!field) throw new Error(`field.${slug} is not one of this workspace's account AI fields.`);
    const c = parsed.query.clauses.find((c) => c.key === "field" && c.slug === slug) as Extract<Clause, { key: "field" }>;
    if (c.min !== undefined && c.max !== undefined && c.min > c.max) throw new Error("A condition's minimum cannot exceed its maximum.");
    if (!c.values && field.answerType !== "number") throw new Error(`${slug} does not take a numeric range.`);
  }
  return { text: formatQuery(parsed.query), spec: queryToSpec(parsed.query), criteria: criteriaOf(parsed.query) };
}
const nameOf = (value: unknown) => { const name = String(value ?? "").trim(); if (!name || name.length > 80) throw new Error("Give a name of 1 to 80 characters."); return name; };
const messageOf = (v: unknown, max: number) => { const text = String(v ?? "").trim(); if (text.length > max) throw new Error(`Keep this message within ${max} characters.`); return text; };

function edit(command: string): CallFunctions[string] {
  return (ctx: CallContext, reads: Record<string, ReadValue>): CallOutput => {
    const definitions = reads.definitions as ReadDoc[], nodes = reads.nodes as ReadDoc[];
    const fields = reads.fields as Array<Record<string, unknown>>;
    const all = [...definitions, ...nodes], rootKeys = new Set(definitions.map((d) => d.key));
    const taken = new Set(all.map((d) => d.key));
    let sequence = 0;
    const newKey = () => { let key: string; do { key = `icp-${ctx.now.toString(36)}-${ctx.caller.userId}-${sequence++}`; } while (taken.has(key)); taken.add(key); return key; };
    const a = ctx.args, row = all.find((d) => d.key === a.key);
    const collection = row && rootKeys.has(row.key) ? "icps" : "nodes";
    const kind: NodeKind = collection === "icps" ? "icp" : row?.data.kind as NodeKind;
    if (command !== "create" && (!row || row.version !== a.expect)) throw new Error("This definition changed. Reload and try again.");
    const expect: Expect[] = all.map((d) => ({ collection: rootKeys.has(d.key) ? "icps" : "nodes", key: d.key, version: d.version }));
    const expectCount = [{ collection: "icps", count: definitions.length }, { collection: "nodes", count: nodes.length }];
    const intents: Intent[] = [];
    const patch = (d: ReadDoc, data: Record<string, unknown>, unset?: string[]) => intents.push({ op: "patch", collection: rootKeys.has(d.key) ? "icps" : "nodes", key: d.key, data, ...(unset?.length ? { unset } : {}) });
    const put = (collection: string, key: string, data: Record<string, unknown>) => { expect.push({ collection, key, version: null }); intents.push({ op: "put", collection, key, data }); };
    const tree = () => all.map((d) => ({ id: d.key, parent: rootKeys.has(d.key) ? null : String(d.data.parent ?? d.data.icp), kind: rootKeys.has(d.key) ? "icp" as const : d.data.kind as "segment" | "persona" }));
    let key = row?.key;
    switch (command) {
      case "create": {
        const q = queryOf(String(a.query ?? ""), "icp", fields);
        key = newKey();
        put("icps", key, { name: nameOf(a.name), query: q.text, spec: q.spec, active: definitions.length === 0 || a.active === true, isDefault: definitions.length === 0, source: "manual", createdAt: ctx.now });
        break;
      }
      case "rename": patch(row!, { name: nameOf(a.name) }); break;
      case "editQuery": case "editCriteria": case "editToken": {
        const text = command === "editToken" ? changeToken(kind, String(row!.data.query), accountFields(fields), a.change as TokenChange) : command === "editQuery" ? String(a.query) : formatQuery(fromCriteria(a.criteria as Criteria));
        const q = queryOf(text, kind, fields);
        patch(row!, { query: q.text, ...(kind === "icp" ? { spec: q.spec } : {}) });
        break;
      }
      case "messageField": {
        const allowed = { icp: ["pointOfView", "offer"], segment: ["pointOfView"], persona: ["role", "offer"] };
        const field = String(a.field);
        if (!allowed[kind].includes(field)) throw new Error("This message field is not available on this row.");
        const text = messageOf(a.value, field === "role" ? 40 : 400);
        patch(row!, text ? { [field]: text } : {}, text ? [] : [field]);
        break;
      }
      case "icpMessage": case "segmentMessage": case "personaMessage": {
        if (command !== `${kind}Message`) throw new Error("Choose the message editor for this row kind.");
        const data: Record<string, unknown> = {}, unset: string[] = [];
        const fields = { icp: ["description", "pointOfView", "offer"], segment: ["pointOfView"], persona: ["role", "offer"] } as const;
        for (const f of fields[kind]) {
          const text = messageOf(a[f], f === "role" ? 40 : f === "description" ? 2000 : 400);
          if (text) data[f] = text; else unset.push(f);
        }
        patch(row!, data, unset);
        break;
      }
      case "toggle":
        if (kind !== "icp") throw new Error("Switch an ICP on or off.");
        patch(row!, { active: !row!.data.active }); break;
      case "setDefault":
        if (kind !== "icp") throw new Error("Choose an ICP as the default.");
        for (const d of definitions) if (d.data.isDefault !== (d.key === row!.key)) patch(d, { isDefault: d.key === row!.key });
        break;
      case "duplicate": {
        if (kind !== "icp") throw new Error("Duplicate an entire ICP tree.");
        const children = nodes.filter((n) => n.data.icp === row!.key);
        key = newKey();
        const mapping = new Map([[row!.key, key], ...children.map((n) => [n.key, newKey()] as [string, string])]);
        const { gapCheck: _gap, updatedAt: _updated, ...data } = row!.data;
        put("icps", key, { ...data, name: nameOf(`${String(data.name).slice(0, 73)} (copy)`), active: false, isDefault: false, createdAt: ctx.now });
        for (const child of children) put("nodes", mapping.get(child.key)!, { ...child.data, icp: key, ...(child.data.parent ? { parent: mapping.get(String(child.data.parent))! } : {}), createdAt: ctx.now });
        break;
      }
      case "createNode": {
        if (kind === "persona") throw new Error("A persona has no segments or personas under it.");
        const nodeKind = a.kind as "segment" | "persona";
        key = newKey();
        const root = kind === "icp" ? row!.key : String(row!.data.icp);
        const graph = [...tree(), { id: key, parent: root, kind: nodeKind }];
        if (row!.key !== root) { const error = treeMoveError(graph, key, row!.key); if (error) throw new Error(error); }
        const q = queryOf(nodeKind === "persona" ? "level:manager" : "", nodeKind, fields);
        put("nodes", key, { icp: root, ...(kind === "segment" ? { parent: row!.key } : {}), kind: nodeKind, name: nodeKind === "persona" ? "New persona" : "New segment", query: q.text, createdAt: ctx.now });
        break;
      }
      case "move": {
        if (kind === "icp") throw new Error("Move a segment or persona.");
        const error = treeMoveError(tree(), row!.key, String(a.parent));
        if (error) throw new Error(error);
        patch(row!, a.parent === row!.data.icp ? {} : { parent: a.parent }, a.parent === row!.data.icp ? ["parent"] : []);
        break;
      }
      case "remove": {
        const doomed = new Set([row!.key]);
        for (let changed = true; changed;) { changed = false; for (const n of nodes) if (doomed.has(String(n.data.parent ?? n.data.icp)) && !doomed.has(n.key)) { doomed.add(n.key); changed = true; } }
        for (const d of all.filter((d) => doomed.has(d.key))) intents.push({ op: "delete", collection: rootKeys.has(d.key) ? "icps" : "nodes", key: d.key });
        if (kind === "icp" && row!.data.isDefault) {
          const next = definitions.filter((d) => d.key !== row!.key).sort((a, b) => Number(b.data.active) - Number(a.data.active) || Number(a.data.createdAt ?? a.createdAt) - Number(b.data.createdAt ?? b.createdAt))[0];
          if (next) patch(next, { isDefault: true });
        }
        break;
      }
      default: throw new Error("Unknown editing command.");
    }
    if (intents.length) { intents[0].expect = expect; intents[0].expectCount = expectCount; }
    return { intents, value: { key } };
  };
}

export const editingCalls: CallFunctions = Object.fromEntries(["messageField", "editToken", "icpMessage", "segmentMessage", "personaMessage", "create", "rename", "editQuery", "editCriteria", "toggle", "setDefault", "duplicate", "createNode", "move", "remove"].map((name) => [name, edit(name)]));
export const vocabulary: CallFunctions[string] = (_ctx, reads) => ({ value: {
  industries: INDUSTRIES.map((i) => ({ value: i.key, label: i.label })), countries: COUNTRIES,
  sizes: EMPLOYEE_BANDS.map((value) => ({ value, label: value })), levels: LEVELS,
  departments: DEPARTMENTS.map((value) => ({ value, label: value })), regions: REGIONS.filter((r) => r.key !== "other").map((r) => ({ value: r.key, label: r.label })),
  fields: (reads.fields as Array<Record<string, unknown>>).filter((f) => f.entity === "account").map((f) => ({ value: f.id, label: f.label, answerType: f.answerType, options: f.answerType === "boolean" ? [{ value: "true", label: "Yes" }, { value: "false", label: "No" }] : (f.options as Array<{ key: string; label: string }> | null)?.map((o) => ({ value: o.key, label: o.label })) ?? [] })),
} });

export const validateQuery: CallFunctions[string] = (ctx, reads) => {
  const definitions = reads.definitions as ReadDoc[], nodes = reads.nodes as ReadDoc[];
  const row = [...definitions, ...nodes].find((d) => d.key === ctx.args.key);
  if (!row || row.version !== ctx.args.expect) return { value: { text: String(ctx.args.query), error: "This definition changed. Reload and try again." } };
  try {
    const kind = definitions.includes(row) ? "icp" : row.data.kind as NodeKind;
    return { value: { text: queryOf(String(ctx.args.query), kind, reads.fields as Array<Record<string, unknown>>).text } };
  } catch (e) { return { value: { text: String(ctx.args.query), error: e instanceof Error ? e.message : String(e) } }; }
};
