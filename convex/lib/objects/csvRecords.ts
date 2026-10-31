/**
 * CSV import of every other registry object (CP10b, docs/core-crm-parity.md): leads, products, any object the
 * registry resolves, and activities (notes, tasks, calls, meetings) with the records they are about. The file
 * rules for companies, people and deals are csvImport.ts; this is its sibling for objects saved through the
 * generic object API (objects.ts), where a row always creates and a re-run of the file finds it again by its
 * file row (`csv:<digest>:<object>` external id), so it never duplicates.
 *
 * An activity row reads as:
 *   Type      note, task, call or meeting (a file may mix them); a blank cell takes the wizard's default
 *   Subject, Body, Status, Due date, Outcome, ... mapped onto the field each type keeps them in (ACTIVITY_FIELD)
 *   Date      its original date: `createdAt` of the record, and a call's time or a meeting's start
 *   Owner     a member's email, saved as `ownerId`
 *   Company (domain or name), Person (email), Deal (name or id)  the records it is about: an
 *             `activity_target` edge to each, so it shows on each timeline with its original date
 * A row that matches no target fails unless the import allows untargeted rows.
 *
 * Pure: the caller looks cells up and passes the results. No Node-only imports.
 */
import { ACTIVITY_OBJECTS, type ActivityObject } from "../activities.ts";
import { cleanCell, missingRequired, norm, type CompanyMatch, type ReadRow } from "./csvImport.ts";
import { isCustomField } from "./listSpec.ts";
import { coerce, STANDARD_OBJECTS, type CoerceError, type FieldDef, type ResolvedObjectDef, type StandardObjectName } from "./registry.ts";

/** The pseudo-object a file of activities of several types is imported as. */
export const ACTIVITY = "activity";

/** Each importable object's resolved definition, by apiName (an activity file needs all four activity objects). */
export type RecordDefs = Readonly<Record<string, ResolvedObjectDef>>;

export type Column = { apiName: string; label: string };
export type RecordValues = Record<string, string | number | boolean | null | readonly string[]>;

/** Fields a conversion or the system sets: never a CSV value. */
const NOT_IMPORTED = new Set(["convertedAt"]);

const DATE: Column = { apiName: "date", label: "Date" };
const OWNER: Column = { apiName: "owner", label: "Owner (member email)" };
const TARGETS: readonly Column[] = [
  { apiName: "company", label: "Company (domain or name)" },
  { apiName: "person", label: "Person (email)" },
  { apiName: "deal", label: "Deal (name or id)" },
];

/** What an activity file's columns mean for each type: the type's field that takes the column's cells. */
const ACTIVITY_FIELD: Readonly<Record<ActivityObject, Readonly<Record<string, string>>>> = {
  note: { body: "body" },
  task: { subject: "subject", body: "description", status: "status", priority: "priority", dueDate: "dueDate" },
  call: { subject: "subject", body: "notes", outcome: "outcome", direction: "direction", durationSeconds: "durationSeconds" },
  meeting: { subject: "title", body: "notes", outcome: "outcome", endAt: "endAt", location: "location" },
};
/** The field a type's `Date` also fills: when the call was made, when the meeting starts. */
const ACTIVITY_DATE_FIELD: Readonly<Partial<Record<ActivityObject, string>>> = { call: "callAt", meeting: "startAt" };

const ACTIVITY_COLUMNS: readonly Column[] = [
  { apiName: "type", label: "Type (note, task, call, meeting)" },
  { apiName: "subject", label: "Subject or title" },
  { apiName: "body", label: "Body or notes" },
  DATE,
  OWNER,
  { apiName: "status", label: "Task status" },
  { apiName: "priority", label: "Task priority" },
  { apiName: "dueDate", label: "Task due date" },
  { apiName: "outcome", label: "Call or meeting outcome" },
  { apiName: "direction", label: "Call direction" },
  { apiName: "durationSeconds", label: "Call duration (seconds)" },
  { apiName: "endAt", label: "Meeting end" },
  { apiName: "location", label: "Meeting location" },
  ...TARGETS,
];

const importable = (f: FieldDef) =>
  !f.system && f.archivedAt === undefined && f.type !== "user" && f.type !== "lookup" && f.type !== "formula" && !NOT_IMPORTED.has(f.apiName);

const hasOwner = (def: ResolvedObjectDef) => def.byApiName.get("ownerId")?.type === "user";

/** Whether an object's records are about other records (its rows take target columns). */
export const isActivityObject = (object: string): object is ActivityObject => (ACTIVITY_OBJECTS as readonly string[]).includes(object);

/**
 * Whether `object` imports as plain records: a ledger object that is not a company, person, deal or activity
 * (those have their own importers). Whatever object the registry resolves, a custom one included, is served here.
 */
export const isRecordObject = (object: string) =>
  Object.hasOwn(STANDARD_OBJECTS, object) && STANDARD_OBJECTS[object as StandardObjectName].storage === "ledger"
  && !["account", "contact", "deal"].includes(object) && !isActivityObject(object);

/**
 * Everything a column may map to. An activity file takes the shared activity columns and the custom fields of the
 * type the wizard was opened from (`kind`); any other object takes its registry fields, a Date and an Owner.
 */
export function recordColumns(object: string, defs: RecordDefs, kind?: string): Column[] {
  if (object === ACTIVITY) {
    const custom = kind && defs[kind] ? defs[kind].fields.filter((f) => importable(f) && isCustomField(f)) : [];
    return [...ACTIVITY_COLUMNS, ...custom.map((f) => ({ apiName: f.apiName, label: f.label }))];
  }
  const def = defs[object];
  return [...def.fields.filter(importable).map((f) => ({ apiName: f.apiName, label: f.label })), DATE, ...(hasOwner(def) ? [OWNER] : [])];
}

const COMMON_SYNONYMS: Readonly<Record<string, string>> = {
  owneremail: "owner", assignedto: "owner", assignedtoemail: "owner", createdby: "owner", rep: "owner",
  createddate: "date", createdat: "date", created: "date", timestamp: "date",
};
const SYNONYMS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  [ACTIVITY]: {
    activitytype: "type", kind: "type", engagementtype: "type",
    title: "subject", name: "subject", summary: "subject", activitysubject: "subject",
    note: "body", notes: "body", description: "body", comments: "body", text: "body", content: "body",
    activitydate: "date", when: "date", datetime: "date", starttime: "date", calltime: "date", completeddate: "date", start: "date",
    due: "dueDate", result: "outcome", disposition: "outcome", duration: "durationSeconds", callduration: "durationSeconds",
    endtime: "endAt", enddate: "endAt",
    companyname: "company", companydomain: "company", account: "company", accountname: "company", organization: "company", domain: "company", website: "company",
    email: "person", contact: "person", contactemail: "person", personemail: "person",
    dealname: "deal", opportunity: "deal", opportunityname: "deal", dealid: "deal",
  },
  lead: { surname: "lastName", source: "leadSource", emailaddress: "email", jobtitle: "title", mobile: "phone" },
  product: { name: "name", productcode: "sku", code: "sku", price: "unitPrice", listprice: "unitPrice", productfamily: "family" },
};

/** Each header's column, matched by apiName, label or a common synonym. A column takes one header unless the user maps more by hand. */
export function autoMapRecord(object: string, columns: readonly Column[], header: readonly string[]): (string | null)[] {
  const byKey = new Map<string, string>();
  for (const c of columns) byKey.set(norm(c.apiName), c.apiName).set(norm(c.label), c.apiName);
  const allowed = new Set(columns.map((c) => c.apiName));
  const synonyms = { ...COMMON_SYNONYMS, ...SYNONYMS[object] };
  const taken = new Set<string>();
  return header.map((h) => {
    const named = byKey.get(norm(h));
    const synonym = synonyms[norm(h)];
    const apiName = named ?? (synonym !== undefined && allowed.has(synonym) ? synonym : null);
    if (!apiName || taken.has(apiName)) return null;
    taken.add(apiName);
    return apiName;
  });
}

const KIND_NAMES: Readonly<Record<string, ActivityObject>> = {
  note: "note", comment: "note", task: "task", todo: "task", call: "call", phonecall: "call", logcall: "call", meeting: "meeting", appointment: "meeting", event: "meeting",
};

/** An activity's type from a Type cell (a plural reads as its singular), else the wizard's default. */
function kindOf(cell: string | undefined, fallback: string | undefined): { ok: true; kind: ActivityObject } | { ok: false; message: string } {
  if (cell === undefined) {
    return fallback && isActivityObject(fallback) ? { ok: true, kind: fallback } : { ok: false, message: "Add a Type column (note, task, call or meeting)" };
  }
  const key = norm(cell);
  const kind = KIND_NAMES[key] ?? KIND_NAMES[key.replace(/s$/, "")];
  return kind ? { ok: true, kind } : { ok: false, message: `${JSON.stringify(cell)} is not a note, task, call or meeting` };
}

const utc = (y: number, mo: number, d: number, h: number, mi: number, s: number, offsetMinutes: number): number | null => {
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const t = new Date(ms);
  const real = t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d && h < 24 && mi < 60 && s < 60;
  return real ? ms - offsetMinutes * 60_000 : null;
};

/** A date with no time is noon UTC, so it shows as the same day in every timezone from UTC-12 to UTC+11. */
const NOON = 12;

/**
 * A Date cell as epoch milliseconds: ISO (`2026-03-04`, `2026-03-04T14:30:00Z`, `2026-03-04 14:30`), US `3/4/2026 2:30 PM`,
 * or epoch milliseconds. A date with no zone is UTC; one with no time is noon. Null when it is none of these or not a real day.
 */
export function parseDateCell(cell: string): number | null {
  const s = cell.trim();
  if (/^\d{12,14}$/.test(s)) return Number(s);
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/i.exec(s);
  if (iso) {
    const zone = iso[7] && iso[7].toUpperCase() !== "Z" ? (iso[7][0] === "-" ? -1 : 1) * (Number(iso[7].slice(1, 3)) * 60 + Number(iso[7].slice(-2))) : 0;
    return utc(Number(iso[1]), Number(iso[2]), Number(iso[3]), Number(iso[4] ?? NOON), Number(iso[5] ?? 0), Number(iso[6] ?? 0), zone);
  }
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i.exec(s);
  if (!us) return null;
  const meridiem = us[7]?.toUpperCase();
  const clock = Number(us[4] ?? 0);
  const hour = us[4] === undefined ? NOON : meridiem === undefined ? clock : (clock % 12) + (meridiem === "PM" ? 12 : 0);
  return utc(Number(us[3]), Number(us[1]), Number(us[2]), hour, Number(us[5] ?? 0), Number(us[6] ?? 0), 0);
}

/** The cells of an activity row's target columns. */
export type TargetCells = { company: string | null; person: string | null; deal: string | null };

/** A row read and typed, before its owner and targets are looked up. */
export type RecordRead =
  | { kind: "record"; row: number; object: string; values: RecordValues; createdAt: number | null; owner: string | null; targets: TargetCells }
  | Exclude<ReadRow, { kind: "read" }>;

/**
 * Type every data row through the registry. Empty cells are left out. An activity row's type picks the registry
 * object its values are typed against, and its shared columns map onto that type's fields.
 */
export function readRecordRows(
  object: string, defs: RecordDefs, mapping: readonly (string | null)[], records: readonly string[][], opts: { kind?: string } = {},
): RecordRead[] {
  return records.slice(1).map((cells, i): RecordRead => {
    const row = i + 2;
    const cell = new Map<string, string>();
    mapping.forEach((apiName, col) => {
      const text = (cells[col] ?? "").trim();
      if (apiName && text) cell.set(apiName, cell.has(apiName) ? `${cell.get(apiName)} ${text}` : text);
    });
    if (!cell.size) return { kind: "skip", row, reason: "Empty row" };
    const isActivity = object === ACTIVITY;
    const typed = isActivity ? kindOf(cell.get("type"), opts.kind) : { ok: true as const, kind: object };
    if (!typed.ok) return { kind: "error", row, errors: [{ field: "type", message: typed.message }] };
    const kind = typed.kind;
    const def = defs[kind];
    const input: Record<string, string | number> = {};
    for (const [apiName, text] of cell) {
      if (apiName === "type" || apiName === "date" || apiName === "owner" || (isActivity && TARGETS.some((t) => t.apiName === apiName))) continue;
      const fieldName = isActivity && !isCustomField({ apiName }) ? ACTIVITY_FIELD[kind as ActivityObject][apiName] : apiName;
      // A column that means nothing for this type (a task's status on a call) is left out.
      if (!fieldName) continue;
      const field = def.byApiName.get(fieldName);
      if (!field) return { kind: "error", row, errors: [{ field: apiName, message: `${apiName} is not a field of ${kind}` }] };
      const clean = cleanCell(kind, field, text);
      // A meeting's end and a task's due date read as the Date column does (a time without a zone is UTC); the registry's own parsers are stricter.
      const when = field.type === "datetime" || field.type === "date" ? parseDateCell(clean) : null;
      if (when !== null) {
        input[fieldName] = field.type === "datetime" ? when : new Date(when).toISOString().slice(0, 10);
        continue;
      }
      input[fieldName] = input[fieldName] ? `${input[fieldName]} ${clean}` : clean;
    }
    // A note has one text field: a subject and a body are both kept in it.
    if (isActivity && kind === "note" && cell.has("subject")) input.body = [cell.get("subject"), input.body].filter(Boolean).join("\n\n");
    let createdAt: number | null = null;
    if (cell.has("date")) {
      createdAt = parseDateCell(cell.get("date")!);
      if (createdAt === null) return { kind: "error", row, errors: [{ field: "date", message: "Date must be a date such as 2026-03-04, 2026-03-04 14:30 or 3/4/2026" }] };
      const dateField = isActivity ? ACTIVITY_DATE_FIELD[kind as ActivityObject] : undefined;
      if (dateField && !(dateField in input)) input[dateField] = createdAt;
    }
    if (!Object.keys(input).length && createdAt === null && !cell.has("company") && !cell.has("person") && !cell.has("deal")) return { kind: "skip", row, reason: "Empty row" };
    const coerced = coerce(def, input, { mode: "update" });
    if (!coerced.ok) return { kind: "error", row, errors: coerced.errors };
    const values: RecordValues = {};
    for (const c of coerced.values) {
      const field = def.byFieldId.get(c.fieldId)!.apiName;
      const value = c.value;
      if (value !== null && typeof value === "object") {
        if (!value.every((v): v is string => typeof v === "string")) return { kind: "error", row, errors: [{ field, message: "Credit splits are edited on their deal" }] };
        values[field] = value;
      } else values[field] = value;
    }
    return {
      kind: "record", row, object: kind, values, createdAt, owner: cell.get("owner")?.toLowerCase() ?? null,
      targets: { company: cell.get("company") ?? null, person: cell.get("person")?.toLowerCase() ?? null, deal: cell.get("deal") ?? null },
    };
  });
}

type Read = Extract<RecordRead, { kind: "record" }>;

/** The cells a file's rows ask to look up. */
export function recordKeys(rows: readonly RecordRead[]) {
  const reads = rows.filter((r): r is Read => r.kind === "record");
  const unique = (xs: Array<string | null>) => [...new Set(xs.filter((x): x is string => x !== null))];
  return {
    companies: unique(reads.map((r) => r.targets.company)),
    people: unique(reads.map((r) => r.targets.person)),
    deals: unique(reads.map((r) => r.targets.deal)),
    owners: unique(reads.map((r) => r.owner)),
  };
}

/** A deal a Deal cell may name: its stream id (what an activity's edge points at) and its company. */
export type DealRef = { streamId: string; companyId: string | null };

/** What the file's cells found: owners by lowercased email, companies by cell, people by lowercased email, deals by cell, and the rows an earlier run wrote. */
export type RecordLookups = {
  members: ReadonlyMap<string, string>;
  companies: ReadonlyMap<string, CompanyMatch>;
  people: ReadonlyMap<string, string>;
  deals: ReadonlyMap<string, readonly DealRef[]>;
  again?: ReadonlySet<number>;
};

/** What one data row does: every row creates (a record has no key to match), and carries the records it is about. */
export type RecordOutcome =
  | { kind: "create"; row: number; object: string; values: RecordValues; createdAt: number | null; targets: string[]; misses: string[]; warnings: string[]; again?: true }
  | { kind: "skip"; row: number; reason: string }
  | { kind: "error"; row: number; errors: readonly CoerceError[]; misses?: string[] };

const label = (def: ResolvedObjectDef, apiName: string) => def.byApiName.get(apiName)?.label ?? apiName;

/**
 * Decide each row: skip a repeat of an earlier row's unique value, resolve its owner and targets, and fail what
 * misses a required field or (unless `allowUntargeted`) every target.
 */
export function classifyRecords(rows: readonly RecordRead[], defs: RecordDefs, lookups: RecordLookups, opts: { allowUntargeted?: boolean } = {}): RecordOutcome[] {
  const seen = new Map<string, number>();
  return rows.map((r): RecordOutcome => {
    if (r.kind !== "record") return r;
    const def = defs[r.object];
    for (const f of def.fields) {
      const value = r.values[f.apiName];
      if (!f.unique || typeof value !== "string") continue;
      const key = `${f.apiName}\u0000${value.toLowerCase()}`;
      if (seen.has(key)) return { kind: "skip", row: r.row, reason: `Same ${label(def, f.apiName)} as row ${seen.get(key)}` };
      seen.set(key, r.row);
    }
    const missing = missingRequired(def, r.values);
    if (missing.length) return { kind: "error", row: r.row, errors: missing };
    const values: RecordValues = { ...r.values };
    const warnings: string[] = [];
    if (r.owner) {
      const ownerId = lookups.members.get(r.owner);
      if (ownerId) values.ownerId = ownerId;
      else warnings.push(`No member has the email ${r.owner}; the row is left without an owner`);
    }
    const ids: string[] = [];
    const misses: string[] = [];
    if (isActivityObject(r.object)) {
      const company = r.targets.company ? lookups.companies.get(r.targets.company) : undefined;
      const companyId = company?.kind === "linked" ? company.companyId : null;
      if (r.targets.company) {
        if (companyId) {
          ids.push(companyId);
          values.accountId = companyId;
        } else misses.push(company?.kind === "ambiguous" ? `${company.count} companies are named ${r.targets.company}` : `No company matches ${r.targets.company}`);
      }
      if (r.targets.person) {
        const contactId = lookups.people.get(r.targets.person);
        if (contactId) {
          ids.push(contactId);
          values.contactId = contactId;
        } else misses.push(`No person has the email ${r.targets.person}`);
      }
      if (r.targets.deal) {
        const named = lookups.deals.get(r.targets.deal) ?? [];
        // Several deals with one name: the company the row names decides.
        const refs = named.length > 1 && companyId ? named.filter((d) => d.companyId === companyId) : named;
        if (refs.length === 1) {
          ids.push(refs[0].streamId);
          values.dealId = refs[0].streamId;
        } else misses.push(refs.length ? `${refs.length} deals are named ${r.targets.deal}` : `No deal matches ${r.targets.deal}`);
      }
      if (!ids.length && !opts.allowUntargeted) {
        const message = misses.length ? `No target matched: ${misses.join("; ")}` : "Name a company, person or deal, or import rows without a target";
        return { kind: "error", row: r.row, errors: [{ field: "targets", message }], misses };
      }
    }
    return {
      kind: "create", row: r.row, object: r.object, values, createdAt: r.createdAt, targets: ids, misses, warnings: [...misses, ...warnings],
      ...(lookups.again?.has(r.row) ? { again: true as const } : {}),
    };
  });
}
