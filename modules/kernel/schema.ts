/**
 * The shape of a module collection's documents (docs/modules.md, "Collections"): Convex's ValidatorJSON, what
 * `v.object({...}).json` produces, plus nodes of Canon's own: `{ type: "ref", to }`, a member, deal or team of the
 * workspace or a doc of one of the module's collections; and `{ type: "variant", variantOf, cases }`, an object field
 * whose shape the value of a sibling field picks (a rule's config by its type). One shape drives write validation,
 * the form widgets a page shows and the arguments `canon_module describe` lists. Pure: the browser, Convex queries
 * and tests all import it.
 */

export type Scalar = string | number | boolean | null;

/**
 * A field of an object. `label`, `widget` and `help` are Canon's: how every form, dialog and nested editor shows it.
 * `suggest`: a text field's input offers the values the field already holds in the docs the person reads, nested in a
 * list, an object or a variant's case too. `placeholder`: what its empty input says ("Jane Smith"), or a text over a
 * doc a ref field names, the field's own or one around it (`"Plan: {$ruleKey.config.rate|percent}"`): the value the
 * row overrides. `inherit` (a field nested in a list's rows or an object): the field of the form around it whose value
 * it takes, so a form fills it and doesn't show it (an override row's plan is the assignment's plan).
 */
export type FieldSpec = { fieldType: ValidatorJSON; optional: boolean; label?: string; widget?: Widget; help?: string; placeholder?: string; suggest?: Suggest; inherit?: string; choicesBy?: ChoicesBy };
/**
 * Where a field's suggestions come from: `true`, the values the field holds in the module's docs; `{ deals }`, the
 * values a Canon deal field (one `reads.deals` grants) holds across the deals the person sees, or `{ deals: { sibling } }`,
 * the deal field a sibling field names (a rule condition's value, by the deal field the condition picked). On a list of
 * text, the field is picked from them as several values ("Deal sources": a multi-select), and any other can be typed.
 */
export type Suggest = true | { deals: string | { sibling: string } };
/**
 * A choice field whose choices depend on a sibling's value (a condition's operators by the field it tests): per value
 * the sibling may hold, the values this field offers; any other sibling value offers them all. The server still takes
 * every value the field holds, as with a form's `hide`.
 */
export type ChoicesBy = { labels?: Readonly<Record<string, Record<string, string>>>; sibling: string; cases: Readonly<Record<string, readonly (string | number | boolean)[]>> };
/**
 * What a `ref` names: a member, a deal or a team of the workspace, a company or a person of its records (the record
 * service's), a member mailbox (an emailAccounts id), or a doc of one of the module's collections.
 */
export type RefTo = "users" | "deals" | "teams" | "companies" | "people" | "senders" | "doc";
export const REF_TARGETS: readonly RefTo[] = ["users", "deals", "teams", "companies", "people", "senders", "doc"];
/** The refs whose records the record service keeps: a write admits them from there (convex/lib/modules/scope.ts). */
export const RECORD_REFS = ["companies", "people"] as const satisfies readonly RefTo[];
export type RecordRefTo = (typeof RECORD_REFS)[number];
export const isRecordRef = (to: RefTo): to is RecordRefTo => (RECORD_REFS as readonly RefTo[]).includes(to);
/**
 * `parent` (a doc ref to a set collection): the sibling field holding the key of the doc it must sit under, so a
 * dispute's line item is one of its statement's lines. Its picker offers only that doc's set, and every write checks it.
 * `company` (a people ref): the sibling field holding a companies ref. Its picker offers that company's people once
 * one is picked; a write doesn't check it, so a visit's contacts may include a partner's.
 */
export type RefValidator = { type: "ref"; to: RefTo; collection?: string; parent?: string; company?: string };
/** A Canon ref in words: what a refusal says it must be, and what canon_module describe says it holds. */
const REF_WORDS: Record<Exclude<RefTo, "doc">, { must: string; holds: string }> = {
  users: { must: "a member of this workspace", holds: "a member's user id" },
  deals: { must: "a deal you can see", holds: "a deal's id (one the person can see)" },
  teams: { must: "a team of this workspace", holds: "a team's id" },
  companies: { must: "a company you can see", holds: "a company's id (one the person can see)" },
  senders: { must: "a mailbox you can see", holds: "a visible member mailbox id" },
  people: { must: "a person you can see", holds: "a person's id (one the person can see)" },
};
/**
 * A file the person uploads (docs/modules.md, "Files"): the field holds the id of a file Canon stores, readable only by
 * those who read the doc. `accept`: the file types it takes (`.pdf`, `image/png`, `image/*`); `maxBytes` its size.
 */
export type FileValidator = { type: "file"; accept?: readonly string[]; maxBytes?: number };
/** The most bytes one file holds, and what a file field takes when it doesn't say. */
export const FILE_MAX_BYTES = 19 * 1024 * 1024;
export const FILE_DEFAULT_BYTES = 10 * 1024 * 1024;
/** The most characters a text field's `maxLength` allows. */
export const TEXT_MAX = 100_000;
export type ValidatorJSON =
  | { type: "null" | "number" | "boolean" | "any" }
  /** `maxLength`: Canon's own key, the most characters the text holds (a 500-character note). */
  | { type: "string"; maxLength?: number }
  | { type: "literal"; value: string | number | boolean }
  | { type: "array"; value: ValidatorJSON }
  | { type: "object"; value: Record<string, FieldSpec> }
  /**
   * `labels`: what a table or form shows for each literal value, as `{ "won": "Closed won" }` (Canon's own key);
   * `descriptions`: a line under each in a form's choice ("Pays a percent of each deal's amount").
   */
  | { type: "union"; value: ValidatorJSON[]; labels?: Record<string, string>; descriptions?: Record<string, string> }
  | { type: "record"; keys: ValidatorJSON; values: FieldSpec }
  | RefValidator
  | FileValidator
  /** An object whose shape the sibling field `variantOf` picks: `cases[<its value>]`. A value with no case takes none. */
  | { type: "variant"; variantOf: string; cases: Record<string, ObjectValidator> };
export type ObjectValidator = Extract<ValidatorJSON, { type: "object" }>;
export type VariantValidator = Extract<ValidatorJSON, { type: "variant" }>;

const MAX_DEPTH = 8;
const MAX_FIELDS = 100;
const MAX_UNION = 50;
const FIELD = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
const PLAIN = new Set(["null", "number", "boolean", "string", "any"]);
/** A file type a file field accepts: an extension (`.pdf`) or a media type (`image/png`, `image/*`). */
const FILE_TYPE = /^(?:\.[a-z0-9]{1,10}|[a-z]+\/(?:\*|[a-z0-9][a-z0-9.+-]{0,60}))$/;

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** Why `v` isn't a validator Canon accepts, as `<path> ...` lines; empty when it is one. */
export function validatorProblems(v: unknown, path: string, depth = 0): string[] {
  if (depth > MAX_DEPTH) return [`${path} nests deeper than ${MAX_DEPTH} levels`];
  if (!isRecord(v) || typeof v.type !== "string") return [`${path} must be a validator with a type`];
  const keys = Object.keys(v);
  const only = (...allowed: string[]) => keys.filter((k) => !allowed.includes(k)).map((k) => `${path}.${k} is not a known key`);
  if (v.type === "string") {
    const ml = v.maxLength;
    return [...only("type", "maxLength"), ...(ml === undefined || (typeof ml === "number" && Number.isInteger(ml) && ml >= 1 && ml <= TEXT_MAX) ? [] : [`${path}.maxLength must be a whole number from 1 to ${TEXT_MAX}`])];
  }
  if (PLAIN.has(v.type)) return only("type");
  switch (v.type) {
    case "literal":
      return [...only("type", "value"), ...(["string", "number", "boolean"].includes(typeof v.value) ? [] : [`${path}.value must be text, a number or true/false`])];
    case "ref":
      if (v.to === "doc") return [...only("type", "to", "collection", "parent"), ...(typeof v.collection === "string" && FIELD.test(v.collection) ? [] : [`${path}.collection must name one of the module's collections`]),
        ...(v.parent === undefined || (typeof v.parent === "string" && FIELD.test(v.parent)) ? [] : [`${path}.parent must name a sibling field`])];
      if (v.to === "people") return [...only("type", "to", "company"), ...(v.company === undefined || (typeof v.company === "string" && FIELD.test(v.company)) ? [] : [`${path}.company must name a sibling field`])];
      return [...only("type", "to"), ...((REF_TARGETS as readonly unknown[]).includes(v.to) ? [] : [`${path}.to must be one of ${REF_TARGETS.join(", ")}`])];
    case "variant":
      return [`${path} is a variant, which only an object's field can be: its sibling field picks the case`];
    case "file": {
      const out = only("type", "accept", "maxBytes");
      if (v.accept !== undefined && (!Array.isArray(v.accept) || v.accept.length < 1 || v.accept.length > 20 || !v.accept.every((x) => typeof x === "string" && FILE_TYPE.test(x)))) out.push(`${path}.accept must be a list of 1 to 20 file types, as .pdf, image/png or image/*`);
      if (v.maxBytes !== undefined && (typeof v.maxBytes !== "number" || !Number.isInteger(v.maxBytes) || v.maxBytes < 1 || v.maxBytes > FILE_MAX_BYTES)) out.push(`${path}.maxBytes must be a whole number of bytes from 1 to ${FILE_MAX_BYTES}`);
      return out;
    }
    case "array":
      return [...only("type", "value"), ...validatorProblems(v.value, `${path}.value`, depth + 1)];
    case "union": {
      if (!Array.isArray(v.value) || v.value.length < 1 || v.value.length > MAX_UNION) return [`${path}.value must be a list of 1 to ${MAX_UNION} validators`];
      const inner = v.value.flatMap((x, i) => validatorProblems(x, `${path}.value[${i}]`, depth + 1));
      return [...only("type", "value", "labels", "descriptions"), ...inner,
        ...(v.labels === undefined || inner.length ? [] : labelProblems(v.labels, v.value as ValidatorJSON[], `${path}.labels`)),
        ...(v.descriptions === undefined || inner.length ? [] : labelProblems(v.descriptions, v.value as ValidatorJSON[], `${path}.descriptions`, 200))];
    }
    case "record": {
      const values = v.values;
      if (!isRecord(values) || values.optional !== false) return [`${path}.values must be { fieldType, optional: false }`];
      return [...only("type", "keys", "values"), ...validatorProblems(v.keys, `${path}.keys`, depth + 1), ...validatorProblems(values.fieldType, `${path}.values.fieldType`, depth + 1)];
    }
    case "object": {
      if (!isRecord(v.value) || Object.keys(v.value).length > MAX_FIELDS) return [`${path}.value must be an object of at most ${MAX_FIELDS} fields`];
      const fields = v.value;
      return [...only("type", "value"), ...Object.entries(fields).flatMap(([name, spec]) => {
        const at = `${path}.value.${name}`;
        if (!FIELD.test(name)) return [`${at} is not a field name (letters, digits and _, starting with a letter)`];
        if (!isRecord(spec) || typeof spec.optional !== "boolean") return [`${at} must be { fieldType, optional }`];
        const extra = Object.keys(spec).filter((k) => !["fieldType", "optional", "label", "widget", "help", "placeholder", "suggest", "inherit", "choicesBy"].includes(k)).map((k) => `${at}.${k} is not a known key`);
        const hints = [
          ...(spec.label === undefined || (typeof spec.label === "string" && spec.label.length >= 1 && spec.label.length <= 200) ? [] : [`${at}.label must be text of 1 to 200 characters`]),
          ...(spec.help === undefined || (typeof spec.help === "string" && spec.help.length >= 1 && spec.help.length <= 300) ? [] : [`${at}.help must be text of 1 to 300 characters`]),
          ...(spec.placeholder === undefined || (typeof spec.placeholder === "string" && spec.placeholder.length >= 1 && spec.placeholder.length <= 120) ? [] : [`${at}.placeholder must be text of 1 to 120 characters`]),
          ...(spec.inherit === undefined || (typeof spec.inherit === "string" && FIELD.test(spec.inherit)) ? [] : [`${at}.inherit must name a field of the form around it`]),
        ];
        const ft = spec.fieldType;
        const inner = isRecord(ft) && ft.type === "variant" ? variantProblems(ft, fields as Record<string, unknown>, name, `${at}.fieldType`, depth + 1) : validatorProblems(ft, `${at}.fieldType`, depth + 1);
        const core = inner.length ? null : coreOf(ft as ValidatorJSON);
        const textList = core?.type === "array" && coreOf(core.value).type === "string";
        const suggestOk = spec.suggest === true || (isRecord(spec.suggest) && Object.keys(spec.suggest).length === 1 && (typeof spec.suggest.deals === "string" || (isRecord(spec.suggest.deals) && Object.keys(spec.suggest.deals).length === 1 && typeof spec.suggest.deals.sibling === "string")));
        if (spec.suggest !== undefined && (!suggestOk || (core?.type !== "string" && !textList))) hints.push(`${at}.suggest is true or { deals }, on a text field or a list of text only`);
        if (isRecord(spec.suggest) && isRecord(spec.suggest.deals) && !Object.hasOwn(fields, String(spec.suggest.deals.sibling))) hints.push(`${at}.suggest.deals.sibling must name a sibling field`);
        if (spec.choicesBy !== undefined) hints.push(...choicesByProblems(spec.choicesBy, core, fields as Record<string, unknown>, name, `${at}.choicesBy`));
        if (core?.type === "ref" && core.parent !== undefined && (core.parent === name || !Object.hasOwn(fields, core.parent))) hints.push(`${at}.fieldType.parent must name a sibling field holding the parent doc's key`);
        // A people ref, or a list of them, scoped to the company its sibling names.
        const person = core?.type === "array" ? coreOf(core.value) : core;
        if (person?.type === "ref" && person.company !== undefined) {
          const sib = (fields as Record<string, unknown>)[person.company];
          const t = isRecord(sib) ? sib.fieldType : undefined;
          const ref = isRecord(t) ? (t.type === "union" && Array.isArray(t.value) ? t.value.find((x) => isRecord(x) && x.type === "ref") : t) : undefined;
          if (person.company === name || !isRecord(ref) || ref.type !== "ref" || ref.to !== "companies") hints.push(`${at}.fieldType.company must name a sibling field holding a companies ref`);
        }
        if (!inner.length && spec.widget !== undefined && !((WIDGETS as readonly unknown[]).includes(spec.widget) && widgetFits(spec.widget as Widget, spec as FieldSpec))) hints.push(`${at}.widget: a ${String(spec.widget)} widget can't edit ${name}`);
        return [...extra, ...hints, ...inner];
      })];
    }
    default:
      return [`${path}.type must be one of null, number, boolean, string, any, literal, array, object, union, record, ref, file, variant`];
  }
}

/** A `choicesBy`: a sibling holding literals, and per value of it some of the values this choice field holds. */
function choicesByProblems(c: unknown, core: ValidatorJSON | null, siblings: Record<string, unknown>, self: string, path: string): string[] {
  const own = core ? literalChoices(core) : null;
  if (!own) return [`${path} is only for a field holding one of a list of values`];
  if (!isRecord(c) || typeof c.sibling !== "string" || !isRecord(c.cases) || Object.keys(c).some((k) => k !== "sibling" && k !== "cases" && k !== "labels")) return [`${path} must be { sibling, cases }`];
  const sib = c.sibling !== self && isRecord(siblings[c.sibling]) ? literalChoices((siblings[c.sibling] as FieldSpec).fieldType) : null;
  if (!sib) return [`${path}.sibling must name a sibling field that holds one of a list of values`];
  const out: string[] = [];
  for (const [k, vs] of Object.entries(c.cases)) {
    if (!sib.map(String).includes(k)) out.push(`${path}.cases.${k} is not a value ${c.sibling} holds`);
    if (!Array.isArray(vs) || !vs.length || !vs.every((x) => own.some((o) => o === x))) out.push(`${path}.cases.${k} must list values ${self} holds`);
  }
  if (c.labels !== undefined) {
    if (!isRecord(c.labels)) out.push(`${path}.labels must map sibling values to choice labels`);
    else for (const [key, labels] of Object.entries(c.labels)) {
      if (!Object.hasOwn(c.cases, key) || !isRecord(labels) || Object.entries(labels).some(([value, label]) => !own.some((x) => String(x) === value) || typeof label !== "string" || label.length > 200)) out.push(`${path}.labels.${key} must label declared choices of a declared sibling value`);
    }
  }
  return out;
}

/** A variant field: its sibling holds literals, and each case is an object named by one of them. */
function variantProblems(v: Record<string, unknown>, siblings: Record<string, unknown>, self: string, path: string, depth: number): string[] {
  const out = Object.keys(v).filter((k) => !["type", "variantOf", "cases"].includes(k)).map((k) => `${path}.${k} is not a known key`);
  const of = typeof v.variantOf === "string" ? v.variantOf : null;
  const sibling = of !== null && of !== self && isRecord(siblings[of]) ? (siblings[of] as FieldSpec).fieldType : null;
  const values = sibling ? literalChoices(sibling) : null;
  if (!values) out.push(`${path}.variantOf must name a sibling field that holds one of a list of values`);
  if (!isRecord(v.cases) || !Object.keys(v.cases).length || Object.keys(v.cases).length > MAX_UNION) return [...out, `${path}.cases must be an object of 1 to ${MAX_UNION} cases`];
  for (const [k, c] of Object.entries(v.cases)) {
    if (values && !values.map(String).includes(k)) out.push(`${path}.cases.${k} is not a value ${of} holds`);
    if (!isRecord(c) || c.type !== "object") out.push(`${path}.cases.${k} must be an object validator`);
    else out.push(...validatorProblems(c, `${path}.cases.${k}`, depth));
  }
  return out;
}

/** A union's `labels` (or `descriptions`): text of 1 to 60 (`max`) characters for literal values the union holds. */
function labelProblems(labels: unknown, members: ValidatorJSON[], path: string, max = 60): string[] {
  if (!isRecord(labels)) return [`${path} must be an object of value: label`];
  const values = new Set(members.flatMap((x) => (x.type === "literal" ? [String(x.value)] : [])));
  return Object.entries(labels).flatMap(([k, label]) => [
    ...(values.has(k) ? [] : [`${path}.${k} is not one of the union's literal values`]),
    ...(typeof label === "string" && label.length >= 1 && label.length <= max ? [] : [`${path}.${k} must be text of 1 to ${max} characters`]),
  ]);
}

/** Whether `id` names a record a `ref` may hold: a member, a deal or team the writer can see, a module doc. */
export type RefCheck = (ref: RefValidator, id: string) => boolean;
/** Why a file id can't go in a file field (null: it can): not the writer's upload, too big, or a type it doesn't take. */
export type FileCheck = (file: FileValidator, id: string) => string | null;

/**
 * Why `value` doesn't fit `v`, as `<path> ...` lines. `refOk` says whether an id names what a ref may hold, `fileOk`
 * whether a file id names a file the field takes.
 */
export function valueProblems(value: unknown, v: ValidatorJSON, path: string, refOk: RefCheck, fileOk: FileCheck = () => "isn't a file"): string[] {
  const inner = (x: unknown, w: ValidatorJSON, at: string) => valueProblems(x, w, at, refOk, fileOk);
  switch (v.type) {
    case "any": return value === undefined ? [`${path} is missing`] : [];
    case "null": return value === null ? [] : [`${path} must be null`];
    case "number": return typeof value === "number" && Number.isFinite(value) ? [] : [`${path} must be a number`];
    case "boolean": return typeof value === "boolean" ? [] : [`${path} must be true or false`];
    case "string": return typeof value !== "string" ? [`${path} must be text`] : v.maxLength !== undefined && value.length > v.maxLength ? [`${path} is ${value.length} characters; it holds at most ${v.maxLength}`] : [];
    case "literal": return value === v.value ? [] : [`${path} must be ${JSON.stringify(v.value)}`];
    case "ref": return typeof value === "string" && refOk(v, value) ? [] : [`${path} must be ${describe(v)}`];
    case "file": { if (typeof value !== "string") return [`${path} must be a file`]; const why = fileOk(v, value); return why === null ? [] : [`${path} ${why}`]; }
    case "variant": return [`${path} has no sibling to pick its shape`];
    case "array": return Array.isArray(value) ? value.flatMap((x, i) => inner(x, v.value, `${path}[${i}]`)) : [`${path} must be a list`];
    case "union": return v.value.some((x) => !inner(value, x, path).length) ? [] : [`${path} must be ${describe(v)}`];
    case "record":
      if (!isRecord(value)) return [`${path} must be an object`];
      return Object.entries(value).flatMap(([k, x]) => [...inner(k, v.keys, `${path} key ${k}`), ...inner(x, v.values.fieldType, `${path}.${k}`)]);
    case "object": {
      if (!isRecord(value)) return [`${path} must be an object`];
      const unknown = Object.keys(value).filter((k) => !Object.hasOwn(v.value, k)).map((k) => `${path}.${k} is not a field`);
      return [...unknown, ...Object.entries(v.value).flatMap(([k, spec]) => {
        if (spec.fieldType.type === "variant") {
          const shape = caseOf(spec.fieldType, value);
          if (!shape) return value[k] === undefined ? [] : [`${path}.${k} is only for a ${spec.fieldType.variantOf} that has one; ${JSON.stringify(value[spec.fieldType.variantOf] ?? null)} takes none`];
          if (value[k] === undefined) return spec.optional ? [] : [`${path}.${k} is missing`];
          return inner(value[k], shape, `${path}.${k}`);
        }
        if (value[k] === undefined) return spec.optional ? [] : [`${path}.${k} is missing`];
        return inner(value[k], spec.fieldType, `${path}.${k}`);
      })];
    }
  }
}

/** A field's name in words: "signatureText" is "Signature text". */
export const humanName = (field: string) => field.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase()).replace(/ ([A-Z])/g, (_m, c: string) => ` ${c.toLowerCase()}`);

/**
 * A problem `valueProblems` found under `data`, in plain words a form's reader knows: the field's label (its spec's,
 * else its name in words) for its path, a list's row by its number, and "is required" for "is missing". "data.tiers[1].rate
 * is missing" reads "Tiers, row 2, rate is required". Null for a problem that names no field.
 */
export function plainProblem(problem: string, schema: ObjectValidator): string | null {
  const m = /^data\.([a-zA-Z][a-zA-Z0-9_]*)((?:\[\d+\]|\.[a-zA-Z][a-zA-Z0-9_]*)*)(?: key \S+)? (.*)$/.exec(problem);
  if (!m) return null;
  const [, field, rest, what] = m;
  const spec = schema.value[field];
  const inner = [...rest.matchAll(/\[(\d+)\]|\.([a-zA-Z][a-zA-Z0-9_]*)/g)].map((x) => (x[1] !== undefined ? `row ${Number(x[1]) + 1}` : humanName(x[2]).toLowerCase()));
  const name = [spec?.label ?? humanName(field), ...inner].join(", ");
  return `${name} ${what === "is missing" ? "is required" : what}`;
}

/** The case of a variant field its sibling picks in `obj`, or null when it picks none. */
export function caseOf(v: VariantValidator, obj: Record<string, unknown>): ObjectValidator | null {
  const tag = obj[v.variantOf];
  return tag === undefined || tag === null ? null : v.cases[String(tag)] ?? null;
}

/** The ids `value` holds where `v` allows a ref, each with what it refers to, so a write can check them first. */
export function refsIn(value: unknown, v: ValidatorJSON): Array<{ ref: RefValidator; id: string }> {
  switch (v.type) {
    case "ref": return typeof value === "string" ? [{ ref: v, id: value }] : [];
    case "array": return Array.isArray(value) ? value.flatMap((x) => refsIn(x, v.value)) : [];
    case "union": return v.value.flatMap((x) => refsIn(value, x));
    case "record": return isRecord(value) ? Object.values(value).flatMap((x) => refsIn(x, v.values.fieldType)) : [];
    case "object": return isRecord(value) ? Object.entries(v.value).flatMap(([k, s]) => {
      if (s.fieldType.type !== "variant") return refsIn(value[k], s.fieldType);
      const shape = caseOf(s.fieldType, value);
      return shape ? refsIn(value[k], shape) : [];
    }) : [];
    default: return [];
  }
}

/** The file ids `value` holds where `v` allows a file, each with its field's validator, so a write can check them first. */
export function filesIn(value: unknown, v: ValidatorJSON): Array<{ file: FileValidator; id: string }> {
  switch (v.type) {
    case "file": return typeof value === "string" ? [{ file: v, id: value }] : [];
    case "array": return Array.isArray(value) ? value.flatMap((x) => filesIn(x, v.value)) : [];
    case "union": return v.value.flatMap((x) => filesIn(value, x));
    case "record": return isRecord(value) ? Object.values(value).flatMap((x) => filesIn(x, v.values.fieldType)) : [];
    case "object": return isRecord(value) ? Object.entries(v.value).flatMap(([k, s]) => {
      if (s.fieldType.type !== "variant") return filesIn(value[k], s.fieldType);
      const shape = caseOf(s.fieldType, value);
      return shape ? filesIn(value[k], shape) : [];
    }) : [];
    default: return [];
  }
}

/**
 * The doc refs `value` holds that must sit under a parent (`parent`), each with the parent key its sibling field holds
 * (null when it holds none), so a write can check each doc's parent.
 */
export function parentRefsIn(value: unknown, v: ValidatorJSON): Array<{ collection: string; id: string; parentKey: string | null; field: string }> {
  switch (v.type) {
    case "array": return Array.isArray(value) ? value.flatMap((x) => parentRefsIn(x, v.value)) : [];
    case "union": return v.value.flatMap((x) => parentRefsIn(value, x));
    case "object": return isRecord(value) ? Object.entries(v.value).flatMap(([k, s]) => {
      if (s.fieldType.type === "variant") { const shape = caseOf(s.fieldType, value); return shape ? parentRefsIn(value[k], shape) : []; }
      const core = coreOf(s.fieldType);
      if (core.type === "ref" && core.to === "doc" && core.parent !== undefined && typeof value[k] === "string") {
        const p = value[core.parent];
        return [{ collection: core.collection ?? "", id: value[k] as string, parentKey: typeof p === "string" ? p : null, field: k }];
      }
      return parentRefsIn(value[k], s.fieldType);
    }) : [];
    default: return [];
  }
}

/** Whether a validator holds a file anywhere: a file field, a list of them, or one inside an object or a variant's case. */
export function holdsFile(v: ValidatorJSON): boolean {
  switch (v.type) {
    case "file": return true;
    case "array": return holdsFile(v.value);
    case "union": return v.value.some(holdsFile);
    case "record": return holdsFile(v.values.fieldType);
    case "object": return Object.values(v.value).some((s) => holdsFile(s.fieldType));
    case "variant": return Object.values(v.cases).some(holdsFile);
    default: return false;
  }
}

/** Whether a file of `name` and media `type`, `bytes` long, fits a file field: its size, then one of its types. Null: it does. */
export function fileFits(v: FileValidator, file: { name: string; type: string; bytes: number }): string | null {
  const max = v.maxBytes ?? FILE_DEFAULT_BYTES;
  if (file.bytes > max) return `is ${(file.bytes / 1048576).toFixed(1)} MB; it takes files of at most ${(max / 1048576).toFixed(max % 1048576 ? 1 : 0)} MB`;
  if (!v.accept?.length) return null;
  const ext = /\.[a-z0-9]{1,10}$/i.exec(file.name)?.[0].toLowerCase() ?? "";
  const mime = file.type.toLowerCase();
  const ok = v.accept.some((a) => (a.startsWith(".") ? a === ext : a.endsWith("/*") ? mime.startsWith(a.slice(0, -1)) : a === mime));
  return ok ? null : `takes ${v.accept.join(", ")} files, not ${ext || mime || "this file"}`;
}

/** A validator in words, for a refusal: `one of "open", "won"`. */
export function describe(v: ValidatorJSON): string {
  if (v.type === "union") return `one of ${v.value.map(describe).join(", ")}`;
  if (v.type === "literal") return JSON.stringify(v.value);
  if (v.type === "ref") return v.to === "doc" ? `a ${v.collection} doc you can see` : REF_WORDS[v.to].must;
  if (v.type === "variant") return `the shape its ${v.variantOf} picks`;
  if (v.type === "file") return "a file";
  return v.type === "string" ? "text" : v.type;
}

/** The choices a union of literals offers, or null for any other validator. */
export function literalChoices(v: ValidatorJSON): Array<string | number | boolean> | null {
  if (v.type === "literal") return [v.value];
  if (v.type !== "union") return null;
  const out: Array<string | number | boolean> = [];
  for (const x of v.value) {
    if (x.type === "null") continue;
    if (x.type !== "literal") return null;
    out.push(x.value);
  }
  return out;
}

/** The labels a field's choices show with, by value, or null: a union's `labels`, through an optional null. */
export function choiceLabels(v: ValidatorJSON): Record<string, string> | null {
  return v.type === "union" && v.labels ? v.labels : null;
}
/** The line under each of a field's choices, by value, or null: a union's `descriptions`. */
export function choiceDescriptions(v: ValidatorJSON): Record<string, string> | null {
  return v.type === "union" && v.descriptions ? v.descriptions : null;
}

/** Whether `v` holds one scalar (text, a number, true/false, a literal or a ref), so an index can order by it. */
export function isScalar(v: ValidatorJSON): boolean {
  if (v.type === "union") return v.value.every(isScalar);
  return v.type === "string" || v.type === "number" || v.type === "boolean" || v.type === "literal" || v.type === "null" || v.type === "ref";
}

/**
 * The widgets a form edits a field with. `user` picks a member, `ref` a deal, team or module doc (searched as the
 * caller sees them); `time` a time in ms, picked as a day (its start, UTC) and shown as a date and time; `tristate` is yes, no or not set; `list` edits rows (add, remove, reorder), `object` a nested
 * object's fields and `variant` the fields of the case its sibling picks.
 */
/** `call`: a text holding a Canon call's id, picked from the calls the person reads and shown as the call's title. */
export type Widget = "text" | "textarea" | "number" | "money" | "percent" | "date" | "time" | "bool" | "tristate" | "choice" | "user" | "ref" | "file" | "list" | "object" | "variant" | "call";
export const WIDGETS: readonly Widget[] = ["text", "textarea", "number", "money", "percent", "date", "time", "bool", "tristate", "choice", "user", "ref", "file", "list", "object", "variant", "call"];

/** A field's validator without an optional null around it. */
export function coreOf(v: ValidatorJSON): ValidatorJSON {
  return v.type === "union" && v.value.some((x) => x.type === "null") && v.value.filter((x) => x.type !== "null").length === 1 ? v.value.find((x) => x.type !== "null")! : v;
}

/** Containers of a nested field, through list rows and variant cases. */
export function fieldParentsAt(spec: FieldSpec, path: readonly string[]): ObjectValidator[] {
  const core = coreOf(spec.fieldType);
  if (core.type === "array") return fieldParentsAt({ fieldType: core.value, optional: false }, path);
  if (core.type === "variant") return Object.values(core.cases).flatMap((c) => fieldParentsAt({ fieldType: c, optional: false }, path));
  if (core.type !== "object" || !core.value[path[0]]) return [];
  return path.length === 1 ? [core] : fieldParentsAt(core.value[path[0]], path.slice(1));
}

/** Transform every matching object field, preserving list, variant and nullable wrappers. */
export function mapFieldSpecAt(spec: FieldSpec, path: readonly string[], map: (field: FieldSpec) => FieldSpec): FieldSpec | null {
  if (!path.length) return map(spec);
  const core = coreOf(spec.fieldType);
  let changed: ValidatorJSON;
  if (core.type === "array") {
    const child = mapFieldSpecAt({ fieldType: core.value, optional: false }, path, map);
    if (!child) return null;
    changed = { ...core, value: child.fieldType };
  } else if (core.type === "variant") {
    let found = false;
    const cases = Object.fromEntries(Object.entries(core.cases).map(([key, value]) => {
      const child = mapFieldSpecAt({ fieldType: value, optional: false }, path, map);
      if (child) found = true;
      return [key, child?.fieldType as ObjectValidator ?? value];
    }));
    if (!found) return null;
    changed = { ...core, cases };
  } else {
    if (core.type !== "object" || !Object.hasOwn(core.value, path[0])) return null;
    const child = mapFieldSpecAt(core.value[path[0]], path.slice(1), map);
    if (!child) return null;
    changed = { ...core, value: { ...core.value, [path[0]]: child } };
  }
  return { ...spec, fieldType: spec.fieldType.type === "union" ? { ...spec.fieldType, value: spec.fieldType.value.map((v) => v === core ? changed : v) } : changed };
}

/** Metadata choices change the editor's item schema while retaining arrays and nullable wrappers. */
export function withFieldChoices(spec: FieldSpec, choices: readonly (string | number)[], labels: Record<string, string>, by?: ChoicesBy): FieldSpec {
  const choice: ValidatorJSON = { type: "union", value: choices.map((value) => ({ type: "literal", value })), labels };
  const core = coreOf(spec.fieldType);
  const value = core.type === "array" ? { ...core, value: choice } : choice;
  const fieldType = spec.fieldType.type === "union" && spec.fieldType !== core
    ? { ...spec.fieldType, value: spec.fieldType.value.map((v) => v === core ? value : v) } : value;
  return { ...spec, fieldType, ...(core.type === "array" ? { widget: "list" } : { widget: "choice" }), ...(by ? { choicesBy: by } : {}) };
}

/** The widget a field gets when the page names none, from its validator. Null for a shape no widget edits. */
/** Whether a field holds only `true`: its checkbox is required ticked, and a form counts it unfilled until it is. */
export function mustTick(v: ValidatorJSON): boolean {
  const core = coreOf(v);
  return core.type === "literal" && core.value === true;
}
export function defaultWidget(v: ValidatorJSON): Widget | null {
  const core = coreOf(v);
  // `true` alone: a box the person must tick (I agree to this plan), unfilled until they do.
  if (mustTick(core)) return "bool";
  if (literalChoices(core)) return "choice";
  switch (core.type) {
    case "string": return "text";
    case "number": return "number";
    case "boolean": return "bool";
    case "ref": return core.to === "users" ? "user" : "ref";
    case "file": return "file";
    case "object": return Object.values(core.value).every((s) => widgetOf(s) !== null) ? "object" : null;
    case "variant": return Object.values(core.cases).every((c) => Object.values(c.value).every((s) => widgetOf(s) !== null)) ? "variant" : null;
    case "array": return defaultWidget(core.value) === null ? null : "list";
    default: return null;
  }
}

/** The widget a field shows with: its own `widget`, else its shape's, an optional true/false as yes, no or not set. */
export function widgetOf(spec: FieldSpec): Widget | null {
  if (spec.widget) return spec.widget;
  const w = defaultWidget(spec.fieldType);
  return w === "bool" && spec.optional ? "tristate" : w;
}

/** The widgets that can edit a field: a page may pick any of them. */
export function widgetFits(widget: Widget, spec: FieldSpec | ValidatorJSON): boolean {
  const base = defaultWidget("fieldType" in spec ? spec.fieldType : spec);
  if (base === null) return false;
  if (base === "text") return widget === "text" || widget === "textarea" || widget === "date" || widget === "call";
  // `time`: a number holding a time in ms, picked as a date and shown as one everywhere.
  if (base === "number") return widget === "number" || widget === "money" || widget === "percent" || widget === "time";
  if (base === "bool") return widget === "bool" || widget === "tristate";
  return widget === base;
}

/** A validator as JSON Schema, for an agent reading `canon_module describe`. A variant is its object's `allOf` of if/then. */
export function jsonSchema(v: ValidatorJSON): Record<string, unknown> {
  switch (v.type) {
    case "any": return {};
    case "null": return { type: "null" };
    case "number": return { type: "number" };
    case "boolean": return { type: "boolean" };
    case "string": return { type: "string", ...(v.maxLength !== undefined ? { maxLength: v.maxLength } : {}) };
    case "literal": return { const: v.value };
    case "file": return { type: "string", description: `the id of a file uploaded in Canon${v.accept?.length ? ` (${v.accept.join(", ")})` : ""}; canon_module file downloads one` };
    case "ref": return { type: "string", description: v.to === "doc" ? `the key of a ${v.collection} doc` : REF_WORDS[v.to].holds };
    case "variant": return { type: "object", description: `its shape depends on ${v.variantOf}: ${Object.keys(v.cases).join(", ")}`, anyOf: Object.values(v.cases).map(jsonSchema) };
    case "array": return { type: "array", items: jsonSchema(v.value) };
    case "union": return { anyOf: v.value.map(jsonSchema), ...(v.labels ? { description: `Shown as: ${Object.entries(v.labels).map(([k, l]) => `${k} = ${l}`).join(", ")}` } : {}) };
    case "record": return { type: "object", additionalProperties: jsonSchema(v.values.fieldType) };
    case "object": {
      const variants = Object.entries(v.value).flatMap(([k, s]) => (s.fieldType.type === "variant" ? [[k, s.fieldType] as const] : []));
      const conditions = variants.flatMap(([k, vt]) => Object.entries(vt.cases).map(([tag, c]) => ({ if: { properties: { [vt.variantOf]: { const: literalOf(v.value[vt.variantOf]?.fieldType, tag) } }, required: [vt.variantOf] }, then: { properties: { [k]: jsonSchema(c) } } })));
      return {
        type: "object", additionalProperties: false,
        properties: Object.fromEntries(Object.entries(v.value).map(([k, s]) => {
          const base = jsonSchema(s.fieldType);
          const description = [s.help, base.description].filter(Boolean).join(" ");
          return [k, { ...base, ...(s.label ? { title: s.label } : {}), ...(description ? { description } : {}) }];
        })),
        required: Object.entries(v.value).filter(([, s]) => !s.optional).map(([k]) => k),
        ...(conditions.length ? { allOf: conditions } : {}),
      };
    }
  }
}

/** A case's key as the literal its sibling holds (a number or true/false stays one). */
const literalOf = (v: ValidatorJSON | undefined, tag: string) => (v ? literalChoices(coreOf(v))?.find((x) => String(x) === tag) ?? tag : tag);

/**
 * A form's values with every `inherit` field nested in them set from the form around it (docs/modules.md, "Fields that
 * follow other fields"): an override row's plan from the assignment's. `context`: the values the form doesn't show (the
 * doc an update edits, the fixed ones), under the form's own.
 */
export function inheritInto(fields: ReadonlyArray<{ field: string; spec: FieldSpec }>, data: Record<string, unknown>, context: Record<string, unknown> = {}): Record<string, unknown> {
  const outer = { ...context, ...data };
  const out = { ...data };
  for (const f of fields) {
    if (out[f.field] === undefined) continue;
    // A variant is the object of the case its sibling picks.
    const ft = f.spec.fieldType, shape = ft.type === "variant" ? caseOf(ft, outer) : ft;
    if (shape) out[f.field] = inheritIn(out[f.field], shape, outer);
  }
  return out;
}
function inheritIn(value: unknown, t: ValidatorJSON, outer: Record<string, unknown>): unknown {
  const core = coreOf(t);
  if (core.type === "array") return Array.isArray(value) ? value.map((x) => inheritIn(x, core.value, outer)) : value;
  if (core.type !== "object" || !isRecord(value)) return value;
  const o: Record<string, unknown> = { ...value };
  for (const [k, spec] of Object.entries(core.value)) if (spec.inherit && outer[spec.inherit] !== undefined && outer[spec.inherit] !== null) o[k] = outer[spec.inherit];
  const inner = { ...outer, ...o };
  for (const [k, spec] of Object.entries(core.value)) {
    if (o[k] === undefined) continue;
    const ft = spec.fieldType;
    if (ft.type === "variant") { const shape = caseOf(ft, o); if (shape) o[k] = inheritIn(o[k], shape, inner); }
    else o[k] = inheritIn(o[k], ft, inner);
  }
  return o;
}

/** A choice field's choices as its `choicesBy` sibling narrows them (a condition's operators by the field it tests). */
export function choicesFor<C extends string | number | boolean>(spec: FieldSpec, choices: readonly C[] | null | undefined, siblings: Record<string, unknown>): readonly C[] | null | undefined {
  const by = spec.choicesBy;
  const v = by ? siblings[by.sibling] : undefined;
  const only = by && v !== undefined && v !== null ? by.cases[String(v)] : undefined;
  return only ? (choices ?? []).filter((c) => only.some((x) => String(x) === String(c))) : choices;
}

/**
 * A form's starting values with every field that offers choices (a member field's `options`) starting among them: a
 * value outside them (an `initial`, the person creating it) becomes the only choice, or nothing. Values in `kept` (the
 * doc an update edits) stay as stored. A task's owner among the visit's attendees never starts as someone who isn't one.
 */
export function startWithin(fields: ReadonlyArray<{ field: string; choices?: ReadonlyArray<string | number | boolean> | null }>, start: Record<string, unknown>, kept: Record<string, unknown> = {}): Record<string, unknown> {
  const out = { ...start };
  for (const f of fields) {
    const v = out[f.field];
    if (!f.choices || Object.hasOwn(kept, f.field) || v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) { out[f.field] = v.filter((x) => f.choices!.some((c) => String(c) === String(x))); continue; }
    if (f.choices.some((c) => String(c) === String(v))) continue;
    if (f.choices.length === 1) out[f.field] = f.choices[0];
    else delete out[f.field];
  }
  return out;
}
