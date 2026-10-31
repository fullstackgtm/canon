"use node";

/**
 * The HubSpot portal import's steps (CP12): each reads one HubSpot page for the run's phase, writes it, and hands
 * the cursor to `hubspotImport.advance`, which schedules the next step. Reads only: the client has no write call.
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
import { resubmitUnprocessed } from "./lib/canon/partyLedger";
import { mirrorAccount, mirrorContact, mirrorDeal, hubspotTime } from "./lib/hubspotMirror";
import {
  CONTACT_IMPORT_PROPERTIES, CUSTOM_OBJECTS, ENGAGEMENTS, HISTORY_FIELDS, customSpecs, customValues, historyFacts, ENGAGEMENT_PROPERTIES, PHASE_RESULT, attachmentIds, attachmentText, engagementOf, SPOT_POOL, SPOT_SAMPLE, compareRecord, companiesOf, contactExtras, dealRoleOf, matchOwners, nextPhase, sampleOf,
  type CustomField, type Engagement, type ImportObject, type PartyOrDeal, type Mismatch, type OwnerMatch, type Phase, type SpotValue,
} from "./lib/hubspotImport";
import { createHubspotImportClient, HubspotScopeError, type HsObject, type HsRecordObject, type HubspotImportClient } from "../engine/src/sync/hubspotImport/client.ts";
import { hubspotAccount, hubspotContact, hubspotDeal, hubspotProperties, hubspotStageClose } from "../engine/src/connectors/hubspot.ts";
import type { FieldMappings } from "./lib/crmMappings";
import type { RecordClient } from "./lib/recordClient";

type Run = Doc<"crmImports">;
type Result = { object: string; read: number; written: number; failed: number };
type Failure = { object: string; id: string; message: string };
type StepOut = {
  phase: Phase; cursor: string | null; results: Result[]; failures: Failure[]; notices: Array<{ object: string; message: string }>;
  owners?: OwnerMatch[]; customFields?: CustomField[]; ownerRecords?: Array<{ crmOwnerId: string; records: number }>;
};

const PARTY_BATCH = 100;
const DEAL_BATCH = 50;
const LINK_BATCH = 25;

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
  for (const batch of chunk(keys, 100)) {
    take((await rc.listRegister(orgId, object, { filter: [{ field: object === "account" ? "domain" : "email", op: "in", value: batch }], limit: 200 })).rows);
  }
  const prefix = object === "account" ? "acc_s_" : "con_s_";
  const rest = refs.filter((r) => r.streamId && !out.has(r.crmId)).map((r) => `${prefix}${sha20(r.streamId!)}`);
  for (const batch of chunk(rest, 100)) take((await rc.listRegister(orgId, object, { filter: [{ field: "id", op: "in", value: batch }], limit: batch.length })).rows);
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

/** A records page's property history as dated facts on each record's stream (written after the records, so each has one). */
async function writeHistory(ctx: ActionCtx, run: Run, object: "companies" | "contacts" | "deals", records: ReadonlyArray<{ id: string; propertiesWithHistory?: Record<string, Array<{ value: string; timestamp: string }>> }>): Promise<Result[]> {
  if (!run.objects.includes("history")) return [];
  const ownerMap = ownerMapOf(run);
  const canonObject = ({ companies: "account", contacts: "contact", deals: "deal" } as const)[object];
  // A deal's owner field holds the HubSpot owner id itself, as the mirror stores it; a company's or person's holds the Canon user.
  const ownerOf = (id: string) => (object === "deals" ? id : ownerMap[id]);
  const facts = records.flatMap((r) => historyFacts(object, r.id, r.propertiesWithHistory, ownerOf).map((f) => ({ ...f, object: canonObject, crmId: r.id })));
  let written = 0;
  let failed = 0;
  for (const batch of chunk(facts, LINK_BATCH)) {
    const out = await ctx.runMutation(internal.hubspotImport.writeHistory, { orgId: run.orgId, rows: batch });
    written += out.written;
    failed += out.missing.length;
  }
  return [{ object: "field history", read: facts.length, written, failed }];
}

async function stepOwners(ctx: ActionCtx, run: Run, client: HubspotImportClient): Promise<StepOut> {
  const owners = await client.owners();
  // As the scheduled sync does: active owners with an email map to a user of that email, made if there is none.
  const active = owners.filter((o) => !o.archived && o.email);
  const emails = [...new Set(active.map((o) => o.email!.trim().toLowerCase()))];
  const members = new Map((await ctx.runQuery(internal.hubspotImport.usersByEmail, { orgId: run.orgId, emails })).map((u) => [u.email, u]));
  const ownerMap: Record<string, string> = {};
  for (const batch of chunk(active.map((o) => ({ crmOwnerId: String(o.id), email: o.email!, name: [o.firstName, o.lastName].filter(Boolean).join(" ") || o.email! })), 400)) {
    Object.assign(ownerMap, (await ctx.runMutation(internal.hubspot.upsertOwners, { orgId: run.orgId, owners: batch })).ownerMap);
  }
  const matched = matchOwners(owners, members, ownerMap);
  return {
    phase: nextPhase("owners", run.objects as ImportObject[]), cursor: null, owners: matched,
    results: [{ object: "owners", read: owners.length, written: matched.filter((o) => o.member).length, failed: 0 }], failures: [], notices: [],
  };
}

async function stepRecords(ctx: ActionCtx, run: Run, client: HubspotImportClient, mappings: FieldMappings | undefined): Promise<StepOut> {
  const phase = run.phase as "companies" | "contacts" | "deals";
  const object = PHASE_RESULT[phase]!;
  const ownerMap = ownerMapOf(run);
  const base = { results: [] as Result[], failures: [] as Failure[], notices: [] as StepOut["notices"] };
  const accountMapOf = async (crmIds: Array<string | undefined>) => {
    const ids = [...new Set(crmIds.filter((x): x is string => Boolean(x)))];
    const rows = ids.length ? await ctx.runQuery(internal.hubspotImport.accountRows, { orgId: run.orgId, crmIds: ids }) : [];
    return Object.fromEntries(rows.map((r) => [r.crmId, r.id]));
  };
  if (phase === "companies") {
    const page = await client.page("companies", { after: run.cursor, ...pageExtras(run, "account", hubspotProperties("accounts", mappings).split(",")) });
    const accounts = page.results.map((r) => hubspotAccount(r, mappings));
    const rows = accounts.map((a, i) => withExtra(mirrorAccount(a, ownerMap), customOf(run, "account", page.results[i].properties)));
    await resubmitUnprocessed(rows, async (left) => {
      const out = await ctx.runMutation(internal.hubspot.upsertAccounts, { orgId: run.orgId, accounts: left });
      return left.filter((r) => out.unprocessed.includes(r.crmId));
    });
    const history = await writeHistory(ctx, run, "companies", page.results);
    return { ...base, phase: page.after ? phase : nextPhase(phase, run.objects as ImportObject[]), cursor: page.after, results: [{ object, read: rows.length, written: rows.length, failed: 0 }, ...history], ownerRecords: unmatchedRecords(run, accounts.map((a) => a.ownerId)) };
  }
  if (phase === "contacts") {
    const page = await client.page("contacts", { after: run.cursor, associations: ["companies"], ...pageExtras(run, "contact", [...hubspotProperties("contacts", mappings).split(","), ...CONTACT_IMPORT_PROPERTIES]) });
    const contacts = page.results.map((r) => hubspotContact(r, mappings));
    const accountMap = await accountMapOf(contacts.map((c) => c.accountId));
    const unmapped = new Map<string, number>();
    const rows = contacts.map((c, i) => {
      const extras = contactExtras(page.results[i].properties);
      for (const u of extras.unmapped) unmapped.set(u, (unmapped.get(u) ?? 0) + 1);
      // A person with no other emails or phones in HubSpot keeps any Canon has: an import adds them, never clears them.
      const { additionalEmails, additionalPhones, ...rest } = extras.values;
      const lists = { ...(additionalEmails ? { additionalEmails } : {}), ...(additionalPhones ? { additionalPhones } : {}) };
      return { ...mirrorContact(c, ownerMap, accountMap), extra: { ...rest, ...lists, ...customOf(run, "contact", page.results[i].properties) } };
    });
    for (const batch of chunk(rows, PARTY_BATCH)) {
      await resubmitUnprocessed(batch, async (left) => {
        const out = await ctx.runMutation(internal.hubspot.upsertContacts, { orgId: run.orgId, contacts: left });
        return left.filter((r) => out.unprocessed.includes(r.crmId));
      });
    }
    return {
      ...base, phase: page.after ? phase : nextPhase(phase, run.objects as ImportObject[]), cursor: page.after,
      results: [{ object, read: rows.length, written: rows.length, failed: 0 }, ...(await writeHistory(ctx, run, "contacts", page.results))], ownerRecords: unmatchedRecords(run, contacts.map((c) => c.ownerId)),
      notices: [...unmapped.keys()].map((u) => ({ object, message: `HubSpot's ${u} has no Canon value; people with it keep no lead status` })),
    };
  }
  const [page, pipelines] = await Promise.all([
    client.page("deals", { after: run.cursor, associations: ["companies"], ...pageExtras(run, "deal", [...hubspotProperties("deals", mappings).split(","), "pipeline"]) }),
    client.dealPipelines(),
  ]);
  const stageClose = hubspotStageClose(pipelines);
  const deals = page.results.map((r) => hubspotDeal(r, mappings, stageClose));
  const accountMap = await accountMapOf(deals.map((d) => d.accountId));
  const today = new Date().toISOString().split("T")[0];
  const rows = deals.map((d, i) => withExtra(mirrorDeal(d, ownerMap, accountMap, today), customOf(run, "deal", page.results[i].properties) as Record<string, string | number | boolean | null>));
  const tally = { written: 0, failed: 0 };
  for (const batch of chunk(rows, DEAL_BATCH)) {
    const out = await ctx.runMutation(internal.hubspot.upsertDeals, { orgId: run.orgId, deals: batch });
    tally.written += out.created + out.updated;
    tally.failed += out.skipped;
  }
  return {
    ...base, phase: page.after ? phase : nextPhase(phase, run.objects as ImportObject[]), cursor: page.after,
    results: [{ object, read: rows.length, ...tally }, ...(await writeHistory(ctx, run, "deals", page.results))], ownerRecords: unmatchedRecords(run, deals.map((d) => d.ownerId)),
  };
}

async function stepLinks(ctx: ActionCtx, run: Run, client: HubspotImportClient, mappings: FieldMappings | undefined): Promise<StepOut> {
  const phase = run.phase as "parents" | "contactCompanies" | "dealContacts";
  const object = PHASE_RESULT[phase]!;
  const rc = clientFor(ctx);
  await settle(ctx, rc, run.orgId);
  type Link = Parameters<typeof ctx.runMutation<typeof internal.hubspotImport.writeLinks>>[1]["links"][number];
  const links: Link[] = [];
  const failures: Failure[] = [];
  const miss = (id: string, message: string) => failures.push({ object, id, message });
  let page;
  if (phase === "parents") {
    page = await client.page("companies", { after: run.cursor, properties: hubspotProperties("accounts", mappings).split(",") });
    const pairs = page.results.map((r) => hubspotAccount(r, mappings)).flatMap((a) => (a.parentAccountId ? [{ child: a.crmId!, parent: a.parentAccountId }] : []));
    const ids = await registerIds(ctx, rc, run.orgId, "account", pairs.flatMap((p) => [p.child, p.parent]));
    for (const p of pairs) {
      const [child, parent] = [ids.get(p.child), ids.get(p.parent)];
      if (child && parent) links.push({ kind: "parent", ref: p.child, accountId: child.id, parentId: parent.id });
      else miss(p.child, `HubSpot company ${child ? p.parent : p.child} is not in Canon`);
    }
  } else if (phase === "contactCompanies") {
    page = await client.page("contacts", { after: run.cursor, properties: ["email"] });
    const assocs = await client.associations("contacts", "companies", page.results.map((r) => r.id));
    const plans = [...assocs].map(([contact, a]) => ({ contact, ...companiesOf(a) })).filter((p) => p.companies.length);
    const [people, companies] = await Promise.all([
      registerIds(ctx, rc, run.orgId, "contact", plans.map((p) => p.contact)),
      registerIds(ctx, rc, run.orgId, "account", plans.flatMap((p) => p.companies)),
    ]);
    for (const p of plans) {
      const person = people.get(p.contact);
      const companyIds = p.companies.flatMap((c) => (companies.has(c) ? [companies.get(c)!.id] : []));
      if (!person) miss(p.contact, "This person is not in Canon");
      else if (companyIds.length) links.push({ kind: "companies", ref: p.contact, contactId: person.id, ...(person.accountId ? { seed: person.accountId } : {}), companyIds });
      if (person && companyIds.length < p.companies.length) miss(p.contact, `${p.companies.length - companyIds.length} of this person's HubSpot companies are not in Canon`);
    }
  } else {
    page = await client.page("deals", { after: run.cursor, properties: ["dealname"] });
    const assocs = await client.associations("deals", "contacts", page.results.map((r) => r.id));
    const deals = new Map((await ctx.runQuery(internal.hubspotImport.dealRefs, { orgId: run.orgId, crmIds: [...assocs.keys()] })).map((d) => [d.crmId, d.deal]));
    const people = await registerIds(ctx, rc, run.orgId, "contact", [...assocs.values()].flatMap((a) => a.map((x) => x.toObjectId)));
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
  }
  let written = 0;
  for (const batch of chunk(links, LINK_BATCH)) {
    const out = await ctx.runMutation(internal.hubspotImport.writeLinks, { orgId: run.orgId, userId: run.startedBy, links: batch });
    written += out.applied;
    for (const f of out.failed) miss(f.ref, f.message);
  }
  return {
    phase: page.after ? phase : nextPhase(phase, run.objects as ImportObject[]), cursor: page.after, notices: [], failures,
    results: [{ object, read: links.length, written, failed: failures.length }],
  };
}

/** Each engagement's companies, people and deals in Canon: register ids for companies and people, stream ids for deals. */
async function engagementTargets(ctx: ActionCtx, rc: RecordClient, orgId: Id<"organizations">, client: HubspotImportClient, object: Engagement, ids: readonly string[]) {
  const [companies, people, deals] = await Promise.all((["companies", "contacts", "deals"] as const).map((to) => client.associations(object, to, ids)));
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
async function stepEngagements(ctx: ActionCtx, run: Run, client: HubspotImportClient): Promise<StepOut> {
  const object = run.phase as Engagement;
  const rc = clientFor(ctx);
  await settle(ctx, rc, run.orgId);
  const page = await client.page(object, { after: run.cursor, properties: ENGAGEMENT_PROPERTIES[object] });
  const ids = page.results.map((r) => r.id);
  const targets = await engagementTargets(ctx, rc, run.orgId, client, object, ids);
  const notices: StepOut["notices"] = [];
  let files = new Map<string, { name: string; url: string | null }>();
  const fileIds = object === "notes" ? [...new Set(page.results.flatMap((r) => attachmentIds(r.properties)))] : [];
  if (fileIds.length) {
    try {
      files = await client.files(fileIds);
    } catch (error) {
      if (!(error instanceof HubspotScopeError)) throw error;
      notices.push({ object, message: "The HubSpot connection cannot read files, so notes list their attachments by HubSpot file id. Reconnect HubSpot with the files scope for names and links." });
    }
  }
  const ownerMap = ownerMapOf(run);
  const failures: Failure[] = [];
  const mapped = page.results.map((r) => ({ id: r.id, m: engagementOf(object, r, attachmentText(attachmentIds(r.properties), files) ?? ""), t: targets.get(r.id)! }));
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
    for (const batch of chunk(rows, LINK_BATCH)) written += (await ctx.runMutation(internal.hubspotImport.writeEmails, { orgId: run.orgId, rows: batch })).logged;
  } else {
    const rows = mapped.flatMap(({ id, m, t }) => {
      if (m.kind !== "activity") return [];
      const ownerId = m.ownerCrmId ? ownerMap[m.ownerCrmId] : undefined;
      const links = { ...(t.companies[0] ? { accountId: t.companies[0] } : {}), ...(t.people[0] ? { contactId: t.people[0] } : {}), ...(t.deals[0] ? { dealId: t.deals[0] } : {}) };
      const all = [...t.companies, ...t.people, ...t.deals];
      if (all.length < t.missing) failures.push({ object, id, message: `${t.missing - all.length} of the records it is about are not in Canon` });
      return [{ hubspotId: id, object: m.object, createdAt: m.createdAt, targets: all, values: { ...m.values, ...links, ...(ownerId ? { ownerId } : {}) } }];
    });
    for (const batch of chunk(rows, LINK_BATCH)) {
      const out = await ctx.runMutation(internal.hubspotImport.writeActivities, { orgId: run.orgId, userId: run.startedBy, rows: batch });
      written += out.created + out.updated;
      for (const f of out.failed) failures.push({ object, id: f.ref, message: f.message });
    }
  }
  return {
    phase: page.after ? run.phase as Phase : nextPhase(run.phase as Phase, run.objects as ImportObject[]), cursor: page.after, notices, failures,
    results: [{ object, read: page.results.length, written, failed: failures.length }],
    ownerRecords: unmatchedRecords(run, page.results.map((r) => r.properties.hubspot_owner_id ?? undefined)),
  };
}

/** The portal's custom properties of companies, people and deals, as Canon custom fields (made or reused), saved on the run. */
async function stepProperties(ctx: ActionCtx, run: Run, client: HubspotImportClient): Promise<StepOut> {
  const objects = (["account", "contact", "deal"] as const).filter((o) => run.objects.includes(CUSTOM_OBJECTS[o]));
  const specs = (await Promise.all(objects.map(async (o) => customSpecs(o, await client.properties(CUSTOM_OBJECTS[o]))))).flat();
  const out = await ctx.runMutation(internal.hubspotImport.ensureCustomFields, { orgId: run.orgId, specs });
  return {
    phase: nextPhase("properties", run.objects as ImportObject[]), cursor: null, customFields: out.fields,
    results: [{ object: "custom fields", read: specs.length, written: out.fields.length, failed: out.refused.length }],
    failures: out.refused.map((r) => ({ object: "custom fields", id: r.property, message: r.message })), notices: [],
  };
}

/** The message a run shows when a step stops it; never a token or a HubSpot response body. */
const stopMessage = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

export const step = internalAction({
  args: { runId: v.id("crmImports"), lease: v.number() },
  handler: async (ctx, a) => {
    const run = await ctx.runQuery(internal.hubspotImport.runOf, { runId: a.runId });
    if (!run || run.status !== "running" || run.lease !== a.lease) return;
    const phase = run.phase as Phase;
    const empty = { results: [], failures: [], notices: [] };
    try {
      const { client, mappings } = await importClient(ctx, run.orgId);
      let out: StepOut;
      if (phase === "owners") out = await stepOwners(ctx, run, client);
      else if (phase === "pipelines") {
        const pipelines = await client.dealPipelines();
        const res = await ctx.runMutation(internal.hubspotImport.writePipelines, {
          orgId: run.orgId,
          pipelines: pipelines.map((p) => ({
            id: String(p.id), label: p.label, displayOrder: p.displayOrder, archived: p.archived,
            stages: p.stages.map((s) => ({ id: String(s.id), label: s.label, displayOrder: s.displayOrder, archived: s.archived, metadata: { probability: s.metadata?.probability, isClosed: s.metadata?.isClosed } })),
          })),
        });
        out = { ...empty, phase: nextPhase(phase, run.objects as ImportObject[]), cursor: null, results: [{ object: "pipelines", read: pipelines.length, written: res.pipelines, failed: 0 }] };
      } else if (phase === "properties") out = await stepProperties(ctx, run, client);
      else if (phase === "companies" || phase === "contacts" || phase === "deals") out = await stepRecords(ctx, run, client, mappings);
      else if (phase === "parents" || phase === "contactCompanies" || phase === "dealContacts") out = await stepLinks(ctx, run, client, mappings);
      else if ((ENGAGEMENTS as readonly string[]).includes(phase)) out = await stepEngagements(ctx, run, client);
      else return;
      await ctx.runMutation(internal.hubspotImport.advance, { runId: run._id, lease: a.lease, ...out });
    } catch (error) {
      if (error instanceof HubspotScopeError) {
        // The token cannot read this phase's object: skip the phase, say so, and carry on.
        await ctx.runMutation(internal.hubspotImport.advance, {
          runId: run._id, lease: a.lease, ...empty, phase: nextPhase(phase, run.objects as ImportObject[]), cursor: null,
          notices: [{ object: PHASE_RESULT[phase] ?? phase, message: `Skipped: the HubSpot connection cannot read ${error.object}. Reconnect HubSpot with the ${error.object === "emails" ? "sales-email-read" : `${error.object} read`} scope, then run the import again.` }],
        });
        return;
      }
      await ctx.runMutation(internal.hubspotImport.advance, { runId: run._id, lease: a.lease, ...empty, phase, cursor: run.cursor, error: stopMessage(error) });
    }
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
        const targets = await engagementTargets(ctx, rc, run.orgId, client, object, sampled.map((r) => r.id));
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
