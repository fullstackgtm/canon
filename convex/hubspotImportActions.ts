"use node";

/**
 * The HubSpot portal import's steps (CP12): each reads and writes pages for a while (reading the next page while it
 * writes the last), side by side for the phases that allow it, then hands the cursors to `hubspotImport.advance`,
 * which schedules the next step. Reads only: the client has no write call.
 */
import { createHash } from "node:crypto";
import { ConvexError, v } from "convex/values";
import { action, internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { accessTokenForOrg } from "./hubspotActions";
import { fixtureFetch } from "./lib/hubspotFixture";
import { clientFor } from "./records";
import { chunk } from "./lib/collections";
import { mirrorAccount, mirrorContact, mirrorDeal, hubspotTime } from "./lib/hubspotMirror";
import {
  CONTACT_IMPORT_PROPERTIES, CUSTOM_OBJECTS, ENGAGEMENTS, HISTORY_FIELDS, customSpecs, customValues, historyFacts, ENGAGEMENT_PROPERTIES, PHASE_RESULT, attachmentIds, attachmentText, engagementOf, SPOT_POOL, SPOT_SAMPLE, compareRecord, companiesOf, contactExtras, dealRoleOf, lanesFor, matchOwners, nextPhase, sampleOf, stageOf,
  type CustomField, type Engagement, type ImportObject, type PartyOrDeal, type Mismatch, type OwnerMatch, type Phase, type SpotValue,
} from "./lib/hubspotImport";
import { createHubspotImportClient, HubspotScopeError, type HsAssociation, type HsObject, type HsOwner, type HsPipeline, type HsRecord, type HsRecordObject, type HubspotImportClient } from "../engine/src/sync/hubspotImport/client.ts";
import { concurrencyLimit, mapLimit } from "../engine/src/connectors/hubspotPacing.ts";
import type { FunctionArgs } from "convex/server";
import { writeInBatches } from "./lib/batchWrites";
import { hubspotAccount, hubspotContact, hubspotDeal, hubspotProperties, hubspotStageClose } from "../engine/src/connectors/hubspot.ts";
import type { FieldMappings } from "./lib/crmMappings";
import type { RecordClient } from "./lib/recordClient";

type Run = Doc<"crmImports">;
type Result = { object: string; read: number; written: number; failed: number };
type Failure = { object: string; id: string; message: string };
type Notice = { object: string; message: string };
type OwnerRecords = Array<{ crmOwnerId: string; records: number }>;
/** What writing one page (or a one-shot phase's whole read) did. */
type Progress = { results: Result[]; failures: Failure[]; notices: Notice[]; ownerRecords?: OwnerRecords; owners?: OwnerMatch[]; customFields?: CustomField[] };

/**
 * A phase as a lane runs it: `read` fetches one page from HubSpot and nothing else, so the next page's read runs
 * while this one's `write` resolves Canon ids and writes. A one-shot phase (owners, pipelines, properties) reads
 * everything as its one page.
 */
type PhaseRunner<P = any> = { read(cursor: string | null): Promise<{ page: P; after: string | null }>; write(page: P): Promise<Progress> };

/** What one step can reach: the run as this step has advanced it, and a limiter every write goes through. */
type StepCtx = {
  ctx: ActionCtx; run: Run; client: HubspotImportClient; mappings: FieldMappings | undefined; rc: RecordClient;
  write: <T>(fn: () => Promise<T>) => Promise<T>;
  pipelines: () => Promise<HsPipeline[]>;
};

const PARTY_BATCH = 100;
const DEAL_BATCH = 50;
// Links, activities and emails per transaction; a batch past a transaction limit is split (lib/batchWrites.ts).
const LINK_BATCH = 100;
// History facts per transaction, a record's facts always together.
const HISTORY_BATCH = 200;
// Write transactions in flight at once across a step's lanes. Ledger saves on one shard serialize, so more buys little.
const WRITE_CONCURRENCY = 3;
/** How long one step keeps reading pages before it records progress and schedules the next. */
const STEP_MS = 25_000;
/** Failures one step carries to `advance`, which keeps the run's first FAILURES_MAX anyway. */
const STEP_FAILURES_MAX = 50;

async function importClient(ctx: ActionCtx, orgId: Id<"organizations">): Promise<{ client: HubspotImportClient; mappings: FieldMappings | undefined }> {
  const { accessToken, fieldMappings } = await accessTokenForOrg(ctx, orgId);
  const fetchImpl = fixtureFetch(accessToken);
  return { client: createHubspotImportClient({ getAccessToken: () => accessToken, ...(fetchImpl ? { fetchImpl } : {}) }), mappings: fieldMappings };
}

const ownerMapOf = (run: Run) => Object.fromEntries(run.owners.flatMap((o) => (o.userId ? [[o.crmOwnerId, o.userId as Id<"users">]] : [])));

/** Per page, how many records each owner nobody in the workspace matches holds. */
function unmatchedRecords(run: Run, ownerIds: ReadonlyArray<string | undefined>) {
  const unmatched = new Set(run.owners.filter((o) => !o.member).map((o) => o.crmOwnerId));
  const counts = new Map<string, number>();
  for (const id of ownerIds) if (id && unmatched.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts].map(([crmOwnerId, records]) => ({ crmOwnerId, records }));
}

const sha20 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 20);

/** Wait until the record service has projected the org's ledger, so the register lists what earlier phases wrote. */
async function settle(ctx: ActionCtx, rc: RecordClient, orgId: Id<"organizations">) {
  if (rc.mode !== "http") return;
  await rc.nudgeProjector(orgId, await ctx.runQuery(internal.ledgerFeed.shardHeadsOf, { orgId }), process.env.CONVEX_SITE_URL, { wait: true });
}

/**
 * The register ids (`acc_…`, `con_…`) of HubSpot companies or people: the register row linked to each one's ledger
 * stream, found by its domain or email, else by the id the register gives a stream with neither.
 */
async function registerIds(ctx: ActionCtx, rc: RecordClient, orgId: Id<"organizations">, object: "account" | "contact", crmIds: readonly string[]): Promise<Map<string, { id: string; accountId?: string; values: Record<string, unknown> }>> {
  const refs = crmIds.length ? await ctx.runQuery(internal.hubspotImport.partyRefs, { orgId, object, crmIds: [...new Set(crmIds)] }) : [];
  const byStream = new Map(refs.flatMap((r) => (r.streamId ? [[r.streamId, r.crmId] as const] : [])));
  const out = new Map<string, { id: string; accountId?: string; values: Record<string, unknown> }>();
  const take = (rows: ReadonlyArray<{ id: string; stream: string | null; accountId?: string; values: Record<string, unknown> }>) => {
    for (const row of rows) {
      const crmId = row.stream ? byStream.get(row.stream) : undefined;
      if (crmId && !out.has(crmId)) out.set(crmId, { id: row.id, ...(row.accountId ? { accountId: row.accountId } : {}), values: row.values });
    }
  };
  const keys = [...new Set(refs.flatMap((r) => (r.streamId && r.key ? [r.key] : [])))];
  const byKey = await mapLimit(chunk(keys, 100), 4, (batch) => rc.listRegister(orgId, object, { filter: [{ field: object === "account" ? "domain" : "email", op: "in", value: batch }], limit: 200 }));
  for (const page of byKey) take(page.rows);
  const prefix = object === "account" ? "acc_s_" : "con_s_";
  const rest = refs.filter((r) => r.streamId && !out.has(r.crmId)).map((r) => `${prefix}${sha20(r.streamId!)}`);
  const byId = await mapLimit(chunk(rest, 100), 4, (batch) => rc.listRegister(orgId, object, { filter: [{ field: "id", op: "in", value: batch }], limit: batch.length }));
  for (const page of byId) take(page.rows);
  return out;
}

/** A records page's properties: the mirror's, the custom fields' when the run imports them, and the history it imports. */
function pageExtras(run: Run, object: PartyOrDeal, properties: string[]) {
  const custom = run.objects.includes("custom") ? (run.customFields ?? []).filter((f) => f.object === object).map((f) => f.property) : [];
  const history = run.objects.includes("history") ? Object.keys(HISTORY_FIELDS[CUSTOM_OBJECTS[object]]) : [];
  return { properties: [...new Set([...properties, ...custom])], ...(history.length ? { history } : {}) };
}

const customOf = (run: Run, object: PartyOrDeal, props: Record<string, string | null | undefined>) =>
  run.objects.includes("custom") ? customValues(object, (run.customFields ?? []) as CustomField[], props) : {};

const withExtra = <T extends object>(row: T, extra: Record<string, unknown>) => (Object.keys(extra).length ? { ...row, extra } : row);

const progress = (results: Result[], more: Partial<Progress> = {}): Progress => ({ results, failures: [], notices: [], ...more });

/** A records page's property history as dated facts on each record's stream (written after the records, so each has one). */
async function writeHistory(sc: StepCtx, object: "companies" | "contacts" | "deals", records: ReadonlyArray<{ id: string; propertiesWithHistory?: Record<string, Array<{ value: string; timestamp: string }>> }>): Promise<Result[]> {
  const { ctx, run } = sc;
  if (!run.objects.includes("history")) return [];
  const ownerMap = ownerMapOf(run);
  const canonObject = ({ companies: "account", contacts: "contact", deals: "deal" } as const)[object];
  // A deal's owner field holds the HubSpot owner id itself, as the mirror stores it; a company's or person's holds the Canon user.
  const ownerOf = (id: string) => (object === "deals" ? id : ownerMap[id]);
  const facts = records.flatMap((r) => historyFacts(object, r.id, r.propertiesWithHistory, ownerOf).map((f) => ({ ...f, object: canonObject, crmId: r.id })));
  let written = 0;
  let failed = 0;
  await writeInBatches(facts, {
    size: HISTORY_BATCH, concurrency: WRITE_CONCURRENCY, keyOf: (f) => f.crmId,
    submit: async (rows) => {
      const out = await sc.write(() => ctx.runMutation(internal.hubspotImport.writeHistory, { orgId: run.orgId, rows }));
      written += out.written;
      failed += out.missing.length;
    },
  });
  return [{ object: "field history", read: facts.length, written, failed }];
}

const ownersRunner = (sc: StepCtx): PhaseRunner<HsOwner[]> => ({
  read: async () => ({ page: await sc.client.owners(), after: null }),
  async write(owners) {
    const { ctx, run } = sc;
    // As the scheduled sync does: active owners with an email map to a user of that email, made if there is none.
    const active = owners.filter((o) => !o.archived && o.email);
    const emails = [...new Set(active.map((o) => o.email!.trim().toLowerCase()))];
    const members = new Map((await ctx.runQuery(internal.hubspotImport.usersByEmail, { orgId: run.orgId, emails })).map((u) => [u.email, u]));
    const ownerMap: Record<string, string> = {};
    for (const batch of chunk(active.map((o) => ({ crmOwnerId: String(o.id), email: o.email!, name: [o.firstName, o.lastName].filter(Boolean).join(" ") || o.email! })), 400)) {
      Object.assign(ownerMap, (await sc.write(() => ctx.runMutation(internal.hubspot.upsertOwners, { orgId: run.orgId, owners: batch }))).ownerMap);
    }
    const matched = matchOwners(owners, members, ownerMap);
    return progress([{ object: "owners", read: owners.length, written: matched.filter((o) => o.member).length, failed: 0 }], { owners: matched });
  },
});

const pipelinesRunner = (sc: StepCtx): PhaseRunner<HsPipeline[]> => ({
  read: async () => ({ page: await sc.pipelines(), after: null }),
  async write(pipelines) {
    const res = await sc.write(() => sc.ctx.runMutation(internal.hubspotImport.writePipelines, {
      orgId: sc.run.orgId,
      pipelines: pipelines.map((p) => ({
        id: String(p.id), label: p.label, displayOrder: p.displayOrder, archived: p.archived,
        stages: p.stages.map((s) => ({ id: String(s.id), label: s.label, displayOrder: s.displayOrder, archived: s.archived, metadata: { probability: s.metadata?.probability, isClosed: s.metadata?.isClosed } })),
      })),
    }));
    return progress([{ object: "pipelines", read: pipelines.length, written: res.pipelines, failed: 0 }]);
  },
});

/** The portal's custom properties of companies, people and deals, as Canon custom fields (made or reused), saved on the run. */
const propertiesRunner = (sc: StepCtx): PhaseRunner<Array<ReturnType<typeof customSpecs>[number]>> => ({
  async read() {
    const objects = (["account", "contact", "deal"] as const).filter((o) => sc.run.objects.includes(CUSTOM_OBJECTS[o]));
    return { page: (await Promise.all(objects.map(async (o) => customSpecs(o, await sc.client.properties(CUSTOM_OBJECTS[o]))))).flat(), after: null };
  },
  async write(specs) {
    const out = await sc.write(() => sc.ctx.runMutation(internal.hubspotImport.ensureCustomFields, { orgId: sc.run.orgId, specs }));
    return progress([{ object: "custom fields", read: specs.length, written: out.fields.length, failed: out.refused.length }], {
      customFields: out.fields, failures: out.refused.map((r) => ({ object: "custom fields", id: r.property, message: r.message })),
    });
  },
});

const accountMapOf = async (sc: StepCtx, crmIds: Array<string | undefined>) => {
  const ids = [...new Set(crmIds.filter((x): x is string => Boolean(x)))];
  const rows = ids.length ? await sc.ctx.runQuery(internal.hubspotImport.accountRows, { orgId: sc.run.orgId, crmIds: ids }) : [];
  return Object.fromEntries(rows.map((r) => [r.crmId, r.id]));
};

const companiesRunner = (sc: StepCtx): PhaseRunner<HsRecord[]> => ({
  read: async (after) => {
    const page = await sc.client.page("companies", { after, ...pageExtras(sc.run, "account", hubspotProperties("accounts", sc.mappings).split(",")) });
    return { page: page.results, after: page.after };
  },
  async write(records) {
    const { ctx, run } = sc;
    const accounts = records.map((r) => hubspotAccount(r, sc.mappings));
    const rows = accounts.map((a, i) => withExtra(mirrorAccount(a, ownerMapOf(run)), customOf(run, "account", records[i].properties)));
    await writeInBatches(rows, {
      size: PARTY_BATCH, concurrency: WRITE_CONCURRENCY,
      submit: async (left) => {
        const out = await sc.write(() => ctx.runMutation(internal.hubspot.upsertAccounts, { orgId: run.orgId, accounts: left }));
        return left.filter((r) => out.unprocessed.includes(r.crmId));
      },
    });
    const history = await writeHistory(sc, "companies", records);
    return progress([{ object: "companies", read: rows.length, written: rows.length, failed: 0 }, ...history], { ownerRecords: unmatchedRecords(run, accounts.map((a) => a.ownerId)) });
  },
});

const contactsRunner = (sc: StepCtx): PhaseRunner<HsRecord[]> => ({
  read: async (after) => {
    const page = await sc.client.page("contacts", { after, associations: ["companies"], ...pageExtras(sc.run, "contact", [...hubspotProperties("contacts", sc.mappings).split(","), ...CONTACT_IMPORT_PROPERTIES]) });
    return { page: page.results, after: page.after };
  },
  async write(records) {
    const { ctx, run } = sc;
    const contacts = records.map((r) => hubspotContact(r, sc.mappings));
    const accountMap = await accountMapOf(sc, contacts.map((c) => c.accountId));
    const ownerMap = ownerMapOf(run);
    const unmapped = new Map<string, number>();
    const rows = contacts.map((c, i) => {
      const extras = contactExtras(records[i].properties);
      for (const u of extras.unmapped) unmapped.set(u, (unmapped.get(u) ?? 0) + 1);
      // A person with no other emails or phones in HubSpot keeps any Canon has: an import adds them, never clears them.
      const { additionalEmails, additionalPhones, ...rest } = extras.values;
      const lists = { ...(additionalEmails ? { additionalEmails } : {}), ...(additionalPhones ? { additionalPhones } : {}) };
      return { ...mirrorContact(c, ownerMap, accountMap), extra: { ...rest, ...lists, ...customOf(run, "contact", records[i].properties) } };
    });
    await writeInBatches(rows, {
      size: PARTY_BATCH, concurrency: WRITE_CONCURRENCY,
      submit: async (left) => {
        const out = await sc.write(() => ctx.runMutation(internal.hubspot.upsertContacts, { orgId: run.orgId, contacts: left }));
        return left.filter((r) => out.unprocessed.includes(r.crmId));
      },
    });
    return progress([{ object: "contacts", read: rows.length, written: rows.length, failed: 0 }, ...(await writeHistory(sc, "contacts", records))], {
      ownerRecords: unmatchedRecords(run, contacts.map((c) => c.ownerId)),
      notices: [...unmapped.keys()].map((u) => ({ object: "contacts", message: `HubSpot's ${u} has no Canon value; people with it keep no lead status` })),
    });
  },
});

const dealsRunner = (sc: StepCtx): PhaseRunner<HsRecord[]> => ({
  read: async (after) => {
    const page = await sc.client.page("deals", { after, associations: ["companies"], ...pageExtras(sc.run, "deal", [...hubspotProperties("deals", sc.mappings).split(","), "pipeline"]) });
    return { page: page.results, after: page.after };
  },
  async write(records) {
    const { ctx, run } = sc;
    const stageClose = hubspotStageClose(await sc.pipelines());
    const deals = records.map((r) => hubspotDeal(r, sc.mappings, stageClose));
    const accountMap = await accountMapOf(sc, deals.map((d) => d.accountId));
    const today = new Date().toISOString().split("T")[0];
    const rows = deals.map((d, i) => withExtra(mirrorDeal(d, ownerMapOf(run), accountMap, today), customOf(run, "deal", records[i].properties) as Record<string, string | number | boolean | null>));
    const tally = { written: 0, failed: 0 };
    await writeInBatches(rows, {
      size: DEAL_BATCH, concurrency: WRITE_CONCURRENCY,
      submit: async (batch) => {
        const out = await sc.write(() => ctx.runMutation(internal.hubspot.upsertDeals, { orgId: run.orgId, deals: batch }));
        tally.written += out.created + out.updated;
        tally.failed += out.skipped;
      },
    });
    return progress([{ object: "deals", read: rows.length, ...tally }, ...(await writeHistory(sc, "deals", records))], { ownerRecords: unmatchedRecords(run, deals.map((d) => d.ownerId)) });
  },
});

type Link = FunctionArgs<typeof internal.hubspotImport.writeLinks>["links"][number];

/** A link phase's write: its edges in batches, and a failure for each record whose edges were refused or whose records are missing. */
async function writeLinkPage(sc: StepCtx, object: string, links: Link[], failures: Failure[]): Promise<Progress> {
  let written = 0;
  const miss = (id: string, message: string) => failures.push({ object, id, message });
  await writeInBatches(links, {
    size: LINK_BATCH, concurrency: WRITE_CONCURRENCY,
    submit: async (batch) => {
      const out = await sc.write(() => sc.ctx.runMutation(internal.hubspotImport.writeLinks, { orgId: sc.run.orgId, userId: sc.run.startedBy, links: batch }));
      written += out.applied;
      for (const f of out.failed) miss(f.ref, f.message);
    },
  });
  return { results: [{ object, read: links.length, written, failed: failures.length }], failures, notices: [] };
}

const parentsRunner = (sc: StepCtx): PhaseRunner<HsRecord[]> => ({
  read: async (after) => {
    const page = await sc.client.page("companies", { after, properties: hubspotProperties("accounts", sc.mappings).split(",") });
    return { page: page.results, after: page.after };
  },
  async write(records) {
    const object = PHASE_RESULT.parents!;
    const failures: Failure[] = [];
    const links: Link[] = [];
    const pairs = records.map((r) => hubspotAccount(r, sc.mappings)).flatMap((a) => (a.parentAccountId ? [{ child: a.crmId!, parent: a.parentAccountId }] : []));
    const ids = await registerIds(sc.ctx, sc.rc, sc.run.orgId, "account", pairs.flatMap((p) => [p.child, p.parent]));
    for (const p of pairs) {
      const [child, parent] = [ids.get(p.child), ids.get(p.parent)];
      if (child && parent) links.push({ kind: "parent", ref: p.child, accountId: child.id, parentId: parent.id });
      else failures.push({ object, id: p.child, message: `HubSpot company ${child ? p.parent : p.child} is not in Canon` });
    }
    return writeLinkPage(sc, object, links, failures);
  },
});

const contactCompaniesRunner = (sc: StepCtx): PhaseRunner<Map<string, HsAssociation[]>> => ({
  read: async (after) => {
    const page = await sc.client.page("contacts", { after, properties: ["email"] });
    return { page: await sc.client.associations("contacts", "companies", page.results.map((r) => r.id)), after: page.after };
  },
  async write(assocs) {
    const object = PHASE_RESULT.contactCompanies!;
    const failures: Failure[] = [];
    const links: Link[] = [];
    const miss = (id: string, message: string) => failures.push({ object, id, message });
    const plans = [...assocs].map(([contact, a]) => ({ contact, ...companiesOf(a) })).filter((p) => p.companies.length);
    const [people, companies] = await Promise.all([
      registerIds(sc.ctx, sc.rc, sc.run.orgId, "contact", plans.map((p) => p.contact)),
      registerIds(sc.ctx, sc.rc, sc.run.orgId, "account", plans.flatMap((p) => p.companies)),
    ]);
    for (const p of plans) {
      const person = people.get(p.contact);
      const companyIds = p.companies.flatMap((c) => (companies.has(c) ? [companies.get(c)!.id] : []));
      if (!person) miss(p.contact, "This person is not in Canon");
      else if (companyIds.length) links.push({ kind: "companies", ref: p.contact, contactId: person.id, ...(person.accountId ? { seed: person.accountId } : {}), companyIds });
      if (person && companyIds.length < p.companies.length) miss(p.contact, `${p.companies.length - companyIds.length} of this person's HubSpot companies are not in Canon`);
    }
    return writeLinkPage(sc, object, links, failures);
  },
});

const dealContactsRunner = (sc: StepCtx): PhaseRunner<Map<string, HsAssociation[]>> => ({
  read: async (after) => {
    const page = await sc.client.page("deals", { after, properties: ["dealname"] });
    return { page: await sc.client.associations("deals", "contacts", page.results.map((r) => r.id)), after: page.after };
  },
  async write(assocs) {
    const object = PHASE_RESULT.dealContacts!;
    const failures: Failure[] = [];
    const links: Link[] = [];
    const miss = (id: string, message: string) => failures.push({ object, id, message });
    const [dealRows, people] = await Promise.all([
      sc.ctx.runQuery(internal.hubspotImport.dealRefs, { orgId: sc.run.orgId, crmIds: [...assocs.keys()] }),
      registerIds(sc.ctx, sc.rc, sc.run.orgId, "contact", [...assocs.values()].flatMap((a) => a.map((x) => x.toObjectId))),
    ]);
    const deals = new Map(dealRows.map((d) => [d.crmId, d.deal]));
    for (const [dealId, a] of assocs) {
      const streamId = deals.get(dealId)?.streamId;
      if (!streamId) {
        miss(dealId, "This deal is not in Canon");
        continue;
      }
      const members = a.flatMap((x) => (people.has(x.toObjectId) ? [{ contactId: people.get(x.toObjectId)!.id, role: dealRoleOf(x) }] : []));
      if (members.length < a.length) miss(dealId, `${a.length - members.length} of this deal's HubSpot people are not in Canon`);
      if (members.length) links.push({ kind: "people", ref: dealId, streamId, members });
    }
    return writeLinkPage(sc, object, links, failures);
  },
});

type EngagementPage = {
  records: HsRecord[];
  assocs: Record<"companies" | "contacts" | "deals", Map<string, HsAssociation[]>>;
  files: Map<string, { name: string; url: string | null }>;
  notices: Notice[];
};

/** Engagements' companies, people and deals in HubSpot, by engagement id. */
async function engagementAssocs(client: HubspotImportClient, object: Engagement, ids: readonly string[]): Promise<EngagementPage["assocs"]> {
  const [companies, contacts, deals] = await Promise.all((["companies", "contacts", "deals"] as const).map((to) => client.associations(object, to, ids)));
  return { companies, contacts, deals };
}

/** Each engagement's companies, people and deals in Canon: register ids for companies and people, stream ids for deals. */
async function engagementTargets(ctx: ActionCtx, rc: RecordClient, orgId: Id<"organizations">, ids: readonly string[], assocs: EngagementPage["assocs"]) {
  const { companies, contacts: people, deals } = assocs;
  const all = (m: Map<string, Array<{ toObjectId: string }>>) => [...m.values()].flatMap((a) => a.map((x) => x.toObjectId));
  const [companyIds, personIds, dealRows] = await Promise.all([
    registerIds(ctx, rc, orgId, "account", all(companies)),
    registerIds(ctx, rc, orgId, "contact", all(people)),
    ctx.runQuery(internal.hubspotImport.dealRefs, { orgId, crmIds: [...new Set(all(deals))] }),
  ]);
  const dealStreams = new Map(dealRows.flatMap((d) => (d.deal?.streamId ? [[d.crmId, d.deal.streamId as string] as const] : [])));
  return new Map(ids.map((id) => {
    const pick = (m: Map<string, Array<{ toObjectId: string }>>, resolve: (crmId: string) => string | undefined) => (m.get(id) ?? []).flatMap((x) => resolve(x.toObjectId) ?? []);
    return [id, {
      companies: pick(companies, (c) => companyIds.get(c)?.id),
      people: pick(people, (c) => personIds.get(c)?.id),
      deals: pick(deals, (c) => dealStreams.get(c)),
      missing: (companies.get(id)?.length ?? 0) + (people.get(id)?.length ?? 0) + (deals.get(id)?.length ?? 0),
    }] as const;
  }));
}

/** One page of calls, meetings, notes, tasks or emails, as activities (or logged emails) on the timelines of the records they are about. */
const engagementsRunner = (sc: StepCtx, object: Engagement): PhaseRunner<EngagementPage> => ({
  async read(after) {
    const page = await sc.client.page(object, { after, properties: ENGAGEMENT_PROPERTIES[object] });
    const ids = page.results.map((r) => r.id);
    const notices: Notice[] = [];
    const fileIds = object === "notes" ? [...new Set(page.results.flatMap((r) => attachmentIds(r.properties)))] : [];
    const readFiles = async () => {
      if (!fileIds.length) return new Map<string, { name: string; url: string | null }>();
      try {
        return await sc.client.files(fileIds);
      } catch (error) {
        if (!(error instanceof HubspotScopeError)) throw error;
        notices.push({ object, message: "The HubSpot connection cannot read files, so notes list their attachments by HubSpot file id. Reconnect HubSpot with the files scope for names and links." });
        return new Map<string, { name: string; url: string | null }>();
      }
    };
    const [assocs, files] = await Promise.all([engagementAssocs(sc.client, object, ids), readFiles()]);
    return { page: { records: page.results, assocs, files, notices }, after: page.after };
  },
  async write(page) {
    const { ctx, run } = sc;
    const targets = await engagementTargets(ctx, sc.rc, run.orgId, page.records.map((r) => r.id), page.assocs);
    const ownerMap = ownerMapOf(run);
    const failures: Failure[] = [];
    const mapped = page.records.map((r) => ({ id: r.id, m: engagementOf(object, r, attachmentText(attachmentIds(r.properties), page.files) ?? ""), t: targets.get(r.id)! }));
    let written = 0;
    if (object === "emails") {
      const rows = mapped.flatMap(({ id, m, t }) => {
        if (m.kind !== "email") return [];
        if (!t.people.length) {
          failures.push({ object, id, message: "This email has no person in Canon to log it on" });
          return [];
        }
        const userId = m.ownerCrmId ? ownerMap[m.ownerCrmId] : undefined;
        return [{ hubspotId: id, contactIds: t.people, occurredAt: m.email.at, direction: m.email.direction, from: m.email.from, to: m.email.to, subject: m.email.subject, body: m.email.body, ...(userId ? { userId } : {}) }];
      });
      await writeInBatches(rows, {
        size: LINK_BATCH, concurrency: WRITE_CONCURRENCY,
        submit: async (batch) => {
          written += (await sc.write(() => ctx.runMutation(internal.hubspotImport.writeEmails, { orgId: run.orgId, rows: batch }))).logged;
        },
      });
    } else {
      const rows = mapped.flatMap(({ id, m, t }) => {
        if (m.kind !== "activity") return [];
        const ownerId = m.ownerCrmId ? ownerMap[m.ownerCrmId] : undefined;
        const links = { ...(t.companies[0] ? { accountId: t.companies[0] } : {}), ...(t.people[0] ? { contactId: t.people[0] } : {}), ...(t.deals[0] ? { dealId: t.deals[0] } : {}) };
        const all = [...t.companies, ...t.people, ...t.deals];
        if (all.length < t.missing) failures.push({ object, id, message: `${t.missing - all.length} of the records it is about are not in Canon` });
        return [{ hubspotId: id, object: m.object, createdAt: m.createdAt, targets: all, values: { ...m.values, ...links, ...(ownerId ? { ownerId } : {}) } }];
      });
      await writeInBatches(rows, {
        size: LINK_BATCH, concurrency: WRITE_CONCURRENCY,
        submit: async (batch) => {
          const out = await sc.write(() => ctx.runMutation(internal.hubspotImport.writeActivities, { orgId: run.orgId, userId: run.startedBy, rows: batch }));
          written += out.created + out.updated;
          for (const f of out.failed) failures.push({ object, id: f.ref, message: f.message });
        },
      });
    }
    return {
      results: [{ object, read: page.records.length, written, failed: failures.length }], failures, notices: page.notices,
      ownerRecords: unmatchedRecords(run, page.records.map((r) => r.properties.hubspot_owner_id ?? undefined)),
    };
  },
});

function runnerFor(sc: StepCtx, phase: Phase): PhaseRunner {
  if (phase === "owners") return ownersRunner(sc);
  if (phase === "pipelines") return pipelinesRunner(sc);
  if (phase === "properties") return propertiesRunner(sc);
  if (phase === "companies") return companiesRunner(sc);
  if (phase === "contacts") return contactsRunner(sc);
  if (phase === "deals") return dealsRunner(sc);
  if (phase === "parents") return parentsRunner(sc);
  if (phase === "contactCompanies") return contactCompaniesRunner(sc);
  if (phase === "dealContacts") return dealContactsRunner(sc);
  if ((ENGAGEMENTS as readonly string[]).includes(phase)) return engagementsRunner(sc, phase as Engagement);
  throw new Error(`The import has no step for ${phase}`);
}

/** The message a run shows when a step stops it; never a token or a HubSpot response body. */
const stopMessage = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

/** A phase the token cannot read is skipped, saying so; the run carries on. */
const scopeNotice = (phase: Phase, error: HubspotScopeError): Notice => ({
  object: PHASE_RESULT[phase] ?? phase,
  message: `Skipped: the HubSpot connection cannot read ${error.object}. Reconnect HubSpot with the ${error.object === "emails" ? "sales-email-read" : `${error.object} read`} scope, then run the import again.`,
});

type LaneOut = { progress: Progress[]; cursor: string | null; done: boolean; error?: unknown };

/**
 * Run one phase from `cursor` until it finishes or the step's time is up: each page's read starts while the page
 * before it is still being written. Stops at the first error, keeping the cursor of the last page it wrote.
 */
async function runLane(sc: StepCtx, phase: Phase, cursor: string | null, deadline: number): Promise<LaneOut> {
  const runner = runnerFor(sc, phase);
  const out: LaneOut = { progress: [], cursor, done: false };
  const fail = (error: unknown): LaneOut => (error instanceof HubspotScopeError ? { ...out, done: true, cursor: null, progress: [...out.progress, progress([], { notices: [scopeNotice(phase, error)] })] } : { ...out, error });
  const reading = (c: string | null) => {
    const p = runner.read(c);
    p.catch(() => undefined); // read ahead: a page nobody awaits (the step ended) must not reject unhandled
    return p;
  };
  let next = reading(cursor);
  for (;;) {
    let got: Awaited<ReturnType<PhaseRunner["read"]>>;
    try {
      got = await next;
    } catch (error) {
      return fail(error);
    }
    const more = got.after !== null && Date.now() < deadline;
    if (more) next = reading(got.after);
    try {
      out.progress.push(await runner.write(got.page));
    } catch (error) {
      return fail(error);
    }
    out.cursor = got.after;
    if (got.after === null) return { ...out, done: true };
    if (!more) return out;
  }
}

/** One step's progress, summed for `advance`: owner record counts added up per owner, notices once, failures capped. */
function sumProgress(all: Progress[]) {
  const ownerRecords = new Map<string, number>();
  const notices: Notice[] = [];
  const failures: Failure[] = [];
  for (const p of all) {
    for (const r of p.ownerRecords ?? []) ownerRecords.set(r.crmOwnerId, (ownerRecords.get(r.crmOwnerId) ?? 0) + r.records);
    for (const n of p.notices) if (!notices.some((x) => x.object === n.object && x.message === n.message)) notices.push(n);
    for (const f of p.failures) if (failures.length < STEP_FAILURES_MAX) failures.push(f);
  }
  return { results: all.flatMap((p) => p.results), failures, notices, ownerRecords: [...ownerRecords].map(([crmOwnerId, records]) => ({ crmOwnerId, records })) };
}

/**
 * One step of an import: read and write pages for STEP_MS, crossing into later phases as each finishes, then record
 * what was done and where the run is (`advance`, which schedules the next step). At a parallel stage (lib/hubspotImport.ts
 * PARALLEL_STAGES) every lane runs at once from its own cursor. Writes from every lane share one limiter.
 */
export const step = internalAction({
  args: { runId: v.id("crmImports"), lease: v.number() },
  handler: async (ctx, a) => {
    const stored = await ctx.runQuery(internal.hubspotImport.runOf, { runId: a.runId });
    if (!stored || stored.status !== "running" || stored.lease !== a.lease) return;
    const run: Run = { ...stored };
    const objects = run.objects as ImportObject[];
    const deadline = Date.now() + STEP_MS;
    const done: Progress[] = [];
    let error: string | undefined;
    let ownersChanged = false;
    try {
      const { client, mappings } = await importClient(ctx, run.orgId);
      let pipelines: Promise<HsPipeline[]> | undefined;
      const sc: StepCtx = {
        ctx, run, client, mappings, rc: clientFor(ctx), write: concurrencyLimit(WRITE_CONCURRENCY),
        pipelines: () => (pipelines ??= client.dealPipelines()),
      };
      const absorb = (lane: LaneOut) => {
        done.push(...lane.progress);
        for (const p of lane.progress) {
          if (p.owners) {
            run.owners = p.owners;
            ownersChanged = true;
          }
          if (p.customFields) run.customFields = p.customFields;
        }
        if (lane.error !== undefined && error === undefined) error = stopMessage(lane.error);
      };
      while (run.phase !== "done" && Date.now() < deadline && error === undefined) {
        const phase = run.phase as Phase;
        const stage = stageOf(phase);
        if (!stage) {
          const lane = await runLane(sc, phase, run.cursor, deadline);
          absorb(lane);
          if (lane.done) [run.phase, run.cursor] = [nextPhase(phase, objects), null];
          else run.cursor = lane.cursor;
          continue;
        }
        // The links and the engagements look up records earlier phases wrote, so the register must have projected them.
        await settle(ctx, sc.rc, run.orgId);
        const lanes = lanesFor(run, stage);
        const outs = await Promise.all(lanes.map((l) => (l.done ? null : runLane(sc, l.phase as Phase, l.cursor, deadline))));
        outs.forEach((lane, i) => {
          if (!lane) return;
          absorb(lane);
          Object.assign(lanes[i], { cursor: lane.cursor, done: lane.done });
        });
        const open = lanes.filter((l) => !l.done);
        if (open.length) Object.assign(run, { lanes, phase: open[0].phase, cursor: open[0].cursor });
        else Object.assign(run, { lanes: undefined, phase: nextPhase(stage[stage.length - 1], objects), cursor: null });
      }
    } catch (e) {
      error ??= stopMessage(e);
    }
    const sum = sumProgress(done);
    await ctx.runMutation(internal.hubspotImport.advance, {
      runId: run._id, lease: a.lease, phase: run.phase, cursor: run.cursor, ...(run.lanes ? { lanes: run.lanes } : {}),
      ...sum, ...(ownersChanged ? { owners: run.owners } : {}), ...(run.customFields !== stored.customFields ? { customFields: run.customFields } : {}),
      ...(error !== undefined ? { error } : {}),
    });
  },
});

/** How many records the portal holds of each object, read from the first pages' totals (HubSpot's search total). */
export const portalCounts = action({
  args: {},
  handler: async (ctx): Promise<Record<string, number | null>> => {
    const who = await ctx.runQuery(internal.hubspotImport.importer, {});
    const { client } = await importClient(ctx, who.orgId);
    const objects: HsRecordObject[] = ["companies", "contacts", "deals"];
    const counts = await Promise.all(objects.map((o) => client.count(o).catch(() => null)));
    return Object.fromEntries(objects.map((o, i) => [o, counts[i]]));
  },
});

const asText = (v: unknown): SpotValue => (v === undefined || v === null || v === "" ? null : typeof v === "number" || typeof v === "boolean" ? v : String(v));

/**
 * Sample 50 records of each object from the portal (a fixed sample per run, from its first SPOT_POOL records) and
 * compare them field by field with what Canon holds: each value as the import maps it, against the register row
 * (companies, people) or the deals row, with each person's primary company and each deal's people and roles.
 */
export const spotCheck = action({
  args: { runId: v.id("crmImports") },
  handler: async (ctx, a): Promise<null> => {
    const who = await ctx.runQuery(internal.hubspotImport.importer, {});
    await ctx.runQuery(internal.permissions.requireUnrestrictedCaller, { what: "the import spot check" });
    const run = await ctx.runQuery(internal.hubspotImport.runOf, { runId: a.runId });
    if (!run || run.orgId !== who.orgId) throw new ConvexError("Import not found");
    const { client, mappings } = await importClient(ctx, run.orgId);
    const rc = clientFor(ctx);
    await settle(ctx, rc, run.orgId);
    const seed = [...String(run._id)].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);
    const pool = async (object: HsObject, properties: string[], associations?: HsRecordObject[]) => {
      const out = [];
      let after: string | null = null;
      do {
        const page = await client.page(object, { after, properties, ...(associations ? { associations } : {}) });
        out.push(...page.results);
        after = page.after;
      } while (after && out.length < SPOT_POOL);
      return sampleOf(out, SPOT_SAMPLE, seed);
    };
    const ownerMap = ownerMapOf(run);
    const owner = (id: string | undefined) => (id ? ownerMap[id] ?? null : null);
    const results: Array<{ object: string; sampled: number; fields: number; mismatches: Mismatch[] }> = [];
    const check = (object: string, rows: Array<{ id: string; name: string; expected: Record<string, SpotValue | string[]>; actual: Record<string, SpotValue | string[] | undefined> | null }>) => {
      results.push({ object, sampled: rows.length, fields: rows.reduce((n, r) => n + Object.keys(r.expected).length, 0), mismatches: rows.flatMap((r) => compareRecord(r.id, r.name, r.expected, r.actual)) });
    };

    // Each object's custom field values, as the import maps them and as Canon holds them.
    const customExpected = (object: PartyOrDeal, props: Record<string, string | null | undefined>) => customOf(run, object, props) as Record<string, SpotValue | string[]>;
    const customActual = (object: PartyOrDeal, values: Record<string, unknown>) => Object.fromEntries(
      (run.objects.includes("custom") ? (run.customFields ?? []).filter((f) => f.object === object) : []).map((f) => [f.apiName, Array.isArray(values[f.apiName]) ? values[f.apiName] as string[] : asText(values[f.apiName])]),
    );
    const companyPages = await pool("companies", pageExtras(run, "account", hubspotProperties("accounts", mappings).split(",")).properties);
    const companies = companyPages.map((r) => hubspotAccount(r, mappings));
    const companyIds = await registerIds(ctx, rc, run.orgId, "account", companies.flatMap((c) => [c.crmId!, ...(c.parentAccountId ? [c.parentAccountId] : [])]));
    check("companies", companies.map((c, i) => {
      const row = companyIds.get(c.crmId!);
      const m = mirrorAccount(c, ownerMap);
      return {
        id: c.crmId!, name: c.name,
        expected: { name: m.name, domain: m.domain?.toLowerCase() ?? null, industry: m.industry ?? null, employees: m.employeeCount ?? null, ownerId: owner(c.ownerId), ...customExpected("account", companyPages[i].properties) },
        actual: row ? { name: asText(row.values.name), domain: asText(row.values.domain), industry: asText(row.values.industry), employees: asText(row.values.employees), ownerId: asText(row.values.ownerId), ...customActual("account", row.values) } : null,
      };
    }));

    const contactPages = await pool("contacts", pageExtras(run, "contact", [...hubspotProperties("contacts", mappings).split(","), ...CONTACT_IMPORT_PROPERTIES]).properties, ["companies"]);
    const contacts = contactPages.map((r) => hubspotContact(r, mappings));
    const [people, primaries] = await Promise.all([
      registerIds(ctx, rc, run.orgId, "contact", contacts.map((c) => c.crmId!)),
      registerIds(ctx, rc, run.orgId, "account", contacts.flatMap((c) => (c.accountId ? [c.accountId] : []))),
    ]);
    check("contacts", contacts.map((c, i) => {
      const row = people.get(c.crmId!);
      const extras = contactExtras(contactPages[i].properties).values;
      const fullName = [c.firstName, c.lastName].filter(Boolean).join(" ") || null;
      return {
        id: c.crmId!, name: fullName ?? c.email ?? c.crmId!,
        expected: {
          fullName, email: c.email?.toLowerCase() ?? null, title: c.title ?? null, phone: c.phone ?? null, ownerId: owner(c.ownerId),
          lifecycleStage: extras.lifecycleStage, leadStatus: extras.leadStatus, additionalEmails: extras.additionalEmails?.map((e) => e.toLowerCase()).join("; ") ?? null, company: c.accountId ? primaries.get(c.accountId)?.id ?? `HubSpot ${c.accountId}` : null,
          ...customExpected("contact", contactPages[i].properties),
        },
        actual: row ? {
          fullName: asText(row.values.fullName), email: asText(row.values.email), title: asText(row.values.title), phone: asText(row.values.phone), ownerId: asText(row.values.ownerId),
          lifecycleStage: asText(row.values.lifecycleStage), leadStatus: asText(row.values.leadStatus),
          additionalEmails: Array.isArray(row.values.additionalEmails) && row.values.additionalEmails.length ? row.values.additionalEmails.join("; ") : null, company: row.accountId ?? null,
          ...customActual("contact", row.values),
        } : null,
      };
    }));

    const stageClose = hubspotStageClose(await client.dealPipelines());
    const dealPages = await pool("deals", pageExtras(run, "deal", [...hubspotProperties("deals", mappings).split(","), "pipeline"]).properties, ["companies"]);
    const deals = dealPages.map((r) => hubspotDeal(r, mappings, stageClose));
    const [stored, dealPeople] = await Promise.all([
      ctx.runQuery(internal.hubspotImport.dealRefs, { orgId: run.orgId, crmIds: deals.map((d) => d.crmId!) }),
      client.associations("deals", "contacts", deals.map((d) => d.crmId!)),
    ]);
    const peopleIds = await registerIds(ctx, rc, run.orgId, "contact", [...dealPeople.values()].flatMap((x) => x.map((y) => y.toObjectId)));
    const byCrm = new Map(stored.map((d) => [d.crmId, d.deal]));
    const today = new Date().toISOString().split("T")[0];
    check("deals", deals.map((d) => {
      const m = mirrorDeal(d, ownerMap, {}, today);
      const row = byCrm.get(d.crmId!);
      const expectedPeople = (dealPeople.get(d.crmId!) ?? []).map((x) => `${peopleIds.get(x.toObjectId)?.id ?? `HubSpot ${x.toObjectId}`}:${dealRoleOf(x)}`);
      return {
        id: d.crmId!, name: d.name,
        expected: {
          name: m.name, amount: m.amount ?? null, stage: m.stage ?? null, closeDate: m.closeDate, ownerId: owner(d.ownerId), company: d.accountId ?? null,
          createdAt: hubspotTime((d.raw as { createdAt?: string }).createdAt) ?? null, isClosed: m.isClosed, isWon: m.isWon, people: expectedPeople,
          ...customExpected("deal", (d.raw as { properties: Record<string, string | null> }).properties),
        },
        actual: row ? { name: row.name, amount: row.amount, stage: row.stage, closeDate: row.closeDate, ownerId: row.ownerId, company: row.company, createdAt: row.createdAt, isClosed: row.isClosed, isWon: row.isWon, people: row.people, ...customActual("deal", row.custom) } : null,
      };
    }));
    if (run.objects.includes("engagements")) {
      for (const object of ENGAGEMENTS) {
        let sampled;
        try {
          sampled = await pool(object, [...ENGAGEMENT_PROPERTIES[object]]);
        } catch (error) {
          if (error instanceof HubspotScopeError) continue;
          throw error;
        }
        const ids = sampled.map((r) => r.id);
        const targets = await engagementTargets(ctx, rc, run.orgId, ids, await engagementAssocs(client, object, ids));
        const canonObject = object === "emails" ? "email" : ({ calls: "call", meetings: "meeting", notes: "note", tasks: "task" } as const)[object];
        const stored = new Map((await ctx.runQuery(internal.hubspotImport.engagementRows, {
          orgId: run.orgId, object: canonObject, items: sampled.map((r) => ({ id: r.id, contactIds: targets.get(r.id)!.people })),
        })).map((x) => [x.id, x.row]));
        check(object, sampled.map((r) => {
          const t = targets.get(r.id)!;
          const m = engagementOf(object, r, attachmentText(attachmentIds(r.properties), new Map()) ?? "");
          const row = stored.get(r.id) as Record<string, unknown> | null | undefined;
          if (m.kind === "email") {
            const got = row as { subject: string; body: string; at: number | null; people: string[] } | null;
            return { id: r.id, name: m.email.subject || r.id, expected: { subject: m.email.subject, body: m.email.body, at: m.email.at, people: t.people }, actual: got ? { subject: got.subject, body: got.body, at: got.at, people: got.people } : null };
          }
          const got = row as { values: Record<string, unknown>; createdAt: number; targets: string[] } | null;
          // Attachment links come from the Files API when the token can read it; the spot check compares the text before them.
          const expected: Record<string, SpotValue | string[]> = { ...Object.fromEntries(Object.entries(m.values).filter(([k]) => !(object === "notes" && k === "body"))), ownerId: owner(m.ownerCrmId ?? undefined), targets: [...t.companies, ...t.people, ...t.deals] };
          return {
            id: r.id, name: String(m.values.subject ?? m.values.title ?? r.id), expected,
            actual: got ? { ...Object.fromEntries(Object.keys(expected).map((k) => [k, asText(got.values[k])])), targets: got.targets } : null,
          };
        }));
      }
    }
    await ctx.runMutation(internal.hubspotImport.saveSpotCheck, { runId: run._id, objects: results });
    return null;
  },
});
