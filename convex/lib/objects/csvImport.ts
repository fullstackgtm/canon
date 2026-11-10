/**
 * CSV import of companies, people and deals (CP10, docs/core-crm-parity.md):
 * parse a file, map its columns to registry fields, decide what every row
 * would do before anything is written, and write a company or person row
 * through the account and contact ledger (lib/canon/partyLedger.ts). Deals
 * are written by convex/csvImports.ts through the deal save path. Every other
 * object, and activities with their targets, is csvRecords.ts.
 *
 * Every row is written to the ledger as an `import` snapshot, source
 * `csv:<importId>:<row>`, where the import id is a digest of the file. A row
 * that matches a register row is promoted onto it, as a first edit is
 * (docs/cp0-object-layer.md, "One register"); a new one gets a stream the
 * projector inserts a register row for. Importing the same file again
 * re-asserts the same values from the same sources, which changes nothing.
 *
 * Pure apart from writeImportRow, which runs against PartyStores. No Node-only
 * imports: Convex actions, mutations and the browser share it.
 */
import { ensureEntity } from "../canon/ledger.ts";
import { accountExternalIds, contactExternalIds, normalizeDomain, normalizeEmail } from "../canon/identity.ts";
import {
  recordSeed, writeParty, type PartyObject, type PartyStores, type PartyValues, type PartyWriteResult,
  type RecordAccountSnapshot, type RecordContactSnapshot,
} from "../canon/partyLedger.ts";
import { planDealCreate, type DealCreateInput, type Pipeline } from "../pipelines.ts";
import { isCustomField, REGISTER_COLUMNS } from "./listSpec.ts";
import { coerce, DEAL_ROLES, isMultiValueType, type CoerceError, type DealRole, type FieldDef, type ResolvedObjectDef } from "./registry.ts";

export type ImportObject = PartyObject | "deal";
export const IMPORT_OBJECTS: readonly ImportObject[] = ["account", "contact", "deal"];
export const IMPORT_ROWS_MAX = 25_000;

/** The registry field (or import column, see IMPORT_COLUMNS) each column fills, by column position; null leaves the column out. */
export type ImportMapping = readonly (string | null)[];

/** The register row a dedupe key found: a row with a stream is written there, an unworked one is promoted. */
export type ImportMatch = { recordId: string; stream: string | null; snapshot: RecordAccountSnapshot | RecordContactSnapshot };
/** A Canon deal with a row's name: its company link, and whether a CRM sync links it to a CRM account instead (deals.ts companyLinkOf). */
export type DealMatch = { dealId: string; companyId: string | null; crmAccount: boolean };

/** A row's Company cell against the register: a company found by domain or exact name, one this import creates, or a row error. */
export type CompanyLink = { kind: "linked"; companyId: string } | { kind: "created"; cell: string };
export type CompanyMiss = { kind: "unmatched"; cell: string } | { kind: "ambiguous"; cell: string; count: number };
export type CompanyMatch = CompanyLink | CompanyMiss;

/** A person on a deal's Contacts cell: an email and a role (`email:role`, `involved` when none is given). */
export type DealPerson = { email: string; role: DealRole };
/** A deal's person as the preview resolved them: the register's id for the email. */
export type DealMember = { contactId: string; role: DealRole };

/**
 * What a row carries beyond its Company cell: a person's other companies (the Company cell, else the first of
 * these, is primary), a deal's people with roles, and what the row could not link (it still imports).
 * `again` marks a keyless row an earlier run of this file already wrote: it lands unchanged, so the preview counts it as an update.
 */
export type RowLinks = { links?: CompanyLink[]; members?: DealMember[]; warnings?: string[]; again?: true; ownerId?: string; ownerMiss?: string; columns?: DealColumns };

/**
 * A deal's values the deals row holds and its ledger doesn't, as a CRM sync sets them: its revenue type, contract
 * length in months and products. An import writes them on the row (csvImports.ts writeDeals).
 */
export type DealColumns = { revenueType?: "one_time" | "recurring"; contractLengthMonths?: number; products?: string[] };

/** What one data row does. `row` is its spreadsheet row number (the header is row 1). `company` is null when the row names none. */
export type RowOutcome<M = ImportMatch> =
  | ({ kind: "create"; row: number; key: string | null; values: PartyValues; company: CompanyLink | null } & RowLinks)
  | ({ kind: "update"; row: number; key: string; values: PartyValues; match: M; company: CompanyLink | null } & RowLinks)
  | { kind: "skip"; row: number; reason: string }
  | { kind: "error"; row: number; errors: readonly CoerceError[]; company?: CompanyMiss };
export type DealOutcome = RowOutcome<DealMatch>;

/** A row read and typed, before dedupe. `company` is its Company cell, `companies` the cells of its Companies column, `people` its Contacts column. */
export type ReadRow =
  | { kind: "read"; row: number; key: string | null; values: PartyValues; company: string | null; companies?: string[]; people?: DealPerson[]; owner?: string; columns?: DealColumns }
  | { kind: "skip"; row: number; reason: string }
  | { kind: "error"; row: number; errors: readonly CoerceError[] };

/** The separator a file uses, read from its header line: a comma unless semicolons or tabs (Excel in many locales) outnumber commas outside quotes. */
function delimiterOf(src: string): string {
  const count = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  for (let i = 0; i < src.length && (quoted || (src[i] !== "\n" && src[i] !== "\r")); i++) {
    if (src[i] === '"') quoted = !quoted;
    else if (!quoted && src[i] in count) count[src[i] as keyof typeof count]++;
  }
  return count[";"] > count[","] && count[";"] >= count["\t"] ? ";" : count["\t"] > count[","] ? "\t" : ",";
}

/** The records of an RFC 4180 file: quoted cells, "" escapes, CRLF, a leading BOM, commas, semicolons or tabs. A blank line is an empty record. */
export function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = "";
  let quoted = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const delimiter = delimiterOf(src);
  const endCell = () => {
    record.push(cell);
    cell = "";
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (src[i + 1] === '"') cell += src[++i];
      else quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) endCell();
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      endCell();
      records.push(record);
      record = [];
    } else cell += ch;
  }
  if (cell || record.length) {
    endCell();
    records.push(record);
  }
  return records;
}

/**
 * Deal fields a CSV fills. The stage sets the forecast category, probability, closed and won; the company comes from
 * the Company column; Notes fill the deal's description. No column maps to a CRM id: an import never links a deal to
 * a CRM record (M16).
 */
const DEAL_FIELDS = new Set(["name", "amount", "currency", "closeDate", "stage", "dealType", "nextStep", "description"]);
/** A field's name in the wizard where it differs from the record's: a deal's description takes a file's notes. */
const IMPORT_LABELS: Readonly<Record<ImportObject, Readonly<Record<string, string>>>> = { account: {}, contact: {}, deal: { description: "Notes (description)" } };

/**
 * The fields a CSV may fill: the register's columns (a deal's own) and the
 * object's custom fields that are not archived, less users (a Canon user, not
 * a CSV value) and lookups (a record id, not a CSV value).
 */
export function importableFields(object: ImportObject, def: ResolvedObjectDef): FieldDef[] {
  // Deals are written through their scalar writer (csvImports.ts factValues), so a deal import leaves list-valued fields out.
  const listValued = (f: FieldDef) => f.type === "multipicklist" || isMultiValueType(f.type);
  const has = (f: FieldDef) => (object === "deal" ? DEAL_FIELDS.has(f.apiName) : Object.hasOwn(REGISTER_COLUMNS[object], f.fieldId))
    || (isCustomField(f) && f.archivedAt === undefined && f.type !== "lookup" && f.type !== "formula" && !(object === "deal" && listValued(f)));
  return def.fields.filter((f) => !f.system && f.type !== "user" && has(f));
}

/**
 * Columns read beside the registry fields: a company by domain or name, a deal's pipeline by name, and the
 * association columns: a person's several companies, a deal's people with roles.
 */
const IMPORT_COLUMNS: Readonly<Record<ImportObject, ReadonlyArray<{ apiName: string; label: string }>>> = {
  account: [],
  contact: [{ apiName: "company", label: "Company" }, { apiName: "companies", label: "Companies (separated by ;, the first is primary)" }],
  deal: [
    { apiName: "company", label: "Company" }, { apiName: "pipeline", label: "Pipeline" },
    { apiName: "contacts", label: "Contacts (email:role, separated by ;)" },
    { apiName: "owner", label: "Owner (a member's email or name)" },
    { apiName: "revenueType", label: "Revenue type (one time or recurring)" },
    { apiName: "contractLength", label: "Contract length (months)" },
    { apiName: "products", label: "Products (separated by ;)" },
  ],
};

/** Everything a column may map to, as the wizard lists it. */
export const importColumns = (object: ImportObject, def: ResolvedObjectDef) =>
  [...importableFields(object, def).map((f) => ({ apiName: f.apiName, label: IMPORT_LABELS[object][f.apiName] ?? f.label })), ...IMPORT_COLUMNS[object]];

export const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Headers other tools export, by normalized header. */
const SYNONYMS: Readonly<Record<ImportObject, Readonly<Record<string, string>>>> = {
  account: {
    company: "name", companyname: "name", account: "name", accountname: "name", organization: "name", website: "domain", url: "domain", companydomain: "domain",
    companywebsite: "domain", numberofemployees: "employees", employeecount: "employees", headcount: "employees", revenue: "annualRevenue", linkedin: "linkedinUrl",
  },
  contact: {
    name: "fullName", firstname: "fullName", lastname: "fullName", emailaddress: "email", workemail: "email", jobtitle: "title", position: "title",
    phonenumber: "phone", mobile: "phone", linkedin: "linkedinUrl", stage: "lifecycleStage", lifecycle: "lifecycleStage",
    companyname: "company", account: "company", accountname: "company", organization: "company", employer: "company", companydomain: "company",
    associatedcompanies: "companies", othercompanies: "companies",
  },
  deal: {
    deal: "name", dealname: "name", opportunity: "name", opportunityname: "name", value: "amount", dealvalue: "amount", dealamount: "amount", dealstage: "stage",
    expectedclosedate: "closeDate", companyname: "company", account: "company", accountname: "company", organization: "company",
    companydomain: "company", type: "dealType", associatedcontacts: "contacts", people: "contacts", buyingcommittee: "contacts",
    dealowner: "owner", owneremail: "owner", opportunityowner: "owner", rep: "owner", repemail: "owner", salesrep: "owner", assignedto: "owner",
    revenue: "revenueType", contractlength: "contractLength", contractmonths: "contractLength", term: "contractLength", termmonths: "contractLength",
    product: "products", productname: "products", notes: "description", note: "description", dealnotes: "description", comments: "description",
  },
};

/** Columns that may share one field: their cells are joined with a space (a first and a last name). */
const JOINED = new Set(["fullName"]);

/** Each header's field, matched by apiName, label or a common synonym. A field takes one column unless it joins them. */
export function autoMap(object: ImportObject, def: ResolvedObjectDef, header: readonly string[]): ImportMapping {
  const byKey = new Map<string, string>();
  for (const f of importColumns(object, def)) byKey.set(norm(f.apiName), f.apiName).set(norm(f.label), f.apiName);
  const taken = new Set<string>();
  return header.map((h) => {
    const apiName = byKey.get(norm(h)) ?? SYNONYMS[object][norm(h)] ?? null;
    if (!apiName || (taken.has(apiName) && !JOINED.has(apiName))) return null;
    taken.add(apiName);
    return apiName;
  });
}

/** A figure written short, "7.5k", "1.2m" or "2b" (any case), as its number's text; another text stays as it is. */
function scaled(text: string): string {
  const m = /^(-?\d+(?:\.\d+)?)([kmb])$/i.exec(text);
  if (!m) return text;
  const times = { k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase() as "k" | "m" | "b"];
  // Rounded past float noise: 7.5k is 7500, not 7499.999….
  return String(Math.round(Number(m[1]) * times * 1e6) / 1e6);
}

const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
/** A month by name or abbreviation (Oct, Sept, October), 1-12, else 0. */
const monthOf = (word: string) => {
  const w = word.toLowerCase().replace(/\.$/, "");
  const i = MONTH_NAMES.findIndex((m) => w.length >= 3 && m.startsWith(w));
  return i + 1;
};
/** A two-digit year as spreadsheets write one: 00-69 are 2000s, 70-99 the 1900s. */
const fullYear = (y: string) => (y.length === 2 ? (Number(y) < 70 ? 2000 : 1900) + Number(y) : Number(y));
const ymdOf = (y: number, m: number, d: number): string | null => {
  const t = new Date(Date.UTC(y, m - 1, d));
  if (m < 1 || m > 12 || t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
};
/** Excel's day 0 (it counts 1900 as a leap year, so its serials match this base from March 1900 on). */
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

/**
 * A date cell as YYYY-MM-DD, from the shapes spreadsheets save: 2026-10-20 or 2026/10/20 (with or without a time),
 * 10/20/2026 and 10/20/26 (month first unless `dayFirst`, or when the first part can only be a day), 20-Oct-2026,
 * Oct 20, 2026 and October 20th 2026, and an Excel day serial (46315). Null when it reads as none of them.
 */
export function normalizeDay(cell: string, dayFirst = false): string | null {
  const s = cell.trim().replace(/[ T]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:AM|PM)?\s*(?:Z|[+-]\d{2}:?\d{2})?$/i, "");
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (m) return ymdOf(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]), y = fullYear(m[3]);
    return dayFirst || (a > 12 && b <= 12) ? ymdOf(y, b, a) : ymdOf(y, a, b);
  }
  m = /^(\d{1,2})(?:st|nd|rd|th)?[-\s.]+([a-z]+\.?)[-\s.,]+(\d{2}|\d{4})$/i.exec(s);
  if (m && monthOf(m[2])) return ymdOf(fullYear(m[3]), monthOf(m[2]), Number(m[1]));
  m = /^([a-z]+\.?)[-\s]+(\d{1,2})(?:st|nd|rd|th)?,?[-\s]+(\d{2}|\d{4})$/i.exec(s);
  if (m && monthOf(m[1])) return ymdOf(fullYear(m[3]), monthOf(m[1]), Number(m[2]));
  if (/^\d{5}$/.test(s) && Number(s) >= 20000 && Number(s) <= 80000) return new Date(EXCEL_EPOCH + Number(s) * 86_400_000).toISOString().slice(0, 10);
  return null;
}

/** Whether a column's numeric dates are day first (20/10/2026): some first part is over 12 and no second part is. */
export function dayFirstColumn(cells: readonly string[]): boolean {
  let dayOver = false, monthOver = false;
  for (const c of cells) {
    const m = /^(\d{1,2})[-/.](\d{1,2})[-/.]\d{2,4}\b/.exec(c.trim());
    if (!m) continue;
    if (Number(m[1]) > 12) dayOver = true;
    if (Number(m[2]) > 12) monthOver = true;
  }
  return dayOver && !monthOver;
}

/** A cell Canon's export guarded against spreadsheet formulas (src/lib/csv-export.ts) as the text it was: `'=x` is `=x`. */
const unguarded = (cell: string) => (/^'(?:[=@+\-\t\r\n]|\s+[=@+\-])/.test(cell) ? cell.slice(1) : cell);

/** Checkbox cells as Canon exports them (Yes, No) and as other tools write them. */
const CHECKBOX_CELLS: Readonly<Record<string, "true" | "false">> = { yes: "true", no: "false", true: "true", false: "false", y: "true", n: "false" };

/**
 * A cell as the registry parses it, the one cell parser every CSV import uses: what Canon's export writes for a
 * field (src/lib/list-csv.ts) reads back as the value it was. Users and lookups are resolved by the importer, not here.
 * `dayFirst`: the cell's column holds day-first dates (dayFirstColumn).
 */
export function cleanCell(object: string, field: FieldDef, raw: string, opts: { dayFirst?: boolean } = {}): string {
  const cell = unguarded(raw);
  // A date reads in any shape normalizeDay knows; one it can't read is left for the registry to refuse.
  if (field.type === "date") return normalizeDay(cell, opts.dayFirst) ?? cell;
  if (field.type === "checkbox") return CHECKBOX_CELLS[cell.trim().toLowerCase()] ?? cell;
  if (field.type === "picklist" || field.type === "multipicklist") {
    // A multi-select cell lists its options separated by semicolons, by value or label.
    const option = (s: string) => field.options.find((o) => o.value.toLowerCase() === s.toLowerCase() || o.label.toLowerCase() === s.toLowerCase())?.value ?? s;
    return field.type === "picklist" ? option(cell) : cell.split(";").map((s) => option(s.trim())).join(";");
  }
  if (field.type === "number") return scaled(cell.replace(/[$€£,\s]/g, ""));
  if (field.type === "currency") {
    // A CSV holds whole units; money is stored in cents across the app.
    const units = scaled(cell.replace(/[$€£,\s]/g, ""));
    return units !== "" && Number.isFinite(Number(units)) ? String(Math.round(Number(units) * 100)) : units;
  }
  if (object === "account" && field.apiName === "domain") return normalizeDomain(cell);
  return cell;
}

/** The dedupe key: a company's domain, a person's email, a deal's name. */
function keyOf(object: ImportObject, values: PartyValues): string | null {
  if (object === "account") return typeof values.domain === "string" && values.domain ? normalizeDomain(values.domain) : null;
  if (object === "deal") return typeof values.name === "string" && values.name ? values.name : null;
  return typeof values.email === "string" && values.email.includes("@") ? normalizeEmail(values.email) : null;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The start of the error a deal row gets when no pipeline has its stage; the preview counts those stages from it. */
export const NO_STAGE = "No stage named ";

/** A deal's stage by value or label, in the pipeline the row names (by name or id), else in any pipeline. */
function dealStage(pipelines: readonly Pipeline[], stage: string, pipelineCell: string | undefined): { ok: true; value: string } | { ok: false; error: CoerceError } {
  const chosen = pipelineCell === undefined ? null : pipelines.find((p) => same(p.name, pipelineCell) || p.id === pipelineCell);
  if (chosen === undefined) return { ok: false, error: { field: "pipeline", message: `No pipeline named ${pipelineCell}` } };
  const find = (p: Pipeline) => p.stages.find((st) => st.active && (same(st.value, stage) || same(st.label, stage)));
  const found = chosen ? find(chosen) : pipelines.map(find).find(Boolean);
  if (found) return { ok: true, value: found.value };
  const elsewhere = chosen ? pipelines.find((p) => p !== chosen && find(p)) : undefined;
  if (chosen && elsewhere) return { ok: false, error: { field: "stage", message: `${find(elsewhere)!.label} is a stage of ${elsewhere.name}, not ${chosen.name}` } };
  return { ok: false, error: { field: "stage", message: `${NO_STAGE}${stage}` } };
}

/**
 * Type every data row through the registry. Empty cells are left out: an
 * import fills and updates, it never clears. A deal's stage is checked against
 * `pipelines` and the row's Pipeline column first.
 */
/**
 * `stageMap` renames a deal's Stage cells before they are checked (lower-cased cell to a stage's value or label): the
 * review step maps a stage no pipeline has onto one that it does.
 */
export function readRows(object: ImportObject, def: ResolvedObjectDef, mapping: ImportMapping, records: readonly string[][], pipelines: readonly Pipeline[] = [], stageMap: Readonly<Record<string, string>> = {}): ReadRow[] {
  // Each date column reads as one convention, day first or month first, decided from all of its cells.
  const dayFirst = new Set(mapping.flatMap((apiName, col) => (apiName && def.byApiName.get(apiName)?.type === "date" && dayFirstColumn(records.slice(1).map((r) => r[col] ?? "")) ? [col] : [])));
  return records.slice(1).map((cells, i): ReadRow => {
    const row = i + 2;
    const input: Record<string, string> = {};
    const extra: Record<string, string> = {};
    mapping.forEach((apiName, col) => {
      const field = apiName ? def.byApiName.get(apiName) : undefined;
      const cell = (cells[col] ?? "").trim();
      if (!cell || !apiName) return;
      if (!field) extra[apiName] = cell;
      else if (object === "deal" && apiName === "stage") input.stage = cell;
      else {
        const clean = cleanCell(object, field, cell, { dayFirst: dayFirst.has(col) });
        input[field.apiName] = input[field.apiName] ? `${input[field.apiName]} ${clean}` : clean;
      }
    });
    if (!Object.keys(input).length) return { kind: "skip", row, reason: "Empty row" };
    if (input.stage !== undefined && object === "deal") {
      const stage = dealStage(pipelines, stageMap[input.stage.toLowerCase()] ?? input.stage, extra.pipeline);
      if (!stage.ok) return { kind: "error", row, errors: [stage.error] };
      input.stage = stage.value;
    }
    const coerced = coerce(def, input, { mode: "update" });
    if (!coerced.ok) return { kind: "error", row, errors: coerced.errors };
    const values: PartyValues = Object.fromEntries(coerced.values.map((c) => [def.byFieldId.get(c.fieldId)!.apiName, c.value]));
    const companies = splitList(extra.companies);
    const people = parseDealPeople(extra.contacts);
    if (!people.ok) return { kind: "error", row, errors: [{ field: "contacts", message: people.message }] };
    const owner = extra.owner;
    const columns = dealColumnsOf(extra);
    if (!columns.ok) return { kind: "error", row, errors: [columns.error] };
    return {
      kind: "read", row, key: keyOf(object, values), values, company: extra.company ?? null,
      ...(companies.length ? { companies } : {}), ...(people.people.length ? { people: people.people } : {}), ...(owner ? { owner } : {}),
      ...(Object.keys(columns.columns).length ? { columns: columns.columns } : {}),
    };
  });
}

/** A row's Revenue type, Contract length and Products cells, typed: "one time" or "recurring", a whole number of months (12 or "12 months"), a list. */
function dealColumnsOf(extra: Record<string, string>): { ok: true; columns: DealColumns } | { ok: false; error: CoerceError } {
  const columns: DealColumns = {};
  if (extra.revenueType !== undefined) {
    const r = norm(extra.revenueType);
    if (r === "onetime" || r === "nonrecurring") columns.revenueType = "one_time";
    else if (r === "recurring" || r === "subscription") columns.revenueType = "recurring";
    else return { ok: false, error: { field: "revenueType", message: `${JSON.stringify(extra.revenueType)} is not a revenue type: one time or recurring` } };
  }
  if (extra.contractLength !== undefined) {
    const m = /^(\d{1,3})\s*(?:mo|mos|month|months)?$/i.exec(extra.contractLength.trim());
    if (!m || Number(m[1]) < 1) return { ok: false, error: { field: "contractLength", message: `${JSON.stringify(extra.contractLength)} is not a contract length: a whole number of months` } };
    columns.contractLengthMonths = Number(m[1]);
  }
  const products = splitList(extra.products);
  if (products.length) columns.products = products;
  return { ok: true, columns };
}

/** The items of a cell that lists several, separated by `;`, `|` or line breaks (a comma is the file's own separator). */
export const splitList = (cell: string | undefined): string[] => (cell ?? "").split(/[;|\n]/).map((s) => s.trim()).filter(Boolean);

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A Contacts cell: `jane@x.com:champion; bob@y.com`. A role is a deal role's value or label (`N-1`); none means `involved`. */
export function parseDealPeople(cell: string | undefined): { ok: true; people: DealPerson[] } | { ok: false; message: string } {
  const people = new Map<string, DealPerson>();
  for (const item of splitList(cell)) {
    const colon = item.indexOf(":");
    const email = normalizeEmail(colon < 0 ? item : item.slice(0, colon));
    const roleCell = colon < 0 ? "" : item.slice(colon + 1).trim();
    if (!EMAIL.test(email)) return { ok: false, message: `${JSON.stringify(item)} is not an email, optionally followed by :role` };
    const role = roleCell === "" ? "involved" : DEAL_ROLES.find((r) => norm(r) === norm(roleCell) || norm(DEAL_ROLE_LABELS[r]) === norm(roleCell));
    if (!role) return { ok: false, message: `${JSON.stringify(roleCell)} is not a deal role (${DEAL_ROLES.join(", ")})` };
    people.set(email, { email, role });
  }
  return { ok: true, people: [...people.values()] };
}

/** The roles' labels, as the committee panel shows them. */
const DEAL_ROLE_LABELS: Readonly<Record<DealRole, string>> = {
  executive: "Executive", n1: "N-1", champion: "Champion", user: "User", procurement: "Procurement", security: "Security", signer: "Signer", involved: "Involved",
};

/** The dedupe keys to look up: register domains or emails, or deal names. */
export const importKeys = (rows: readonly ReadRow[]) => [...new Set(rows.flatMap((r) => (r.kind === "read" && r.key ? [r.key] : [])))];

/** The Company cells to look up in the register. */
export const companyCells = (rows: readonly ReadRow[]) => [...new Set(rows.flatMap((r) => (r.kind === "read" ? [...(r.company ? [r.company] : []), ...(r.companies ?? [])] : [])))];

/** The Owner cells: members, looked up by email or name (memberNamed). */
export const ownerCells = (rows: readonly ReadRow[]) => [...new Set(rows.flatMap((r) => (r.kind === "read" && r.owner ? [r.owner] : [])))];

/** A member an Owner or user cell may name. Only an active member is matched. */
export type CsvMember = { id: string; name: string; email?: string; active: boolean };

/**
 * The active member a CSV cell names, by email in any case or by exact name, as Canon's export writes a user field
 * (src/lib/list-csv.ts): one member, or why the cell names none.
 */
export function memberNamed(cell: string, members: readonly CsvMember[]): { ok: true; id: string } | { ok: false; message: string } {
  // A member read twice (once by email, once in a scan of names) is one member.
  const active = [...new Map(members.filter((m) => m.active).map((m) => [m.id, m])).values()];
  const email = normalizeEmail(cell);
  const byEmail = active.filter((m) => m.email !== undefined && normalizeEmail(m.email) === email);
  const found = byEmail.length ? byEmail : active.filter((m) => m.name.trim() === cell.trim());
  if (found.length === 1) return { ok: true, id: found[0].id };
  return { ok: false, message: found.length ? `${found.length} members are named ${cell}; use an email` : `No active member is ${cell}` };
}

/** The emails of the people the Contacts cells name. */
export const personEmails = (rows: readonly ReadRow[]) => [...new Set(rows.flatMap((r) => (r.kind === "read" ? (r.people ?? []).map((p) => p.email) : [])))];

/** A Company cell read as a domain (`acme.com`, `https://www.acme.com/`), or null for a name. */
export function cellDomain(cell: string): string | null {
  const d = normalizeDomain(cell);
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) ? d : null;
}

/** A register company as the matcher reads it. */
export type RegisterCompany = { id: string; name: string; domain: string };

/**
 * Each Company cell's company: the one with its domain, else the one with
 * exactly its name. Several with the name is ambiguous; none creates one when
 * `create` is set and is unmatched otherwise.
 */
export function matchCompanies(cells: readonly string[], companies: readonly RegisterCompany[], create: boolean): Map<string, CompanyMatch> {
  return new Map(cells.map((cell): [string, CompanyMatch] => {
    const domain = cellDomain(cell);
    const byDomain = domain ? companies.find((c) => normalizeDomain(c.domain) === domain) : undefined;
    if (byDomain) return [cell, { kind: "linked", companyId: byDomain.id }];
    const named = [...new Set(companies.filter((c) => c.name === cell).map((c) => c.id))];
    if (named.length === 1) return [cell, { kind: "linked", companyId: named[0] }];
    if (named.length > 1) return [cell, { kind: "ambiguous", cell, count: named.length }];
    return [cell, create ? { kind: "created", cell } : { kind: "unmatched", cell }];
  }));
}

type Read = Extract<ReadRow, { kind: "read" }>;
type RowError = Extract<RowOutcome<never>, { kind: "error" }>;

/** A row's company, or the row error its Company cell is. */
function companyOf(row: Read, companies: ReadonlyMap<string, CompanyMatch>): { ok: true; link: CompanyLink | null } | { ok: false; outcome: RowError } {
  const match = row.company ? companies.get(row.company) : undefined;
  if (!match) return { ok: true, link: null };
  if (match.kind === "linked" || match.kind === "created") return { ok: true, link: match };
  const message = match.kind === "ambiguous" ? `${match.count} companies are named ${match.cell}` : `No company matches ${match.cell}`;
  return { ok: false, outcome: { kind: "error", row: row.row, errors: [{ field: "company", message }], company: match } };
}

/** The companies of a row's Companies column, each as `companyOf` reads a Company cell; the same company twice is once. */
function linksOf(row: Read, companies: ReadonlyMap<string, CompanyMatch>): { ok: true; links: CompanyLink[] } | { ok: false; outcome: RowError } {
  const links = new Map<string, CompanyLink>();
  for (const cell of row.companies ?? []) {
    const one = companyOf({ ...row, company: cell }, companies);
    if (!one.ok) return one;
    if (one.link) links.set(one.link.kind === "linked" ? one.link.companyId : `new:${one.link.cell}`, one.link);
  }
  return { ok: true, links: [...links.values()] };
}

/** The required fields a new record's values leave empty, as row errors. */
export function missingRequired(def: ResolvedObjectDef, values: PartyValues): CoerceError[] {
  return def.fields
    .filter((f) => f.required && !f.system && f.archivedAt === undefined && (values[f.apiName] ?? null) === null)
    .map((f) => ({ field: f.apiName, message: `${f.label} is required` }));
}

/**
 * What each company or person row will do: update the register row its key
 * matches, create a record, skip a repeat of an earlier row's key, or fail
 * with the reasons. `again` holds the keyless rows an earlier run of this file wrote.
 */
export function classify(
  object: PartyObject, def: ResolvedObjectDef, rows: readonly ReadRow[], matches: ReadonlyMap<string, ImportMatch>,
  companies: ReadonlyMap<string, CompanyMatch> = new Map(), again: ReadonlySet<number> = new Set(),
): RowOutcome[] {
  const seen = new Map<string, number>();
  const keyName = object === "account" ? "domain" : "email";
  return rows.map((r): RowOutcome => {
    if (r.kind !== "read") return r;
    if (r.key && seen.has(r.key)) return { kind: "skip", row: r.row, reason: `Same ${keyName} as row ${seen.get(r.key)}` };
    if (r.key) seen.set(r.key, r.row);
    const company = companyOf(r, companies);
    if (!company.ok) return company.outcome;
    const extra = linksOf(r, companies);
    if (!extra.ok) return extra.outcome;
    const links = extra.links.length ? { links: extra.links } : {};
    // The register finds the person it links to a company by email (record service contacts/upsert).
    if ((company.link || extra.links.length) && !r.key) return { kind: "error", row: r.row, errors: [{ field: "company", message: "Add an email to link this person to a company" }] };
    const match = r.key ? matches.get(r.key) : undefined;
    if (match && r.key) return { kind: "update", row: r.row, key: r.key, values: r.values, match, company: company.link, ...links };
    const missing = missingRequired(def, r.values);
    if (missing.length) return { kind: "error", row: r.row, errors: missing };
    if (object === "contact" && r.values.fullName == null && !r.key) return { kind: "error", row: r.row, errors: [{ field: "fullName", message: "A person needs a name or an email" }] };
    return { kind: "create", row: r.row, key: r.key, values: r.values, company: company.link, ...links, ...(!r.key && again?.has(r.row) ? { again: true as const } : {}) };
  });
}

/** A deal row's values as deals.create takes them. */
export function dealCreateInput(values: PartyValues, columns?: DealColumns): DealCreateInput {
  const text = (k: string) => (typeof values[k] === "string" ? (values[k] as string) : undefined);
  return {
    name: text("name") ?? "", closeDate: text("closeDate") ?? "", stage: text("stage") ?? "",
    ...(typeof values.amount === "number" ? { amount: values.amount } : {}),
    ...(text("currency") ? { currency: text("currency") } : {}), ...(text("dealType") ? { dealType: text("dealType") } : {}),
    ...(columns?.revenueType ? { revenueType: columns.revenueType } : {}),
  };
}

/**
 * What each deal row will do. A deal is the same as another with its name and
 * company (its name alone when no Company column is mapped): a repeat of an
 * earlier row is skipped, a Canon deal is updated, else the row creates one,
 * which needs what deals.create needs (planDealCreate).
 */
export function classifyDeals(
  rows: readonly ReadRow[], deals: ReadonlyMap<string, readonly DealMatch[]>, companies: ReadonlyMap<string, CompanyMatch>,
  pipelines: readonly Pipeline[], byCompany: boolean, def?: ResolvedObjectDef, people: ReadonlyMap<string, string> = new Map(),
  owners: ReadonlyMap<string, string> = new Map(),
  /** Skip a row whose Owner cell names no member, rather than import it owned by the importer. */
  skipUnknownOwners = false,
): DealOutcome[] {
  const seen = new Map<string, number>();
  return rows.map((r): DealOutcome => {
    if (r.kind !== "read") return r;
    const company = companyOf(r, companies);
    if (!company.ok) return company.outcome;
    if (!r.key) return { kind: "error", row: r.row, errors: [{ field: "name", message: "Deal name is required" }] };
    const link = company.link;
    const companyKey = !link ? "" : link.kind === "linked" ? link.companyId : `new:${link.cell}`;
    const dedupe = `${r.key}\u0000${byCompany ? companyKey : ""}`;
    if (seen.has(dedupe)) return { kind: "skip", row: r.row, reason: `Same deal as row ${seen.get(dedupe)}` };
    seen.set(dedupe, r.row);
    const sameName = deals.get(r.key) ?? [];
    const named = sameName.filter((d) => !byCompany || (d.companyId ?? "") === companyKey);
    // A CRM deal's company is its CRM account's, which the import cannot compare: neither duplicate it nor guess.
    if (!named.length && companyKey && sameName.some((d) => d.companyId === null && d.crmAccount)) {
      return { kind: "error", row: r.row, errors: [{ field: "name", message: `A CRM deal is named ${r.key}; link it to a company first` }] };
    }
    if (named.length > 1) return { kind: "error", row: r.row, errors: [{ field: "name", message: `${named.length} deals are named ${r.key}; map a Company column` }] };
    // The people on the Contacts cell who are in the register join the deal; the others are listed and the deal still imports.
    const members = (r.people ?? []).flatMap((p) => (people.has(p.email) ? [{ contactId: people.get(p.email)!, role: p.role }] : []));
    const unknown = (r.people ?? []).filter((p) => !people.has(p.email)).map((p) => `No person has the email ${p.email}; not added to the deal`);
    // The Owner cell's member owns the deal; an email no member has is listed, and the deal imports without that owner.
    const ownerId = r.owner ? owners.get(r.owner) : undefined;
    if (r.owner && !ownerId && skipUnknownOwners) return { kind: "skip", row: r.row, reason: `No active member is ${r.owner}` };
    if (r.owner && !ownerId) unknown.push(`No active member is ${r.owner}; ${named.length === 1 ? "the deal keeps its owner" : "you will own the deal"}`);
    const extra = {
      ...(members.length ? { members } : {}), ...(unknown.length ? { warnings: unknown } : {}),
      ...(ownerId ? { ownerId } : {}), ...(r.owner && !ownerId ? { ownerMiss: r.owner } : {}), ...(r.columns ? { columns: r.columns } : {}),
    };
    if (named.length === 1) return { kind: "update", row: r.row, key: r.key, values: r.values, match: named[0], company: link, ...extra };
    const plan = planDealCreate(pipelines, dealCreateInput(r.values, r.columns));
    if (!plan.ok) return { kind: "error", row: r.row, errors: [{ field: "deal", message: plan.error }] };
    const missing = def ? missingRequired(def, r.values).filter((e) => e.field.startsWith("custom.")) : [];
    if (missing.length) return { kind: "error", row: r.row, errors: missing };
    return { kind: "create", row: r.row, key: r.key, values: r.values, company: link, ...extra };
  });
}

/** Problems a preview lists, at most this many. */
export const PREVIEW_PROBLEMS_MAX = 200;

export type ImportPreview = {
  counts: { create: number; update: number; skip: number; error: number };
  /** Rows by their Company cell (and the extra companies of a Companies column): linked to a register company, creating one, or failing to match. */
  companies: { linked: number; created: number; unmatched: number; ambiguous: number };
  /** An activity's target cells: those that found a company, person or deal, and those that found none. */
  targets: { matched: number; unmatched: number };
  /** A deal's Owner cells: rows whose email is a member's, and the emails no member has. */
  owners: { matched: number; unknown: string[] };
  /** A `warn` row still imports, without the link it names. */
  problems: Array<{ row: number; kind: "skip" | "error" | "warn"; message: string }>;
  /** Deal Stage cells no pipeline has, each with the rows it fails: the review step maps them or adds them to the pipeline. */
  unknownStages: Array<{ value: string; rows: number }>;
};

/** What `summarize` reads of an outcome: every importer's outcome fits it. */
export type Summarizable = {
  kind: "create" | "update" | "skip" | "error";
  row: number;
  reason?: string;
  errors?: readonly CoerceError[];
  company?: CompanyLink | CompanyMiss | null;
  links?: readonly CompanyLink[];
  again?: true;
  warnings?: readonly string[];
  /** An activity's targets that matched, and the cells that did not. */
  targets?: readonly unknown[];
  misses?: readonly string[];
  ownerId?: string;
  ownerMiss?: string;
};

export function summarize(outcomes: readonly Summarizable[]): ImportPreview {
  const counts = { create: 0, update: 0, skip: 0, error: 0 };
  const companies = { linked: 0, created: 0, unmatched: 0, ambiguous: 0 };
  const targets = { matched: 0, unmatched: 0 };
  const owners = { matched: 0, unknown: new Set<string>() };
  const problems: ImportPreview["problems"] = [];
  const stages = new Map<string, { value: string; rows: number }>();
  for (const o of outcomes) {
    counts[o.kind === "create" && o.again ? "update" : o.kind]++;
    for (const company of [o.company, ...(o.links ?? [])]) if (company) companies[company.kind]++;
    targets.matched += o.targets?.length ?? 0;
    targets.unmatched += o.misses?.length ?? 0;
    if (o.ownerId) owners.matched++;
    if (o.ownerMiss) owners.unknown.add(o.ownerMiss);
    for (const e of o.kind === "error" ? o.errors ?? [] : []) {
      if (e.field !== "stage" || !e.message.startsWith(NO_STAGE)) continue;
      const value = e.message.slice(NO_STAGE.length);
      const at = stages.get(value.toLowerCase()) ?? { value, rows: 0 };
      stages.set(value.toLowerCase(), { value: at.value, rows: at.rows + 1 });
    }
    if (problems.length >= PREVIEW_PROBLEMS_MAX) continue;
    if (o.kind === "skip") problems.push({ row: o.row, kind: "skip", message: o.reason ?? "" });
    if (o.kind === "error") problems.push({ row: o.row, kind: "error", message: (o.errors ?? []).map((e) => e.message).join("; ") });
    for (const message of o.warnings ?? []) if (problems.length < PREVIEW_PROBLEMS_MAX) problems.push({ row: o.row, kind: "warn", message });
  }
  return { counts, companies, targets, owners: { matched: owners.matched, unknown: [...owners.unknown].slice(0, PREVIEW_PROBLEMS_MAX) }, problems, unknownStages: [...stages.values()].sort((a, b) => b.rows - a.rows).slice(0, PREVIEW_PROBLEMS_MAX) };
}

/** A stable digest of a file (FNV-1a, two seeds): the same file is the same import. */
export function importIdOf(object: string, text: string): string {
  const fnv = (seed: number) => {
    let h = seed;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
    return (h >>> 0).toString(16).padStart(8, "0");
  };
  return `${object}-${fnv(0x811c9dc5)}${fnv(0x01000193)}`;
}

/** A company or person row to write. */
export type ImportWrite =
  | { kind: "create"; row: number; key: string | null; values: PartyValues }
  | { kind: "update"; row: number; key: string; values: PartyValues; match: ImportMatch };

/**
 * Write one row to its record's stream. A matched row with a stream lands
 * there (`streamId`, checked by the caller); a matched unworked row is
 * promoted, its register row seeding the stream; a new row is found again on
 * a re-run by its key, or by its file row when it has none.
 */
export async function writeImportRow(
  s: PartyStores,
  a: { orgId: string; object: PartyObject; importId: string; actorId: string; now: number; outcome: ImportWrite; streamId?: string },
): Promise<PartyWriteResult & { entityId: string }> {
  const o = a.outcome;
  const ref = `csv:${a.importId}:${o.row}`;
  const recordId = o.kind === "update" ? o.match.recordId : undefined;
  const ids = a.object === "account" ? accountExternalIds({ domain: o.key, recordId }) : contactExternalIds({ email: o.key, recordId });
  const label = a.object === "account" ? o.values.name : o.values.fullName;
  const entityId = a.streamId ?? await ensureEntity(s.facts, {
    orgId: a.orgId, entityType: a.object, projectionTable: a.object === "account" ? "recordAccounts" : "recordContacts", projectionId: recordId ?? ref,
    externalIds: [...ids, { provider: `csv:${a.importId}`, externalId: String(o.row) }], ...(typeof label === "string" ? { label } : {}),
  });
  const out = await writeParty(s, {
    orgId: a.orgId, object: a.object, streamId: entityId, now: a.now, values: o.values,
    source: { kind: "import", ref, actorId: a.actorId },
    seed: async () => (o.kind === "update" ? recordSeed(a.object, o.match.snapshot) : null),
  });
  return { ...out, entityId };
}
