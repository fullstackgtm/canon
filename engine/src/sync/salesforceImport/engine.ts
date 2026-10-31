/**
 * Resumable Salesforce Bulk API 2.0 import into the record service.
 *
 * - One Bulk 2.0 query job per object; results are read in pages of
 *   `chunkSize` (5000) rows via the job's locator, so a run can stop at any
 *   chunk boundary and a later run resumes from `{bulkJobId, locator}`.
 * - Each chunk is upserted with idempotencyKey
 *   `sf-import:{orgId}:{object}:{bulkJobId}:{chunkIndex}`: replaying a chunk
 *   after a crash between upsert and checkpoint is a no-op in the service.
 * - Re-running the whole import (new bulk job ids) is a no-op on totals
 *   because every row carries `sfId` and the service matches sfId first.
 * - Every source row ends as exactly one of upserted or rejected (with a
 *   reason), so `upserted + rejected == seen` per object.
 * - Opportunities and their contact roles go to Canon itself (`CanonSink`):
 *   deals keyed by Salesforce id, pipelines from sales processes, and
 *   `deal_contact` edges. A chunk's contact roles are read with its
 *   opportunities, so each deal's roles are decided together.
 * - Owners map to Canon members by email; each chunk reports the owners its
 *   records held, so the job can list the ones no member matched.
 */
import type { AccountInput, CanonSink, ImportSink, ObjectDef, ObjectImportState, OwnerTally, RejectedRow, SfConn } from "./contracts.ts";
import {
  CONTACT_ROLE_FIELDS, OPPORTUNITY_FIELDS, forecastCategoryOf, mapOpportunity, planDealRoles, stageKey,
  type DealImport, type SalesProcess, type SfOwner, type SfStage,
} from "./deals.ts";
import {
  ACCOUNT_FIELDS,
  CONTACT_FIELDS,
  LEAD_FIELDS,
  bulkFieldsOf,
  domainFromEmail,
  mapAccount,
  mapContact,
  mapCustom,
  mapLead,
  normalizeSfId,
  objectDefFromDescribe,
  stubAccountsFor,
  type Mapped,
  type ParentAccount,
} from "./mapping.ts";
import { bulkQueryPage, countRecords, createBulkQueryJob, describeGlobal, describeSObject, restGet, restGetText, soql, waitBulkQueryJob } from "./sfClient.ts";
import { DOCUMENT_FIELDS, EVENT_FIELDS, NOTE_FIELDS, TASK_FIELDS, mapDocument, mapEvent, mapLegacyNote, mapTask } from "./activities.ts";
import { customFieldSpecs, customValue, historyPoints, type CustomFieldPlacement } from "./history.ts";

export const SOURCE = "salesforce";
export const CHUNK_SIZE = 5000;
/** Rows per chunk of an object written into Canon: its mutations are smaller than a record-service batch. */
export const CANON_CHUNK_SIZE = 1000;
export const CONTACT_ROLE = "OpportunityContactRole";
/** Stage and field history (OpportunityHistory and OpportunityFieldHistory), read with their opportunities like contact roles. */
export const DEAL_HISTORY = "OpportunityHistory";
const FIELD_HISTORY = "OpportunityFieldHistory";
/** Activities and documents, after the records they are about. */
const ACTIVITY_SOURCES = ["Task", "Event", "Note", "ContentDocument"] as const;
export const DEFAULT_STANDARD_OBJECTS = ["Account", "Contact", "Lead", "Opportunity", CONTACT_ROLE, DEAL_HISTORY, ...ACTIVITY_SOURCES] as const;
const ORDER: string[] = ["Account", "Contact", "Lead", "Opportunity", CONTACT_ROLE, DEAL_HISTORY, ...ACTIVITY_SOURCES];
/** Objects read with each opportunity chunk rather than on their own. */
const WITH_OPPORTUNITIES = [CONTACT_ROLE, DEAL_HISTORY];
/** Objects written into Canon itself, in smaller chunks than the record service takes. */
const CANON_OBJECTS = new Set<string>(["Opportunity", ...ACTIVITY_SOURCES]);

export function idempotencyKeyFor(orgId: string, object: string, bulkJobId: string, chunkIndex: number): string {
  return `sf-import:${orgId}:${object}:${bulkJobId}:${chunkIndex}`;
}

/**
 * Objects to import, in dependency order (Account before Contact/Lead), each
 * with its Salesforce COUNT(). Default: Account, Contact, Lead, Opportunity
 * plus every queryable custom object (`__c`).
 */
export async function planObjects(conn: SfConn, requested?: string[]): Promise<ObjectImportState[]> {
  const global = await describeGlobal(conn);
  const queryable = new Map(global.filter((o) => o.queryable && !o.deprecatedAndHidden).map((o) => [o.name, o]));
  let names: string[];
  if (requested?.length) {
    const unknown = requested.filter((n) => !queryable.has(n));
    if (unknown.length) throw new Error(`Not queryable in this org: ${unknown.join(", ")}`);
    names = [...new Set(requested)];
    for (const dependent of WITH_OPPORTUNITIES) {
      if (names.includes(dependent) && !names.includes("Opportunity")) throw new Error(`${dependent} is imported with its opportunities: pick Opportunity too`);
      if (names.includes("Opportunity") && !names.includes(dependent) && queryable.has(dependent)) names.push(dependent);
    }
  } else {
    names = [
      ...DEFAULT_STANDARD_OBJECTS.filter((n) => queryable.has(n)),
      ...[...queryable.values()].filter((o) => o.custom && o.name.endsWith("__c")).map((o) => o.name).sort(),
    ];
  }
  names.sort((a, b) => rank(a) - rank(b));
  const out: ObjectImportState[] = [];
  for (const apiName of names) {
    // Deal history counts both history tables: OpportunityFieldHistory is read alongside OpportunityHistory.
    const sfTotal = await countRecords(conn, apiName) + (apiName === DEAL_HISTORY && queryable.has(FIELD_HISTORY) ? await countRecords(conn, FIELD_HISTORY) : 0);
    out.push({ apiName, sfTotal, upserted: 0, merged: 0, rejected: 0, seen: 0, chunksDone: 0, state: "pending" });
  }
  return out;
}

function rank(name: string) {
  const i = ORDER.indexOf(name);
  return i === -1 ? ORDER.length : i;
}

export type RunOptions = {
  conn: SfConn;
  sink: ImportSink;
  /** Canon's own tables (deals, pipelines, roles, owners). Without it, opportunities and contact roles fail with a clear error. */
  canon?: CanonSink;
  orgId: string;
  objects: ObjectImportState[];
  /** Persist progress; called after every chunk with that chunk's rejections and the owners its records held. */
  checkpoint(objects: ObjectImportState[], rejected: RejectedRow[], owners?: OwnerTally[]): Promise<void>;
  /** Stop cleanly at the next chunk boundary after this time (epoch ms). */
  deadlineAt?: number;
  chunkSize?: number;
  now?: () => number;
};

/** Cross-chunk caches. Rebuilt lazily after a resume. */
type Caches = {
  /** Account sfId -> imported domain, or why it is missing. */
  parents: Map<string, ParentAccount>;
  /** Domains known to exist in the record service from this run. */
  domains: Set<string>;
  defs: Map<string, ObjectDef>;
  /** Salesforce users by id, with the Canon member each maps to. */
  owners?: Map<string, SfOwner>;
  opportunities?: { fields: string[]; stages: Map<string, string>; defaults: Map<string, SfStage>; defaultCurrency: string; custom: Map<string, CustomFieldPlacement> };
  /** Whether this run imports deal history (the job lists OpportunityHistory). */
  withHistory?: boolean;
};

export async function runImport(opts: RunOptions): Promise<{ done: boolean }> {
  const now = opts.now ?? Date.now;
  const caches: Caches = { parents: new Map(), domains: new Set(), defs: new Map() };
  // A failed checkpoint means progress cannot be persisted: abort the run
  // rather than mark the object failed. The next run resumes from the last
  // persisted state and replays the chunk under the same idempotency key.
  const checkpoint = async (objs: ObjectImportState[], rej: RejectedRow[], owners?: OwnerTally[]) => {
    try { await opts.checkpoint(objs, rej, owners); } catch (e) { throw new CheckpointError(e); }
  };
  const roles = opts.objects.find((o) => o.apiName === CONTACT_ROLE);
  const history = opts.objects.find((o) => o.apiName === DEAL_HISTORY);
  caches.withHistory = history !== undefined;
  const dependents = [roles, history].filter((o): o is ObjectImportState => o !== undefined);
  for (const obj of opts.objects) {
    if (obj.state === "done" || obj.state === "failed" || dependents.includes(obj)) continue;
    const chunkSize = Math.min(opts.chunkSize ?? CHUNK_SIZE, CANON_OBJECTS.has(obj.apiName) ? CANON_CHUNK_SIZE : CHUNK_SIZE);
    try {
      if (!obj.bulkJobId) {
        const fields = await fieldsFor(opts, obj.apiName, caches);
        obj.bulkJobId = await createBulkQueryJob(opts.conn, `SELECT ${fields.join(", ")} FROM ${obj.apiName}`);
        obj.state = "running";
        obj.chunksDone = 0;
        obj.seen = 0;
        obj.locator = undefined;
        if (obj.apiName === "Opportunity") for (const d of dependents) d.state = "running";
        await checkpoint(opts.objects, []);
      } else if (!isStandard(obj.apiName) && !caches.defs.has(obj.apiName)) {
        await fieldsFor(opts, obj.apiName, caches);
      }
      await waitBulkQueryJob(opts.conn, obj.bulkJobId);
      for (;;) {
        if (opts.deadlineAt !== undefined && now() >= opts.deadlineAt) return { done: false };
        const page = await bulkQueryPage(opts.conn, obj.bulkJobId, obj.locator, chunkSize);
        const chunkIndex = obj.chunksDone ?? 0;
        const key = idempotencyKeyFor(opts.orgId, obj.apiName, obj.bulkJobId, chunkIndex);
        const result: ChunkResult = page.rows.length ? await importChunk(opts, caches, obj.apiName, page.rows, key) : { upserted: 0, merged: 0, rejected: [] };
        obj.upserted += result.upserted;
        obj.merged += result.merged;
        obj.rejected += result.rejected.length;
        obj.seen = (obj.seen ?? 0) + page.rows.length;
        obj.chunksDone = chunkIndex + 1;
        obj.locator = page.nextLocator;
        if (!page.nextLocator) obj.state = "done";
        if (result.roles && roles) {
          roles.upserted += result.roles.upserted;
          roles.rejected += result.roles.rejected.length;
          roles.seen = (roles.seen ?? 0) + result.roles.seen;
        }
        if (result.history && history) {
          history.upserted += result.history.upserted;
          history.seen = (history.seen ?? 0) + result.history.seen;
        }
        if (!page.nextLocator && obj.apiName === "Opportunity") for (const d of dependents) d.state = "done";
        await checkpoint(opts.objects, [...result.rejected, ...(result.roles?.rejected ?? [])], tallies(caches, result.owners));
        if (!page.nextLocator) break;
      }
    } catch (error) {
      if (error instanceof CheckpointError) throw error.cause;
      obj.state = "failed";
      obj.error = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      if (obj.apiName === "Opportunity") for (const d of dependents) Object.assign(d, { state: "failed", error: "Not imported: the opportunities failed" });
      await opts.checkpoint(opts.objects, []);
    }
  }
  return { done: true };
}

class CheckpointError extends Error {
  constructor(cause: unknown) { super("checkpoint failed", { cause }); }
}

const isStandard = (n: string) => n === "Account" || n === "Contact" || n === "Lead" || CANON_OBJECTS.has(n);

const ACTIVITY_FIELDS: Record<(typeof ACTIVITY_SOURCES)[number], readonly string[]> = { Task: TASK_FIELDS, Event: EVENT_FIELDS, Note: NOTE_FIELDS, ContentDocument: DOCUMENT_FIELDS };

function canonOf(opts: RunOptions): CanonSink {
  if (!opts.canon) throw new Error("Opportunities and contact roles import into Canon itself, which this run has no connection to");
  return opts.canon;
}

async function fieldsFor(opts: RunOptions, apiName: string, caches: Caches): Promise<string[]> {
  if (apiName === "Account") return [...ACCOUNT_FIELDS];
  if (apiName === "Contact") return [...CONTACT_FIELDS];
  if (apiName === "Lead") return [...LEAD_FIELDS];
  if (apiName === "Opportunity") return (await opportunitySetup(opts, caches)).fields;
  if (apiName in ACTIVITY_FIELDS) {
    const has = new Set((await describeSObject(opts.conn, apiName)).fields.map((f) => f.name));
    return ACTIVITY_FIELDS[apiName as keyof typeof ACTIVITY_FIELDS].filter((f) => has.has(f));
  }
  const d = await describeSObject(opts.conn, apiName);
  const def = objectDefFromDescribe(d);
  caches.defs.set(apiName, def);
  await opts.sink.defineObjects([def]);
  return bulkFieldsOf(d.fields);
}

/** Salesforce users, each with the Canon member whose email matches. Null without a Canon sink (record-service-only runs). */
async function ownersOf(opts: RunOptions, caches: Caches): Promise<Map<string, SfOwner> | null> {
  if (!opts.canon) return null;
  if (caches.owners) return caches.owners;
  const users = (await soql<Record<string, string | null>>(opts.conn, "SELECT Id, Name, Email FROM User")).records;
  const emails = [...new Set(users.map((u) => (u.Email ?? "").trim().toLowerCase()).filter(Boolean))];
  const members = new Map<string, string>();
  for (let i = 0; i < emails.length; i += 500) {
    for (const m of await opts.canon.membersByEmail(emails.slice(i, i + 500))) members.set(m.email, m.memberId);
  }
  caches.owners = new Map(users.flatMap((u): Array<[string, SfOwner]> => {
    const sfUserId = normalizeSfId(u.Id ?? undefined);
    if (!sfUserId) return [];
    const email = (u.Email ?? "").trim().toLowerCase() || undefined;
    const memberId = email ? members.get(email) : undefined;
    return [[sfUserId, { sfUserId, name: (u.Name ?? "").trim() || sfUserId, ...(email ? { email } : {}), ...(memberId ? { memberId } : {}) }]];
  }));
  return caches.owners;
}

function tallies(caches: Caches, refs: Map<string, number> | undefined): OwnerTally[] | undefined {
  if (!refs?.size) return undefined;
  return [...refs].map(([sfUserId, records]) => {
    const o = caches.owners?.get(sfUserId);
    return { sfUserId, name: o?.name ?? sfUserId, ...(o?.email ? { email: o.email } : {}), ...(o?.memberId ? { memberId: o.memberId } : {}), records };
  });
}

function countOwner(refs: Map<string, number>, ownerId: string | undefined) {
  const id = normalizeSfId(ownerId);
  if (id) refs.set(id, (refs.get(id) ?? 0) + 1);
}

/**
 * The org's sales processes as Canon pipelines, and which Opportunity
 * fields this org has. An org with record types has one process per
 * BusinessProcess; one without has a single process of every active stage.
 */
async function opportunitySetup(opts: RunOptions, caches: Caches) {
  if (caches.opportunities) return caches.opportunities;
  const canon = canonOf(opts);
  const describe = await describeSObject(opts.conn, "Opportunity");
  const has = new Set(describe.fields.map((f) => f.name));
  const { specs } = customFieldSpecs(describe.fields);
  const custom = new Map((specs.length ? await canon.prepareCustomFields("deal", specs) : []).map((p) => [p.sfName, p]));
  const fields = [...OPPORTUNITY_FIELDS.filter((f) => has.has(f)), ...custom.keys()];
  const stageRows = (await soql<Record<string, unknown>>(opts.conn,
    "SELECT ApiName, MasterLabel, IsActive, IsClosed, IsWon, ForecastCategoryName, DefaultProbability, SortOrder FROM OpportunityStage ORDER BY SortOrder ASC")).records;
  const defaults = new Map<string, SfStage>();
  const active: string[] = [];
  for (const r of stageRows) {
    const name = String(r.ApiName ?? r.MasterLabel ?? "").trim();
    if (!name) continue;
    const closed = r.IsClosed === true || r.IsClosed === "true";
    const won = closed && (r.IsWon === true || r.IsWon === "true");
    defaults.set(name, { name, probability: Number(r.DefaultProbability ?? 0) || 0, forecastCategory: forecastCategoryOf(String(r.ForecastCategoryName ?? ""), closed, won) });
    if (r.IsActive !== false && r.IsActive !== "false") active.push(name);
  }
  const processes: SalesProcess[] = [];
  if (has.has("RecordTypeId")) {
    const types = (await soql<Record<string, string | null>>(opts.conn, "SELECT Id, Name, BusinessProcessId FROM RecordType WHERE SobjectType = 'Opportunity'")).records;
    const processNames = new Map((await soql<Record<string, string>>(opts.conn, "SELECT Id, Name FROM BusinessProcess WHERE TableEnumOrId = 'Opportunity'")).records
      .map((p) => [normalizeSfId(p.Id) ?? p.Id, p.Name]));
    const byProcess = new Map<string, { name: string; recordTypeIds: string[] }>();
    for (const t of types) {
      const id = normalizeSfId(t.Id ?? undefined);
      if (!id) continue;
      const processId = normalizeSfId(t.BusinessProcessId ?? undefined) ?? id;
      const entry = byProcess.get(processId) ?? { name: processNames.get(processId) ?? String(t.Name ?? id), recordTypeIds: [] };
      entry.recordTypeIds.push(id);
      byProcess.set(processId, entry);
    }
    for (const p of byProcess.values()) {
      const picklist = await restGet<{ values: Array<{ value: string }> }>(opts.conn, `/ui-api/object-info/Opportunity/picklist-values/${p.recordTypeIds[0]}/StageName`);
      const stages = picklist.values.map((v) => defaults.get(v.value)).filter((s): s is SfStage => s !== undefined);
      if (stages.length) processes.push({ name: p.name, recordTypeIds: p.recordTypeIds, stages });
    }
  }
  if (!processes.length) processes.push({ name: "Salesforce pipeline", recordTypeIds: [""], stages: active.map((n) => defaults.get(n)!) });
  const placements = await canon.preparePipelines(processes);
  const stages = new Map(placements.map((p) => [stageKey(p.recordTypeId, p.stageName), p.value]));
  // Opportunities with no record type, or one the org deleted, take the first process that holds their stage.
  for (const p of placements) if (!stages.has(stageKey("", p.stageName))) stages.set(stageKey("", p.stageName), p.value);
  caches.opportunities = { fields, stages, defaults, custom, defaultCurrency: await defaultCurrency(opts.conn, has.has("CurrencyIsoCode")) };
  return caches.opportunities;
}

/** The org's currency for opportunities without CurrencyIsoCode (single-currency orgs). */
async function defaultCurrency(conn: SfConn, multiCurrency: boolean): Promise<string> {
  if (multiCurrency) return "USD";
  try {
    const org = (await soql<Record<string, string>>(conn, "SELECT DefaultCurrencyIsoCode FROM Organization")).records[0];
    return /^[A-Za-z]{3}$/.test(org?.DefaultCurrencyIsoCode ?? "") ? org.DefaultCurrencyIsoCode.toUpperCase() : "USD";
  } catch {
    return "USD";
  }
}

type ChunkResult = {
  upserted: number;
  merged: number;
  rejected: RejectedRow[];
  /** Records per Salesforce owner among this chunk's accepted rows. */
  owners?: Map<string, number>;
  /** The chunk's opportunities' contact roles, counted on the OpportunityContactRole object. */
  roles?: { seen: number; upserted: number; rejected: RejectedRow[] };
  /** The chunk's opportunities' history rows read and dated points written, counted on OpportunityHistory. */
  history?: { seen: number; upserted: number };
};

/** Split mapped rows into accepted inputs (with their sfIds) and rejections. */
function partition<T>(object: string, rows: Record<string, string>[], map: (r: Record<string, string>) => Mapped<T>) {
  const ok: T[] = [];
  const okSfIds: Array<string | undefined> = [];
  const okRows: Record<string, string>[] = [];
  const rejected: RejectedRow[] = [];
  for (const r of rows) {
    const m = map(r);
    if (m.reject !== undefined) rejected.push({ object, sfId: normalizeSfId(r.Id) ?? r.Id, reason: m.reject });
    else { ok.push(m.ok); okSfIds.push(normalizeSfId(r.Id)); okRows.push(r); }
  }
  return { ok, okSfIds, okRows, rejected };
}

/**
 * Record which register row each accepted record landed on. The service
 * lists landed rows in request order, one per record when every record has
 * its own sfId; if two landed on one row the pairs are ambiguous and skipped.
 */
async function remember(
  opts: RunOptions, object: string, okSfIds: Array<string | undefined>, sinkRejected: ReadonlySet<number>, ids: readonly string[], domains?: readonly string[],
) {
  if (!opts.canon) return;
  const landedAt = okSfIds.map((_, i) => i).filter((i) => !sinkRejected.has(i));
  if (landedAt.length !== ids.length) return;
  const pairs = landedAt.flatMap((at, k) => (okSfIds[at] ? [{ sfId: okSfIds[at]!, canonId: ids[k] }] : []));
  // An account refused for a domain another account in this chunk holds is that company in Canon, as its contacts are.
  if (domains) {
    const byDomain = new Map(landedAt.map((at, k) => [domains[at], ids[k]]));
    for (const at of sinkRejected) {
      const holder = byDomain.get(domains[at]);
      if (holder && okSfIds[at]) pairs.push({ sfId: okSfIds[at]!, canonId: holder });
    }
  }
  for (let i = 0; i < pairs.length; i += 500) await opts.canon.rememberIds(object, pairs.slice(i, i + 500));
}

async function importChunk(opts: RunOptions, caches: Caches, object: string, rows: Record<string, string>[], key: string): Promise<ChunkResult> {
  if (object === "Account") {
    const owners = await ownersOf(opts, caches);
    const refs = new Map<string, number>();
    const p = partition(object, rows, mapAccount);
    for (const r of p.rejected) if (r.sfId) caches.parents.set(r.sfId, { missing: r.reason });
    if (!p.ok.length) return { upserted: 0, merged: 0, rejected: p.rejected };
    p.okRows.forEach((r, i) => {
      const memberId = owners?.get(normalizeSfId(r.OwnerId) ?? "")?.memberId;
      if (memberId) p.ok[i].ownerId = memberId;
    });
    const res = await opts.sink.upsertAccounts({ records: p.ok, source: SOURCE, idempotencyKey: key, merge: { matchBy: ["sfId", "domain"] } });
    const sinkRejected = new Set(res.rejected.map((r) => r.index));
    for (const r of res.rejected) {
      const sfId = r.sfId ?? p.okSfIds[r.index];
      p.rejected.push({ object, sfId, reason: r.reason });
      // Usually a duplicate domain in Salesforce: the domain's account exists
      // (under the other sfId), so this account's contacts attach to it. This
      // matches what resolveParents derives after a resume. If the domain does
      // not exist, the contact upsert rejects the row with the service's reason.
      if (sfId) caches.parents.set(sfId, { domain: p.ok[r.index].domain });
    }
    p.ok.forEach((a, i) => {
      if (sinkRejected.has(i)) return;
      caches.parents.set(a.sfId!, { domain: a.domain });
      caches.domains.add(a.domain);
      if (owners) countOwner(refs, p.okRows[i].OwnerId);
    });
    await remember(opts, object, p.okSfIds, sinkRejected, res.ids, p.ok.map((a) => a.domain));
    return { upserted: res.upserted, merged: res.merged, rejected: p.rejected, owners: refs };
  }

  if (object === "Contact") {
    await resolveParents(opts.conn, caches, rows.map((r) => r.AccountId).filter(Boolean));
    const p = partition(object, rows, (r) => mapContact(r, r.AccountId ? caches.parents.get(normalizeSfId(r.AccountId) ?? r.AccountId) : undefined));
    const orphanDomains = p.okRows.filter((r) => !r.AccountId).map((r) => ({ domain: domainFromEmail(r.Email)! }));
    await ensureAccounts(opts, caches, orphanDomains, `${key}:stubs`);
    return upsertContactsChunk(opts, object, p, key);
  }

  if (object === "Lead") {
    const p = partition(object, rows, mapLead);
    await ensureAccounts(opts, caches, p.ok.map((c, i) => ({ domain: c.accountDomain!, company: p.okRows[i].Company })), `${key}:stubs`);
    return upsertContactsChunk(opts, object, p, key);
  }

  if (object === "Opportunity") return importOpportunities(opts, caches, rows);
  if (object in ACTIVITY_FIELDS) return importActivities(opts, caches, object, rows);

  const def = caches.defs.get(object);
  const p = partition(object, rows, (r) => mapCustom(r, def));
  if (!p.ok.length) return { upserted: 0, merged: 0, rejected: p.rejected };
  const res = await opts.sink.upsertCustom(object, { records: p.ok, source: SOURCE, idempotencyKey: key });
  for (const r of res.rejected) p.rejected.push({ object, sfId: r.sfId ?? p.okSfIds[r.index], reason: r.reason });
  return { upserted: res.upserted, merged: res.merged, rejected: p.rejected };
}

/** Opportunities into deals, then the contact roles of the ones that landed, read together so each deal's roles are decided as a set. */
async function importOpportunities(opts: RunOptions, caches: Caches, rows: Record<string, string>[]): Promise<ChunkResult> {
  const canon = canonOf(opts);
  const setup = await opportunitySetup(opts, caches);
  const owners = (await ownersOf(opts, caches))!;
  const p = partition("Opportunity", rows, (r) => mapOpportunity(r, { stages: setup.stages, owners, defaultCurrency: setup.defaultCurrency }, setup.defaults));
  if (!p.ok.length) return { upserted: 0, merged: 0, rejected: p.rejected, roles: { seen: 0, upserted: 0, rejected: [] } };
  p.okRows.forEach((r, i) => {
    if (!setup.custom.size) return;
    p.ok[i].custom = Object.fromEntries([...setup.custom.values()].map((c) => [c.apiName, customValue(r[c.sfName], c)]));
  });
  const historyRead = caches.withHistory ? await readHistory(opts, setup, p.ok, p.okRows) : 0;
  const res = await canon.upsertDeals(p.ok);
  const refused = new Set(res.rejected.map((r) => r.index));
  for (const r of res.rejected) p.rejected.push({ object: "Opportunity", sfId: p.ok[r.index].sfId, reason: r.reason });
  const landed: DealImport[] = p.ok.filter((_, i) => !refused.has(i));
  const refs = new Map<string, number>();
  for (const d of landed) countOwner(refs, d.ownerSfId);

  const roleRows: Record<string, string>[] = [];
  for (let i = 0; i < landed.length; i += 200) {
    const ids = landed.slice(i, i + 200).map((d) => `'${d.sfId}'`).join(",");
    const res = await soql<Record<string, unknown>>(opts.conn, `SELECT ${CONTACT_ROLE_FIELDS.join(", ")} FROM ${CONTACT_ROLE} WHERE OpportunityId IN (${ids})`);
    for (const r of res.records) roleRows.push(Object.fromEntries(CONTACT_ROLE_FIELDS.map((f) => [f, r[f] === null || r[f] === undefined ? "" : String(r[f])])));
  }
  const plan = planDealRoles(roleRows);
  // Every landed opportunity is sent, with no roles when it has none, so roles deleted in Salesforce leave the deal.
  const planned = new Set(plan.deals.map((d) => d.opportunitySfId));
  for (const d of landed) if (!planned.has(d.sfId)) plan.deals.push({ opportunitySfId: d.sfId, roles: [] });
  const rolesRejected: RejectedRow[] = plan.rejected.map((r) => ({ object: CONTACT_ROLE, sfId: r.sfId, reason: r.reason }));
  let applied = 0;
  for (let i = 0; i < plan.deals.length; i += 50) {
    const out = await canon.setDealRoles(plan.deals.slice(i, i + 50));
    applied += out.applied;
    for (const r of out.rejected) rolesRejected.push({ object: CONTACT_ROLE, sfId: r.sfId, reason: r.reason });
  }
  return {
    upserted: res.created + res.updated, merged: res.updated, rejected: p.rejected, owners: refs,
    roles: { seen: roleRows.length, upserted: applied, rejected: rolesRejected },
    ...(caches.withHistory ? { history: { seen: historyRead, upserted: landed.reduce((n, d) => n + (d.history?.length ?? 0), 0) } } : {}),
  };
}

const STAGE_HISTORY_FIELDS = ["Id", "OpportunityId", "StageName", "Amount", "CloseDate", "Probability", "ForecastCategory", "CreatedDate"];
const FIELD_HISTORY_FIELDS = ["Id", "OpportunityId", "Field", "NewValue", "CreatedDate"];

/** Read the chunk's stage and field history and give each deal its dated points. Returns the history rows read. */
async function readHistory(opts: RunOptions, setup: NonNullable<Caches["opportunities"]>, deals: DealImport[], rows: Record<string, string>[]): Promise<number> {
  const stageRows: Record<string, unknown>[] = [];
  const fieldRows: Record<string, unknown>[] = [];
  for (let i = 0; i < deals.length; i += 200) {
    const ids = deals.slice(i, i + 200).map((d) => `'${d.sfId}'`).join(",");
    stageRows.push(...(await soql<Record<string, unknown>>(opts.conn, `SELECT ${STAGE_HISTORY_FIELDS.join(", ")} FROM ${DEAL_HISTORY} WHERE OpportunityId IN (${ids})`)).records);
    fieldRows.push(...(await soql<Record<string, unknown>>(opts.conn, `SELECT ${FIELD_HISTORY_FIELDS.join(", ")} FROM ${FIELD_HISTORY} WHERE OpportunityId IN (${ids})`)).records);
  }
  const recordTypeOf = new Map(deals.map((d, i) => [d.sfId, normalizeSfId(rows[i].RecordTypeId) ?? ""]));
  const points = historyPoints(stageRows, fieldRows, {
    stageValue: (opp, name) => setup.stages.get(stageKey(recordTypeOf.get(opp) ?? "", name)) ?? setup.stages.get(stageKey("", name)) ?? name,
    stages: setup.defaults, custom: setup.custom,
  });
  for (const d of deals) {
    const list = points.get(d.sfId);
    // A point no older than the current snapshot is the current value itself; the snapshot carries it.
    const kept = list?.filter((p) => d.modifiedAt === undefined || p.at < d.modifiedAt);
    if (kept?.length) d.history = kept;
  }
  return stageRows.length + fieldRows.length;
}

/** Tasks, events, notes and documents as Canon activities, each about the records it names. */
async function importActivities(opts: RunOptions, caches: Caches, object: string, rows: Record<string, string>[]): Promise<ChunkResult> {
  const canon = canonOf(opts);
  const owners = (await ownersOf(opts, caches))!;
  let p;
  if (object === "ContentDocument") {
    const ids = rows.map((r) => normalizeSfId(r.Id)).filter((id): id is string => id !== undefined);
    const links = new Map<string, string[]>();
    for (let i = 0; i < ids.length; i += 200) {
      const res = await soql<Record<string, string>>(opts.conn, `SELECT ContentDocumentId, LinkedEntityId FROM ContentDocumentLink WHERE ContentDocumentId IN (${ids.slice(i, i + 200).map((id) => `'${id}'`).join(",")})`);
      for (const l of res.records) {
        const doc = normalizeSfId(l.ContentDocumentId)!;
        links.set(doc, [...(links.get(doc) ?? []), normalizeSfId(l.LinkedEntityId) ?? l.LinkedEntityId]);
      }
    }
    const content = new Map<string, string>();
    for (const r of rows) {
      const id = normalizeSfId(r.Id);
      if (id && (r.FileType ?? "").toUpperCase() === "SNOTE" && links.get(id)?.some((l) => !l.startsWith("005"))) {
        content.set(id, await restGetText(opts.conn, `/sobjects/ContentNote/${id}/Content`));
      }
    }
    p = partition(object, rows, (r) => mapDocument(r, owners, links.get(normalizeSfId(r.Id) ?? "") ?? [], opts.conn.instanceUrl, content.get(normalizeSfId(r.Id) ?? "")));
  } else {
    const map = object === "Task" ? mapTask : object === "Event" ? mapEvent : mapLegacyNote;
    p = partition(object, rows, (r) => map(r, owners));
  }
  if (!p.ok.length) return { upserted: 0, merged: 0, rejected: p.rejected };
  const res = await canon.upsertActivities(p.ok);
  const refused = new Set(res.rejected.map((r) => r.index));
  for (const r of res.rejected) p.rejected.push({ object, sfId: p.ok[r.index].sfId, reason: r.reason });
  const refs = new Map<string, number>();
  p.ok.forEach((a, i) => { if (!refused.has(i)) countOwner(refs, a.ownerSfId); });
  return { upserted: res.created + res.updated, merged: res.updated, rejected: p.rejected, owners: refs };
}

async function upsertContactsChunk(
  opts: RunOptions,
  object: string,
  p: ReturnType<typeof partition<import("./contracts.ts").ContactInput>>,
  key: string,
): Promise<ChunkResult> {
  if (!p.ok.length) return { upserted: 0, merged: 0, rejected: p.rejected };
  const res = await opts.sink.upsertContacts({ records: p.ok, source: SOURCE, idempotencyKey: key, merge: { matchBy: ["sfId", "email", "linkedinUrl"] } });
  for (const r of res.rejected) p.rejected.push({ object, sfId: r.sfId ?? p.okSfIds[r.index], reason: r.reason });
  await remember(opts, object, p.okSfIds, new Set(res.rejected.map((r) => r.index)), res.ids);
  return { upserted: res.upserted, merged: res.merged, rejected: p.rejected };
}


/**
 * Accounts keyed by email/website domain for Leads and Account-less
 * Contacts. Only domains not imported in this run are sent; merge by domain
 * lets an existing TAM account absorb the stub.
 */
async function ensureAccounts(opts: RunOptions, caches: Caches, rows: Array<{ domain: string; company?: string }>, key: string) {
  const stubs: AccountInput[] = stubAccountsFor(rows.filter((r) => r.domain), (d) => caches.domains.has(d));
  if (!stubs.length) return;
  for (let i = 0; i < stubs.length; i += CHUNK_SIZE) {
    await opts.sink.upsertAccounts({ records: stubs.slice(i, i + CHUNK_SIZE), source: SOURCE, idempotencyKey: `${key}:${i}`, merge: { matchBy: ["domain"] } });
  }
  for (const s of stubs) caches.domains.add(s.domain);
}

/** Fill `caches.parents` for AccountIds not seen in this run (e.g. after a resume). */
async function resolveParents(conn: SfConn, caches: Caches, accountIds: string[]) {
  const missing = [...new Set(accountIds.map((id) => normalizeSfId(id) ?? id))].filter((id) => !caches.parents.has(id));
  for (let i = 0; i < missing.length; i += 200) {
    const batch = missing.slice(i, i + 200);
    const res = await soql<Record<string, string>>(conn, `SELECT Id, Name, Website FROM Account WHERE Id IN (${batch.map((id) => `'${id.replace(/[^A-Za-z0-9]/g, "")}'`).join(",")})`);
    for (const r of res.records) {
      const m = mapAccount(r);
      const id = normalizeSfId(r.Id)!;
      caches.parents.set(id, m.ok ? { domain: m.ok.domain } : { missing: m.reject! });
      if (m.ok) caches.domains.add(m.ok.domain);
    }
  }
}
