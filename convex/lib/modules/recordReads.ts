/**
 * The Canon reads a read plan names that the record service serves (docs/modules.md, "Server code"): companies,
 * people and activities. The plan's one query can't reach the service, so it plans each one (`planRecordRead`: the
 * ids, checked, and a deal's ledger stream for its activities) and the call's action reads it (`readRecords`) through
 * the caller's scoped record client, as the caller sees the records, or Canon's own for a system call. Each read
 * refuses past its limit rather than return part of what it names, and returns `id`, `createdAt` and the granted
 * fields. A field the caller's role hides reads as null.
 */
import { observationTouch, type TouchBody } from "../signals/observationTouches.ts";
import type { InboundMatchInput } from "../../../modules/kernel/inboundMatchInput.ts";
import type { ChannelSuppressions, SuppressionIdentifiers, SuppressionPurpose } from "../suppressions/domain";
import { ConvexError } from "convex/values";
import { ACTIVITY_OBJECTS, activityOf, type ActivityObject, type ModuleActivityRow } from "../activities.ts";
import { IN_VALUES_MAX, LIST_LIMIT_MAX, type ListFilter, type ListRequest, type ListResponse, type ListRow } from "../objects/listSpec.ts";
import type { RecordClient } from "../recordClient.ts";
import { SNAPSHOT_PAGE, type CanonRead } from "../../../modules/kernel/manifest.ts";
import type { FactObject, FactsForRecordsRow } from "../../../modules/kernel/facts.ts";
import { visibleIds } from "../scopedRecordClient.ts";
import { customVariablesOf } from "./peopleExport.ts";
import { AUDIENCE_MAX } from "../outbound/audience.ts";

/** A planned record read: what the call's action asks the record service for. */
export type RecordReadSpec = {
  match?: InboundMatchInput;
  companies?: Record<string, string>;
  withSuppression?: boolean; purpose?: SuppressionPurpose;
  read: CanonRead; ids: string[]; since: number | null; limit: number; fields: string[];
  /** activities.forDeals: each requested deal the caller sees, by its ledger stream id. */
  streams?: Record<string, string>;
  /** deals.people: each person's places on the deals the caller sees (`ids` are the people), in the deals' order. */
  members?: Record<string, Array<{ dealId: string; role: string }>>;
  /** observations.forPeople: the end of the range (ms), and the channels asked for (every one when absent). */
  until?: number | null;
  types?: string[];
  /** facts.forRecords: the object `ids` are of, the declared attributes it reads and the receipts per attribute. */
  facts?: { object: FactObject; attributes: string[]; receipts: number };
  /**
   * audiences.snapshot (`ids` is the audience) and people.snapshot (`ids` is the interface doc's key): the module taking
   * it, the filter, and for an interface doc the set holding the people added to it one at a time.
   */
  audience?: { moduleId: string; filter: ListFilter[]; source?: string; added?: AddedSource };
  /** Activities: the ledger's shard heads when the plan ran. The read sees every activity logged before it, or refuses. */
  through?: Record<string, number>;
};
/** The set under a module doc that holds the people added to it one at a time (`provides.<name>.people.added`). */
export type AddedSource = { module: string; set: string; parentKey: string; field: string };
export type SnapshotSource = { audienceId: string } | { source: string };
/** The record service hasn't projected the ledger up to the plan's heads yet: its activities would miss recent changes. */
export class ProjectionBehind extends Error {}
/** An activity's edge to a record it is about (convex/activityTargets.ts). */
export type Edge = { fromId: string; toId: string };
/** What the action gives the reads besides the record client: edges, and the deals of ledger streams. */
export type RecordReadPorts = {
  conversationsOf?(dealIds: string[], domains: Record<string, string>, fields: string[], limit: number): Promise<Array<Record<string, unknown>>>;
  /** Only on caller-scoped reads with the explicit derived grant. Missing support refuses, never returns a permissive verdict. */
  suppressionCheck?(identifiers: SuppressionIdentifiers[], purpose: SuppressionPurpose): Promise<ChannelSuppressions[]>;
  edgesTo(toIds: string[], limit: number): Promise<Edge[]>;
  dealsOf(streamIds: string[]): Promise<Record<string, string>>;
  moduleActivities?(spec: RecordReadSpec): Promise<ModuleActivityRow[]>;
  /** The recorded calls and meetings filed on deals (convex/moduleActivityContent.ts), when a read asks what was said. */
  recordingsOf?(dealIds: string[], since: number | null): Promise<RecordingMeta[] | { over: true }>;
  recordingContent?(id: string): Promise<RecordingContent | { over: true } | null>;
  /** The ids of the people added one at a time to an audience, or to a module doc's set, every one (paged inside). */
  addedTo(source: string | AddedSource): Promise<string[]>;
  /** People's observation logs (convex/observations.ts forPeople), cut to what a touch reads, in a time range. */
  observationsOf?(contactIds: string[], since: number | null, until: number | null): Promise<Array<{ contactId: string; at: number; body: TouchBody }>>;
  /** Store an audience snapshot's people ids, a page at a time; its id and when it was taken. */
  snapshot(moduleId: string, source: SnapshotSource, ids: string[]): Promise<{ snapshot: string; createdAt: number }>;
  /**
   * The fact ledger's fields of records the caller sees (convex/canonGate.ts factsForRecords), with the companies or
   * people the caller's client `admitted`. Only for a call read as a member.
   */
  factsOf?(facts: NonNullable<RecordReadSpec["facts"]>, ids: string[], admitted: string[]): Promise<FactsForRecordsRow[]>;
};
/** Records per facts query: 10 records of 20 attributes with 20 receipts each stay well inside a query's reads. */
const FACTS_PER_QUERY = 10;
export type RecordingMeta = { id: string; activityId: string | null; dealId: string; title: string; at: number | null; ownerId: string | null; provider: string };
export type RecordingContent = { transcript: string | null; insights: Array<{ type: string; text: string; evidence: string }> };
/** The most text (notes, transcripts, insights) one activity read returns: under a call's 4 MB of reads. */
export const CONTENT_MAX_CHARS = 3_000_000;
/** The fields that read what was said: a note's or a call's text, a recording's transcript and its insights. */
const CONTENT_FIELDS = ["text", "transcript", "insights"];

const refuse = (message: string): never => { throw new ConvexError(message); };

/** Every row a list names, a page at a time, refusing past `limit`, and behind `through` (the plan's ledger heads). */
async function listAll(list: (req: ListRequest) => Promise<ListResponse>, filter: ListFilter[], limit: number, over: () => never, through?: Record<string, number>): Promise<ListRow[]> {
  const rows: ListRow[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ filter, sort: { field: "createdAt", dir: "desc" }, limit: LIST_LIMIT_MAX, ...(cursor ? { cursor } : {}) });
    if (through && Object.entries(through).some(([shard, seq]) => (page.projectedThrough?.[shard] ?? 0) < seq)) throw new ProjectionBehind();
    rows.push(...page.rows);
    if (rows.length > limit) over();
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return rows;
}

const chunks = <T>(xs: readonly T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const text = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown) => (typeof v === "number" ? v : null);
const pick = (all: Record<string, unknown>, fields: readonly string[]) => Object.fromEntries(fields.map((f) => [f, all[f] ?? null]));

export async function resolvePeopleRows(client: RecordClient, ws: string, addedTo: RecordReadPorts["addedTo"], query: { filter: ListFilter[]; added?: AddedSource }, legacyAudience?: string): Promise<ListRow[]> {
  const over = () => refuse(`This audience has more than ${AUDIENCE_MAX.toLocaleString("en-US")} people. Narrow its filter.`);
  const rows = await listAll((req) => client.listRegister(ws, "contact", req), query.filter, AUDIENCE_MAX, over);
  const matched = new Set(rows.map((r) => r.id));
  const additions = query.added ? await addedTo(query.added) : legacyAudience ? await addedTo(legacyAudience) : [];
  const added = [...new Set(additions)].filter((id) => !matched.has(id));
  const seen = added.length ? await registerByIds(client, ws, "contact", added, AUDIENCE_MAX, over) : [];
  if (rows.length + seen.length > AUDIENCE_MAX) over();
  return [...new Map([...rows, ...seen].map((row) => [row.id, row])).values()];
}

/**
 * An audience's members now, frozen (docs/modules.md, "Audiences"): the people its filter matches as the reader sees
 * them, then those added one at a time that the reader sees, each once, stored by `ports.snapshot` so a job's later pages read the same
 * people. Past `AUDIENCE_MAX` it refuses, as the Audiences page does.
 */
async function snapshotOf(client: RecordClient, ws: string, ports: RecordReadPorts, spec: RecordReadSpec) {
  const a = spec.audience!;
  const rows = await resolvePeopleRows(client, ws, ports.addedTo, a, spec.read === "audiences.snapshot" ? spec.ids[0] : undefined);
  const ids = rows.map((r) => r.id);
  const withEmail = rows.filter((r) => text(r.values.email) !== null).length;
  if (spec.read === "people.count") return { source: spec.ids[0], count: ids.length, withEmail, customVariables: customVariablesOf(rows), computedAt: Date.now() };
  const { snapshot, createdAt } = await ports.snapshot(a.moduleId, a.source ? { source: a.source } : { audienceId: spec.ids[0] }, ids);
  const pages = Math.max(1, Math.ceil(ids.length / SNAPSHOT_PAGE));
  if (spec.read === "audiences.snapshot") return { id: snapshot, createdAt, audience: spec.ids[0], count: ids.length, pages };
  return { id: snapshot, createdAt, source: spec.ids[0], count: ids.length, withEmail, pages };
}

/** Register rows (companies or people) by id, in the order asked. */
async function registerByIds(client: RecordClient, ws: string, object: "account" | "contact", ids: readonly string[], limit: number, over: () => never): Promise<ListRow[]> {
  const out: ListRow[] = [];
  for (const chunk of chunks(ids, IN_VALUES_MAX)) out.push(...await listAll((req) => client.listRegister(ws, object, req), [{ field: "id", op: "in", value: chunk }], limit, over));
  if (out.length > limit) over();
  const order = new Map(ids.map((id, i) => [id, i]));
  return out.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

function companyOf(row: ListRow, fields: readonly string[]) {
  const v = row.values;
  return { id: row.id, createdAt: row.createdAt, ...pick({
    name: text(v.name) ?? row.title, domain: text(v.domain), industry: text(v.industry), employees: num(v.employees), annualRevenue: num(v.annualRevenue),
    country: text(v.country), city: text(v.city), status: text(v.status), ownerId: text(v.ownerId),
  }, fields) };
}
function personOf(row: ListRow & { accountId?: string }, fields: readonly string[]) {
  const v = row.values;
  return { id: row.id, createdAt: row.createdAt, ...pick({
    name: text(v.fullName) ?? row.title, title: text(v.title), email: text(v.email), phone: text(v.phone), linkedinUrl: text(v.linkedinUrl),
    companyId: text(row.accountId), ownerId: text(v.ownerId), lifecycleStage: text(v.lifecycleStage),
  }, fields) };
}

/** Derived status uses the caller client's field-filtered values, never module-supplied addresses or a system read. */
async function peopleOf(rows: ListRow[], ports: RecordReadPorts, spec: RecordReadSpec): Promise<Array<Record<string, unknown>>> {
  const fields = spec.fields.filter((f) => f !== "suppression");
  const people = rows.map((r) => personOf(r, fields));
  if (!spec.withSuppression) return people;
  if (!ports.suppressionCheck) return refuse("Suppression status requires a caller-scoped read.");
  const out: Array<Record<string, unknown>> = [];
  for (const batch of chunks(rows, 100)) {
    const verdicts = await ports.suppressionCheck(batch.map((r) => ({
      ...(text(r.values.email) ? { email: text(r.values.email)! } : {}),
      ...(text(r.values.phone) ? { phone: text(r.values.phone)! } : {}),
      ...(text(r.values.linkedinUrl) ? { linkedinUrl: text(r.values.linkedinUrl)! } : {}),
    })), spec.purpose ?? "automated_outreach");
    if (verdicts.length !== batch.length) return refuse("Suppression status was incomplete.");
    batch.forEach((r, i) => out.push(spec.read === "suppression.check"
      ? { id: r.id, createdAt: r.createdAt, ...verdicts[i] }
      : { ...personOf(r, fields), suppression: verdicts[i] }));
  }
  return out;
}

/**
 * Activities about the records `ids` (deal streams or company ids): those naming one in their `lookup`, and those
 * with an edge to one, logged since `since`, newest first. Each carries the record it was found by.
 */
async function activitiesAbout(client: RecordClient, ws: string, ports: RecordReadPorts, spec: RecordReadSpec, lookup: "dealId" | "accountId", over: () => never) {
  const ids = spec.ids;
  if (!ids.length) return [];
  const since: ListFilter[] = spec.since === null ? [] : [{ field: "createdAt", op: "gte", value: spec.since }];
  const found = new Map<string, { object: ActivityObject; row: ListRow; about: string }>();
  const wanted = new Set(ids);
  for (const object of ACTIVITY_OBJECTS) {
    for (const row of await listAll((req) => client.listObjects(ws, object, req), [{ field: lookup, op: "in", value: ids }, ...since], spec.limit, over, spec.through)) {
      found.set(row.id, { object, row, about: String(row.values[lookup]) });
    }
  }
  if (found.size > spec.limit) over();
  // An activity about several records names the first in its lookups; the rest are its edges.
  const edges = (await ports.edgesTo(ids, spec.limit)).filter((e) => wanted.has(e.toId) && !found.has(e.fromId));
  const aboutOf = new Map<string, string>();
  for (const e of edges) if (!aboutOf.has(e.fromId)) aboutOf.set(e.fromId, e.toId);
  const rest = [...aboutOf.keys()];
  for (const object of ACTIVITY_OBJECTS) {
    for (const chunk of chunks(rest, IN_VALUES_MAX)) {
      for (const row of await listAll((req) => client.listObjects(ws, object, req), [{ field: "id", op: "in", value: chunk }, ...since], spec.limit, over, spec.through)) {
        found.set(row.id, { object, row, about: aboutOf.get(row.id)! });
      }
    }
    if (found.size > spec.limit) over();
  }
  return [...found.values()];
}

/** In the call's action: one planned record read, through `client` (the caller's scoped client, or Canon's own). */
export async function readRecord(client: RecordClient, ws: string, ports: RecordReadPorts, spec: RecordReadSpec): Promise<Array<Record<string, unknown>>> {
  const over = () => refuse(`${spec.read} has more than ${spec.limit} records you can see; narrow it or raise the read's limit.`);
  if (spec.read === "deals.conversations") {
    if (!ports.conversationsOf) return refuse("deals.conversations needs a member-scoped conversation reader.");
    const domains: Record<string, string> = {};
    for (const row of await registerByIds(client, ws, "account", [...new Set(Object.values(spec.companies ?? {}))], 500, over)) {
      const domain = text(row.values.domain);
      if (domain) for (const [dealId, companyId] of Object.entries(spec.companies ?? {})) if (companyId === row.id) domains[dealId] = domain;
    }
    return ports.conversationsOf(spec.ids, domains, spec.fields, spec.limit);
  }
  if (spec.read === "match.inbound") {
    if (!spec.match) return refuse("match.inbound needs its planned input.");
    const match = await client.matchInbound(ws, spec.match);
    return [pick(match, spec.fields)];
  }
  if (spec.read === "companies.bestFit") {
    if (!spec.limit) return [];
    const page = await client.listRegister(ws, "account", { sort: { field: "fit", dir: "desc" }, limit: Math.min(spec.limit, 15) });
    return page.rows.slice(0, Math.min(spec.limit, 15)).map((r) => companyOf(r, spec.fields));
  }
  if (!spec.ids.length) return [];
  if (spec.read === "audiences.snapshot" || spec.read === "people.snapshot" || spec.read === "people.count") return [await snapshotOf(client, ws, ports, spec)];
  if (spec.read === "companies.byIds") return (await registerByIds(client, ws, "account", spec.ids, spec.limit, over)).map((r) => companyOf(r, spec.fields));
  if (spec.read === "suppression.check" || spec.read === "people.byIds" || spec.read === "audiences.members" || spec.read === "people.snapshotPage") return peopleOf(await registerByIds(client, ws, "contact", spec.ids, spec.limit, over), ports, spec);
  if (spec.read === "facts.forRecords") {
    if (!ports.factsOf || !spec.facts) return refuse("facts.forRecords is read in a call, as a member.");
    // The caller's client admits the companies and people they see; one they don't returns no row. Deals are judged in the query.
    const facts = spec.facts, rows: FactsForRecordsRow[] = [];
    for (const ids of chunks(spec.ids, FACTS_PER_QUERY)) {
      const admitted = facts.object === "deals" ? [] : [...await visibleIds(client, ws, facts.object === "people" ? "contact" : "account", ids)];
      rows.push(...await ports.factsOf(facts, ids, admitted));
    }
    return rows;
  }
  if (spec.read === "observations.forPeople") {
    if (!ports.observationsOf) return refuse("observations.forPeople is read in a call.");
    // Only the people the caller sees are asked about; their touches come oldest first.
    const seen = (await registerByIds(client, ws, "contact", spec.ids, spec.ids.length, over)).map((r) => r.id);
    const types = spec.types?.length ? new Set(spec.types) : null;
    const rows = (await ports.observationsOf(seen, spec.since, spec.until ?? null)).flatMap((o) => {
      const t = observationTouch(o.body);
      return t && (!types || types.has(t.channel)) ? [{ personId: o.contactId, at: o.at, ...t }] : [];
    }).sort((a, b) => a.at - b.at);
    if (rows.length > spec.limit) over();
    return rows.map((r, i) => ({ id: `${r.personId}:${r.at}:${i}`, createdAt: r.at, ...pick(r, spec.fields) }));
  }
  if (spec.read === "deals.people") {
    // People the caller can't see are left out; each one they can is a row per deal they're on, with their role.
    const people = new Map((await peopleOf(await registerByIds(client, ws, "contact", spec.ids, spec.limit, over), ports, spec)).map((p) => [p.id as string, p]));
    const rows = Object.entries(spec.members ?? {}).flatMap(([id, places]) => {
      const person = people.get(id);
      return person ? places.map((m) => ({ ...person, dealId: m.dealId, role: m.role })) : [];
    });
    if (rows.length > spec.limit) over();
    return rows;
  }
  if (spec.read === "people.forCompanies") {
    // A company's people are those whose company it is (their primary), read as the caller sees them.
    const ids: string[] = [];
    for (const accountId of spec.ids) {
      let cursor: string | undefined;
      do {
        const page = await client.listContacts(ws, { filter: { accountId }, limit: LIST_LIMIT_MAX, ...(cursor ? { cursor } : {}) });
        ids.push(...page.rows.map((c) => c.id));
        if (ids.length > spec.limit) over();
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
    }
    return peopleOf(await registerByIds(client, ws, "contact", ids, spec.limit, over), ports, spec);
  }
  const forDeals = spec.read === "activities.forDeals";
  const found = await activitiesAbout(client, ws, ports, spec, forDeals ? "dealId" : "accountId", over);
  // A deal is named by its ledger stream on an activity; a module reads it by the deal's id.
  const streams = forDeals ? spec.streams ?? {} : await ports.dealsOf([...new Set(found.flatMap((f) => text(f.row.values.dealId) ?? []))]);
  const sorted = found.map(({ object, row, about }) => ({ object, row, about, a: activityOf(object, row) })).sort((x, y) => y.a.at - x.a.at);
  const rows = sorted.map(({ object, row, about, a }) => {
    const v = row.values;
    const dealStream = forDeals ? about : text(v.dealId);
    return { id: row.id, createdAt: row.createdAt, ...pick({
      kind: object, at: a.at, ownerId: a.ownerId, dealId: dealStream ? streams[dealStream] ?? null : null,
      companyId: forDeals ? text(v.accountId) : about, personId: text(v.contactId),
      subject: a.kind === "task" || a.kind === "call" ? a.subject : a.kind === "meeting" ? a.title : null,
      status: a.kind === "task" ? a.status : null, dueDate: a.kind === "task" ? a.dueDate : null,
      direction: object === "call" ? text(v.direction) : null, outcome: a.kind === "call" ? a.outcome : object === "meeting" ? text(v.outcome) : null,
      durationSeconds: object === "call" ? num(v.durationSeconds) : null,
      // What was written on it: a note's body, a call's or a meeting's notes (a Granola meeting's summary).
      // Never the row's title: a note's title is its body, and a role that hides the body leaves the title.
      text: object === "note" ? text(v.body) : object === "call" || object === "meeting" ? text(v.notes) : null,
    }, spec.fields) } as Record<string, unknown>;
  });
  const modules = await ports.moduleActivities?.(spec) ?? [];
  const at = new Map(rows.map((r, i) => [r, sorted[i].a.at]));
  for (const { activity: a, createdAt, refs } of modules) {
    const about = refs.find((r) => r.object === (forDeals ? "deal" : "account") && spec.ids.includes(r.id));
    if (!about) continue;
    const deal = refs.find((r) => r.object === "deal");
    const company = refs.find((r) => r.object === "account");
    const person = refs.find((r) => r.object === "contact");
    const row: Record<string, unknown> = { id: a.id, createdAt, ...pick({
      kind: a.kind, activityKind: a.activityKind, source: a.source, href: a.source.href, at: a.at, date: a.date ?? null,
      subject: a.subject, status: a.status, dueDate: a.dueDate, ownerId: a.ownerId,
      dealId: forDeals && about.object === "deal" ? about.dealId : deal?.object === "deal" ? deal.dealId : null,
      companyId: forDeals ? company?.id ?? null : about.id, personId: person?.id ?? null,
    }, spec.fields) };
    rows.push(row);
    at.set(row, a.at);
  }
  if (rows.length > spec.limit) over();
  rows.sort((a, b) => at.get(b)! - at.get(a)!);
  if (!spec.fields.some((f) => CONTENT_FIELDS.includes(f))) return rows;
  return withContent(rows, at, spec, forDeals ? Object.values(spec.streams ?? {}) : [], ports, over);
}

/**
 * The activities with what was said on them (shared gap P11): each recorded call or meeting filed on the deals read
 * (`callRecordings`) joins the activity it belongs to, its transcript as speaker-labelled lines and its insights; one
 * with no activity of its own (an imported Gong call) comes as a call of its own, id `recording:<id>`. Read only for
 * the deals the caller sees. Past CONTENT_MAX_CHARS of text, or past the read's limit, it refuses rather than return
 * part of what was said.
 */
async function withContent(rows: Array<Record<string, unknown>>, at: Map<Record<string, unknown>, number>, spec: RecordReadSpec, dealIds: string[], ports: RecordReadPorts, over: () => never) {
  const wantsRecordings = spec.fields.includes("transcript") || spec.fields.includes("insights");
  const metas = wantsRecordings && dealIds.length && ports.recordingsOf ? await ports.recordingsOf(dealIds, spec.since) : [];
  if (!Array.isArray(metas)) return over();
  const byActivity = new Map(rows.map((r) => [String(r.id), r]));
  const out = [...rows];
  for (const m of metas) {
    let row = m.activityId ? byActivity.get(m.activityId) : undefined;
    // A recording of an activity the caller doesn't read (their activity rules hide it, or it is before `since`) stays
    // hidden with it; only a recording with no activity at all comes as a call of its own.
    if (m.activityId && !row) continue;
    const content = await ports.recordingContent?.(m.id);
    if (content && "over" in content) over();
    const said = content ?? { transcript: null, insights: [] };
    if (!row) {
      row = { id: `recording:${m.id}`, createdAt: m.at ?? 0, ...pick({ kind: "call", at: m.at, ownerId: m.ownerId, dealId: m.dealId, companyId: null, personId: null, subject: m.title, status: null, dueDate: null, direction: null, outcome: null, durationSeconds: null, text: null }, spec.fields) };
      out.push(row);
      at.set(row, m.at ?? 0);
      if (out.length > spec.limit) over();
    }
    if (spec.fields.includes("transcript")) row.transcript = said.transcript;
    if (spec.fields.includes("insights")) row.insights = said.insights;
  }
  if (spec.fields.includes("insights")) for (const r of out) if (!Array.isArray(r.insights)) r.insights = [];
  const chars = out.reduce((n, r) => n + JSON.stringify([r.text ?? null, r.transcript ?? null, r.insights ?? null]).length, 0);
  if (chars > CONTENT_MAX_CHARS) refuse(`${spec.read} holds ${chars.toLocaleString("en-US")} characters of notes and transcripts; one read takes at most ${CONTENT_MAX_CHARS.toLocaleString("en-US")}. Read fewer deals, or from a later date.`);
  return out.sort((x, y) => (at.get(y) ?? 0) - (at.get(x) ?? 0));
}
