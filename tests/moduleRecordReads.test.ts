import assert from "node:assert/strict";
import test from "node:test";
import { decodeCursor, type ListRow } from "../convex/lib/objects/listSpec.ts";
import { plainObjectDef, resolveObjectDef, STANDARD_OBJECTS } from "../convex/lib/objects/registry.ts";
import { createFakeRecordClient, createMemoryRecordStore } from "../convex/lib/recordClient.ts";
import { ProjectionBehind, readRecord, withIdsFrom, type RecordReadPorts, type RecordReadSpec } from "../convex/lib/modules/recordReads.ts";
import { accessOf } from "../convex/lib/access.ts";
import { scopedRecordClient } from "../convex/lib/scopedRecordClient.ts";
import { peopleContacts } from "../convex/lib/modules/peopleExport.ts";
import { resolvePeopleRows } from "../convex/lib/modules/recordReads.ts";
import { csvOf, AUDIENCE_MAX } from "../convex/lib/outbound/audience.ts";
import { parseModuleManifest } from "../modules/kernel/manifest.ts";

const defs = (["call", "meeting", "note", "task"] as const).map((o) => plainObjectDef(resolveObjectDef(STANDARD_OBJECTS[o])));
const row = (object: string, id: string, createdAt: number, values: Record<string, unknown>): ListRow =>
  ({ id, object, version: 1, status: "active", title: String(values.subject ?? values.title ?? id), createdAt, updatedAt: createdAt, deletedAt: null, values: values as ListRow["values"] });
const rows = [
  // A call on deal stream s1 by its lookup, a meeting about it by an edge only, and an older call before `since`.
  row("call", "a1", 3000, { subject: "Pricing", dealId: "s1", accountId: "acc_1", outcome: "connected", direction: "outbound", callAt: 2900, durationSeconds: 60, ownerId: "u1" }),
  row("meeting", "a2", 2000, { title: "Workshop", startAt: 2500, accountId: "acc_1", outcome: "completed" }),
  row("call", "a3", 500, { subject: "Intro", dealId: "s1" }),
  row("call", "a4", 2500, { subject: "Other deal", dealId: "s2" }),
];

async function fixture() {
  const store = createMemoryRecordStore();
  await store.putAccounts("org1", [{ id: "acc_1", domain: "atlas.example", name: "Atlas", industry: "Cloud", employees: 640, fit: 0, status: "new", segmentIds: [], source: "t", updatedAt: 1, version: 1 }]);
  await store.putContacts("org1", [{ id: "con_1", accountId: "acc_1", fullName: "Sam Rivera", email: "sam@atlas.example", title: "CFO", status: "active", updatedAt: 1 } as never]);
  const client = createFakeRecordClient({ store, objects: { rows: async (_ws, objects) => ({ rows: rows.filter((r) => !objects || objects.includes(r.object)), defs, heads: {} }) } });
  const ports: RecordReadPorts = { edgesTo: async () => [{ fromId: "a2", toId: "s1" }], dealsOf: async (ids) => Object.fromEntries(ids.filter((s) => s === "s1").map((s) => [s, "deal1"])), addedTo: async () => [], snapshot: async () => { throw new Error("no snapshots here"); } };
  const spec = (s: Partial<RecordReadSpec> & Pick<RecordReadSpec, "read" | "ids" | "fields">): RecordReadSpec => ({ since: null, limit: 1000, ...s });
  return { client, ports, spec };
}

test("a deal's activities come by lookup and by edge, newest first, named by the deal's id and logged since `since`", async () => {
  const { client, ports, spec } = await fixture();
  const got = await readRecord(client, "org1", ports, spec({ read: "activities.forDeals", ids: ["s1"], since: 1000, streams: { s1: "deal1" }, fields: ["kind", "at", "dealId", "companyId", "subject", "outcome"] }));
  assert.deepEqual(got, [
    { id: "a1", createdAt: 3000, kind: "call", at: 2900, dealId: "deal1", companyId: "acc_1", subject: "Pricing", outcome: "connected" },
    { id: "a2", createdAt: 2000, kind: "meeting", at: 2500, dealId: "deal1", companyId: "acc_1", subject: "Workshop", outcome: "completed" },
  ]);
  // Planned at ledger heads the record service hasn't projected yet, it refuses rather than miss the newest activity.
  await assert.rejects(readRecord(client, "org1", ports, spec({ read: "activities.forDeals", ids: ["s1"], streams: { s1: "deal1" }, through: { "3": 1 }, fields: ["kind"] })), ProjectionBehind);
  // Past its limit the read refuses rather than return part of what it names.
  await assert.rejects(readRecord(client, "org1", ports, spec({ read: "activities.forDeals", ids: ["s1"], streams: { s1: "deal1" }, limit: 1, fields: ["kind"] })), /more than 1 records/);
});

test("a company's people and the company come from the register with only their granted fields", async () => {
  const { client, ports, spec } = await fixture();
  assert.deepEqual(await readRecord(client, "org1", ports, spec({ read: "companies.byIds", ids: ["acc_1", "acc_gone"], fields: ["name", "employees"] })), [{ id: "acc_1", createdAt: 1, name: "Atlas", employees: 640 }]);
  assert.deepEqual(await readRecord(client, "org1", ports, spec({ read: "people.forCompanies", ids: ["acc_1"], fields: ["name", "title", "companyId"] })), [{ id: "con_1", createdAt: 1, name: "Sam Rivera", title: "CFO", companyId: "acc_1" }]);
});

const manifestWith = (reads: Record<string, unknown>) => parseModuleManifest(JSON.parse(JSON.stringify({
  kind: "module", id: "@t/m", version: "1.0.0", title: "M", description: "d", author: { org: "t" }, engines: { moduleApi: "1" },
  nav: { label: "M", icon: "box", section: "Work", landing: "p" }, collections: {}, views: {}, ops: {},
  reads: { companies: ["name"], people: ["name"], deals: ["name"] }, facts: { companies: { read: ["industry"] } }, server: "dist/module.js",
  calls: { c: { label: "C", roles: ["admin"], agent: "allowed", writes: [], returns: "value",
    args: { type: "object", value: { ids: { fieldType: { type: "array", value: { type: "string" } }, optional: false } } }, reads } },
  pages: [{ path: "p", title: "P", body: [] }],
})));
const problems = (parsed: ReturnType<typeof parseModuleManifest>) => (parsed.ok ? [] : parsed.errors);

test("a record read takes ids from an earlier read of companies or people; a plan read can't", () => {
  assert.deepEqual(problems(manifestWith({
    page: { canon: "companies.updatedSince", args: { since: 0 }, limit: 100 },
    facts: { canon: "facts.forRecords", args: { object: "companies", ids: { read: "page" } } },
    ppl: { canon: "people.forCompanies", args: { ids: { read: "page" } } },
  })), []);
  const refused = problems(manifestWith({
    co: { canon: "companies.byIds", args: { ids: { arg: "ids" } } },
    deals: { canon: "deals.byIds", args: { ids: { read: "co" } } },
  }));
  assert.ok(refused.some((e) => e.includes("reads from the record service after the plan")), JSON.stringify(refused));
});

test("a page of companies is at most 500, and filters by owner only with the ownerId grant", () => {
  const refused = problems(manifestWith({ page: { canon: "companies.updatedSince", args: { since: 0, owner: { arg: "ids" } }, limit: 501 } }));
  assert.equal(refused.filter((e) => e.includes("at most 500") || e.includes("(ownerId)")).length, 2, JSON.stringify(refused));
});

async function pagedFixture() {
  const store = createMemoryRecordStore();
  const account = (id: string, updatedAt: number, ownerId: string) => ({ id, domain: `${id}.example`, name: id.toUpperCase(), industry: "Cloud", ownerId, fit: 0, status: "new" as const, segmentIds: [], source: "t", updatedAt, version: 1 });
  // c2 and c3 changed at the same time; c0 before `since`.
  await store.putAccounts("org1", [account("c3", 20, "rep"), account("c1", 10, "rep"), account("c4", 30, "other"), account("c2", 20, "other"), account("c0", 5, "rep"), account("c5", 40, "other")]);
  const { ports } = await fixture();
  const page = (cursor: string | null, extra: Partial<RecordReadSpec> = {}): RecordReadSpec => ({ read: "companies.updatedSince", ids: [], since: 10, limit: 2, fields: ["name"], page: { cursor, owner: null }, ...extra });
  return { base: createFakeRecordClient({ store }), ports, page };
}
const idsOf = (rows: Array<Record<string, unknown>>) => rows.map((r) => [r.id, r.updatedAt, typeof r.next]);

test("companies page oldest change first, by id within one time, each next reading on with only the granted fields", async () => {
  const { base, ports, page } = await pagedFixture();
  const first = await readRecord(base, "org1", ports, page(null));
  assert.deepEqual(first.map(({ next: _, ...r }) => r), [{ id: "c1", createdAt: 10, updatedAt: 10, name: "C1" }, { id: "c2", createdAt: 20, updatedAt: 20, name: "C2" }]);
  const next = String(first[1].next);
  assert.equal(decodeCursor(next).total, 0, "a cursor holds no count");
  const second = await readRecord(base, "org1", ports, page(next));
  assert.deepEqual(idsOf(second), [["c3", 20, "undefined"], ["c4", 30, "string"]]);
  assert.deepEqual(idsOf(await readRecord(base, "org1", ports, page(String(second[1].next)))), [["c5", 40, "undefined"]]);
  // A cursor reads only with the since it was given for.
  await assert.rejects(readRecord(base, "org1", ports, page(next, { since: 11 })), /reads only with the since and owner/);
  assert.deepEqual(idsOf(await readRecord(base, "org1", ports, page(null, { limit: 5, page: { cursor: null, owner: "rep" } }))), [["c1", 10, "undefined"], ["c3", 20, "undefined"]]);
});

test("a rep's page holds only the companies they see, a hidden field as null, and no next when only hidden ones follow", async () => {
  const { base, ports, page } = await pagedFixture();
  const rep = scopedRecordClient(base, [accessOf({ userId: "rep", role: "rep", rules: [{ object: "account", visibility: "own", unowned: false, fields: [{ apiName: "industry", level: "hidden" }] }] })], async () => null);
  const own = await readRecord(rep, "org1", ports, page(null, { fields: ["name", "industry"] }));
  assert.deepEqual(own, [{ id: "c1", createdAt: 10, updatedAt: 10, name: "C1", industry: null }, { id: "c3", createdAt: 20, updatedAt: 20, name: "C3", industry: null }]);
  // Another caller's cursor doesn't read for the rep: it is bound to its scope.
  const managers = await readRecord(base, "org1", ports, page(null));
  await assert.rejects(readRecord(rep, "org1", ports, page(String(managers[1].next))), /reads only with the since and owner/);
  // A job reads as Canon: every company.
  assert.equal((await readRecord(base, "org1", ports, page(null, { limit: 10 }))).length, 5);
});

test("a later read's ids come from an earlier page, each once, and refuse past its cap", () => {
  const spec: RecordReadSpec = { read: "facts.forRecords", ids: [], since: null, limit: 1000, fields: [], idsFrom: { read: "page" } };
  assert.deepEqual(withIdsFrom(spec, { page: [{ id: "a" }, { id: "b" }, { id: "a" }] }).ids, ["a", "b"]);
  assert.deepEqual(withIdsFrom({ ...spec, read: "companies.byIds", idsFrom: { read: "people", field: "companyId" } }, { people: [{ id: "p1", companyId: "a" }, { id: "p2", companyId: null }] }).ids, ["a"]);
  assert.throws(() => withIdsFrom(spec, { page: Array.from({ length: 101 }, (_, i) => ({ id: `c${i}` })) }), /at most 100 records, and page gave 101/);
});

test("what was said: notes' and calls' text, and each recording's transcript joined to its activity or as a call of its own", async () => {
  const { client, ports, spec } = await fixture();
  const recordings = [
    { id: "rec1", activityId: "a1", dealId: "deal1", title: "Pricing", at: 2900, ownerId: "u1", provider: "telnyx" },
    { id: "rec2", activityId: null, dealId: "deal1", title: "Gong: Exec sync", at: 2800, ownerId: "u1", provider: "gong" },
    // A call the caller's activity rules hide: its recording stays hidden with it.
    { id: "rec3", activityId: "hidden", dealId: "deal1", title: "Board prep", at: 2700, ownerId: "u2", provider: "telnyx" },
  ];
  const said: Record<string, { transcript: string; insights: Array<{ type: string; text: string; evidence: string }> }> = {
    rec1: { transcript: "Customer (Sam Rivera): The per-seat price is over budget.", insights: [{ type: "pricing", text: "Price over budget", evidence: "The per-seat price is over budget." }] },
    rec2: { transcript: "Rep: Where are you on security review?", insights: [] },
  };
  const asked: string[][] = [];
  const withContent: RecordReadPorts = { ...ports, recordingsOf: async (deals) => { asked.push(deals); return recordings; }, recordingContent: async (id) => said[id] ?? null };
  const got = await readRecord(client, "org1", withContent, spec({ read: "activities.forDeals", ids: ["s1"], since: 1000, streams: { s1: "deal1" }, fields: ["kind", "subject", "transcript", "insights"] }));
  assert.deepEqual(asked, [["deal1"]], "recordings are read for the deals the plan found the caller sees, by their ids");
  assert.deepEqual(got.map((r) => [r.id, r.kind, r.subject, r.transcript, (r.insights as unknown[]).length]), [
    ["a1", "call", "Pricing", "Customer (Sam Rivera): The per-seat price is over budget.", 1],
    ["recording:rec2", "call", "Gong: Exec sync", "Rep: Where are you on security review?", 0],
    ["a2", "meeting", "Workshop", null, 0],
  ]);
  const huge: RecordReadPorts = { ...withContent, recordingContent: async () => ({ transcript: "x".repeat(3_000_001), insights: [] }) };
  await assert.rejects(readRecord(client, "org1", huge, spec({ read: "activities.forDeals", ids: ["s1"], streams: { s1: "deal1" }, fields: ["transcript"] })), /at most 3,000,000/, "past the cap it refuses rather than return part of what was said");
});

test("an audience snapshot freezes its people once each, and a page reads them back with their granted fields", async () => {
  const { client: source, spec } = await fixture();
  const client = { ...source, listRegister: async (...args: Parameters<typeof source.listRegister>) => {
    const page = await source.listRegister(...args);
    return { ...page, rows: page.rows.flatMap((r) => [r, r]) };
  } };
  let stored: string[] = [];
  const ports: RecordReadPorts = { edgesTo: async () => [], dealsOf: async () => ({}), addedTo: async () => ["con_1", "con_hidden"], snapshot: async (_m, _a, ids) => { stored = ids; return { snapshot: "snap1", createdAt: 7 }; } };
  // The filter matches con_1, also added by hand: one member. con_hidden, added by hand, isn't a person the reader sees.
  const got = await readRecord(client, "org1", ports, spec({ read: "audiences.snapshot", ids: ["aud1"], fields: [], audience: { moduleId: "@t/m", filter: [{ field: "title", op: "eq", value: "CFO" }] } }));
  assert.deepEqual(got, [{ id: "snap1", createdAt: 7, audience: "aud1", count: 1, pages: 1 }]);
  assert.deepEqual(stored, ["con_1"]);
  assert.deepEqual(await readRecord(source, "org1", ports, spec({ read: "audiences.members", ids: stored, fields: ["name", "title"] })), [{ id: "con_1", createdAt: 1, name: "Sam Rivera", title: "CFO" }]);
});

test("market query lines intersect include-only filters and distinguish empty from unknowable paths", async () => {
  const { marketFilterOfLines } = await import("../convex/lib/marketSize.ts");
  assert.deepEqual(marketFilterOfLines(["size:1001-5000,5001-10000,10001+", "country:us,ca"]), { sizeBand: ["1001-5000", "5001-10000", "10001+"], country: ["united states", "canada"] });
  assert.deepEqual(marketFilterOfLines(["region:europe"]), { region: ["europe"] });
  assert.deepEqual(marketFilterOfLines(["country:us,ca", "country:ca"]), { country: ["canada"] });
  assert.equal(marketFilterOfLines(["country:us", "country:ca"]), 0);
  assert.deepEqual(marketFilterOfLines([""]), {});
  for (const line of ["-country:us", "city:paris", "owner:none", "revenue:50m+", "field.model:saas", "has(title:engineer)", "invalid"]) assert.equal(marketFilterOfLines([line]), null, line);
  assert.equal(marketFilterOfLines(["country:us", "country:ca", "city:paris"]), null);
});

test("a module doc's people freeze from its filter and its added set, a count stores nothing, and both say how many have an email", async () => {
  const { client, spec } = await fixture();
  const asked: unknown[] = [];
  let stored: string[] = [];
  const ports: RecordReadPorts = {
    edgesTo: async () => [], dealsOf: async () => ({}),
    addedTo: async (source) => { asked.push(source); return ["con_1", "con_hidden", "con_1"]; },
    snapshot: async (_m, source, ids) => { stored = ["source" in source ? source.source : source.audienceId, ...ids]; return { snapshot: "snap2", createdAt: 9 }; },
  };
  const added = { module: "@canon/audiences", set: "additions", parentKey: "k1", field: "person" };
  const audience = { moduleId: "@canon/sequences", filter: [{ field: "title", op: "eq" as const, value: "CRO" }], source: "@canon/audiences/k1", added };
  const [{ computedAt, ...counted }] = await readRecord(client, "org1", ports, spec({ read: "people.count", ids: ["k1"], fields: [], audience }));
  assert.deepEqual(counted, { source: "k1", count: 1, withEmail: 1, customVariables: [] });
  assert.equal(typeof computedAt, "number");
  assert.deepEqual(stored, [], "a count stores no snapshot");
  assert.deepEqual(await readRecord(client, "org1", ports, spec({ read: "people.snapshot", ids: ["k1"], fields: [], audience })), [{ id: "snap2", createdAt: 9, source: "k1", count: 1, withEmail: 1, pages: 1 }]);
  assert.deepEqual(stored, ["@canon/audiences/k1", "con_1"]);
  assert.deepEqual(asked, [added, added], "the added people come from the doc's set");
  const filterOnly = { ...audience, added: undefined, filter: [{ field: "title", op: "eq" as const, value: "CFO" }] };
  assert.deepEqual(await readRecord(client, "org1", ports, spec({ read: "people.snapshot", ids: ["k1"], fields: [], audience: filterOnly })), [{ id: "snap2", createdAt: 9, source: "k1", count: 1, withEmail: 1, pages: 1 }]);
  assert.deepEqual(asked, [added, added], "a query without additions never reads the legacy audience table");
  assert.deepEqual(await readRecord(client, "org1", ports, spec({ read: "people.snapshotPage", ids: ["con_1"], fields: ["name", "title"] })), [{ id: "con_1", createdAt: 1, name: "Sam Rivera", title: "CFO" }]);
});


test("People count and CSV share the caller's visible union and custom fields, with formula-safe dynamic columns", async () => {
  const { ports, spec } = await fixture();
  const store = createMemoryRecordStore();
  await store.putAccounts("org1", [{ id: "acc_1", domain: "atlas.example", name: "Atlas", fit: 0, status: "new", segmentIds: [], source: "t", updatedAt: 1, version: 1 }]);
  await store.putContacts("org1", [{ id: "con_1", accountId: "acc_1", ownerId: "rep1", fullName: "Sam Rivera", email: "sam@atlas.example", title: "CFO", status: "active", updatedAt: 1 } as never]);
  const client = createFakeRecordClient({ store });
  const page = await client.listRegister("org1", "contact", { limit: 20 });
  const [contact] = await peopleContacts(client, "org1", page.rows.map((r) => ({ ...r, values: { ...r.values, additionalEmails: ["extra@atlas.example"], additionalPhones: ["+12025550123"] } })));
  assert.equal(contact.company, "Atlas");
  assert.deepEqual(contact.otherEmails, ["extra@atlas.example"]);
  assert.deepEqual(contact.otherPhones, ["+12025550123"]);
  const base = { ...client, listRegister: async (...args: Parameters<typeof client.listRegister>) => {
    const page = await client.listRegister(...args);
    if (args[1] === "account") return { ...page, rows: page.rows.map((r) => ({ ...r, values: { ...r.values, name: "Hidden employer" } })) };
    return { ...page, rows: page.rows.map((r) => ({ ...r, values: { ...r.values, ownerId: "rep1", fullName: "=FORMULA Person", title: "@evil", "custom.deep-link": ["one", "two"], "custom.private": "Secret", "custom.empty": [], "custom.zero": 0, "custom.no": false } })) };
  } };
  const rules = [{ object: "contact", visibility: "own" as const, unowned: false, fields: [{ apiName: "email", level: "hidden" as const }, { apiName: "custom.private", level: "hidden" as const }] }, { object: "account", fields: [{ apiName: "name", level: "hidden" as const }] }];
  const scoped = (userId: string) => scopedRecordClient(base, [accessOf({ userId, role: "rep", rules })], async () => null);
  const audience = { moduleId: "@canon/audiences", filter: [], added: { module: "@canon/audiences", set: "additions", parentKey: "k1", field: "person" } };
  const additions = async () => ["con_1", "con_hidden", "con_1"];
  const reader = scoped("rep1");
  const [{ computedAt, ...counted }] = await readRecord(reader, "org1", { ...ports, addedTo: additions }, spec({ read: "people.count", ids: ["k1"], fields: [], audience }));
  assert.deepEqual(counted, { source: "k1", count: 1, withEmail: 0, customVariables: ["deep_link", "no", "zero"] });
  assert.equal(typeof computedAt, "number");
  const visible = await resolvePeopleRows(reader, "org1", additions, audience);
  const csv = csvOf(await peopleContacts(reader, "org1", visible));
  assert.equal(csv.split("\r\n")[0], "email,first_name,last_name,company,title,phone,linkedin_url,deep_link,no,zero");
  assert.ok(csv.includes("'=FORMULA") && csv.includes("'@evil") && csv.includes("one; two"));
  assert.ok(!csv.includes("Secret") && !csv.includes("Hidden employer") && !csv.includes("sam@"));
  assert.deepEqual(await resolvePeopleRows(scoped("rep2"), "org1", additions, audience), []);
  const tooMany = { ...client, listRegister: async () => ({ rows: Array.from({ length: AUDIENCE_MAX + 1 }, (_, i) => ({ ...row("contact", `p${i}`, 1, {}), stream: null })), total: AUDIENCE_MAX + 1, projectedThrough: {}, nextCursor: null }) };
  await assert.rejects(resolvePeopleRows(tooMany, "org1", additions, audience));
  const broken = { ...client, listRegister: async () => { throw new Error("record service unavailable"); } };
  await assert.rejects(resolvePeopleRows(broken, "org1", additions, audience));
});

test("best-fit accounts are a caller-scoped register read with hidden fields removed", async () => {
  const store = createMemoryRecordStore();
  await store.putAccounts("org1", [
    { id: "own", name: "Visible", domain: "visible.test", fit: 40, industry: "retail", ownerId: "rep", status: "new", segmentIds: [], source: "test", updatedAt: 1, version: 1 },
    { id: "hidden", name: "Private", domain: "private.test", fit: 90, ownerId: "other", status: "new", segmentIds: [], source: "test", updatedAt: 2, version: 1 },
  ]);
  const client = scopedRecordClient(createFakeRecordClient({ store }), [accessOf({ userId: "rep", role: "rep", rules: [{ object: "account", visibility: "own", fields: [{ apiName: "industry", level: "hidden" }] }] })], async () => null);
  const { ports } = await fixture();
  const found = await readRecord(client, "org1", ports, { read: "companies.bestFit", ids: [], fields: ["name", "industry"], limit: 15, since: null });
  assert.deepEqual(found.map((r) => [r.id, r.name, r.industry]), [["own", "Visible", null]]);
});
