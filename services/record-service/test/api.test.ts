import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { configFromEnv } from "../src/app.ts";
import { client, fixtureAccounts, startApp, tempDir, TOKEN } from "./helpers.ts";

const ICP = { base: 10, industries: { software: 50, fintech: 30 }, countries: { us: 20 }, employeeBands: [{ min: 100, max: 1000, weight: 15 }] };

describe("record service API", () => {
  let ctx: Awaited<ReturnType<typeof startApp>>;
  before(async () => {
    ctx = await startApp({ version: configFromEnv({ RECORD_SERVICE_TOKEN: TOKEN, GIT_SHA: "abcdef0123456789abcdef0123456789abcdef0123" }).version });
  });
  after(async () => {
    await ctx.app.shutdown();
  });

  it("healthz needs no auth and reports the deployed GIT_SHA", async () => {
    const r = await fetch(`${ctx.base}/healthz`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.match(j.version, /\+abcdef0$/);
    assert.equal(typeof j.openWorkspaces, "number");
  });

  it("returns 401 without or with a wrong token", async () => {
    const r = await fetch(`${ctx.base}/v1/workspaces/test/accounts/list`, { method: "POST", body: "{}" });
    assert.equal(r.status, 401);
    const bad = await client(ctx.base, "wrong-token-wrong-token").ws("test").post("accounts/list", {});
    assert.equal(bad.status, 401);
    const m = await fetch(`${ctx.base}/metrics`);
    assert.equal(m.status, 401);
  });

  it("serves metrics with auth", async () => {
    const r = await ctx.client.call("GET", "/metrics");
    assert.equal(r.status, 200);
    assert.match(r.json, /record_service_requests_total/);
  });

  it("rejects path traversal and malformed workspace ids", async () => {
    for (const ws of ["..%2F..%2Fetc%2Fpasswd", "..", "a.b", "%2E%2E", "x".repeat(65), "a%00b"]) {
      const r = await ctx.client.call("POST", `/v1/workspaces/${ws}/provision`, {}, decodeURIComponent(ws).replace(/\0/g, ""));
      assert.ok(r.status === 400 || r.status === 404, `ws=${ws} -> ${r.status}`);
    }
    // nothing escaped the data dir
    assert.deepEqual(readdirSync(ctx.cfg.dataDir).sort(), ["ws"]);
    assert.equal(existsSync(join(ctx.cfg.dataDir, "..", "passwd.duckdb")), false);
  });

  it("requires X-Workspace-Id to match the path", async () => {
    const r = await ctx.client.call("POST", "/v1/workspaces/acme/provision", {}, "other");
    assert.equal(r.status, 403);
  });

  it("returns 400 for invalid bodies (zod)", async () => {
    const ws = ctx.client.ws("zod");
    assert.deepEqual((await ws.post("provision")).json, { created: true });
    const cases: unknown[] = [
      { records: [], source: "x", idempotencyKey: "k" },
      { records: [{ domain: "a.com" }], source: "x", idempotencyKey: "k" },
      { records: [{ domain: "a.com", name: "A", employees: "many" }], source: "x", idempotencyKey: "k" },
    ];
    for (const body of cases) {
      const r = await ws.post("accounts/upsert", body);
      assert.equal(r.status, 400, JSON.stringify(r.json));
      assert.ok(r.json.issues);
    }
    assert.equal((await ws.post("accounts/list", { limit: 500 })).status, 400);
    assert.equal((await ws.post("accounts/list", { sort: { field: "domain; DROP TABLE accounts", dir: "asc" } })).status, 400);
    assert.equal((await ws.post("records/edit", { object: "account", id: "x", patch: { fit: 3 }, actorId: "u", idempotencyKey: "k" })).status, 400);
    assert.equal((await ws.post("records/edit", { object: "account", id: "x", patch: { status: "bogus" }, actorId: "u", idempotencyKey: "k" })).status, 400);
    const raw = await fetch(`${ctx.base}/v1/workspaces/zod/accounts/list`, {
      method: "POST", headers: { authorization: `Bearer ${"test-token-0123456789abcdef"}`, "x-workspace-id": "zod" }, body: "{not json",
    });
    assert.equal(raw.status, 400);
  });

  it("404s an unprovisioned workspace without creating it", async () => {
    const r = await ctx.client.ws("ghost").post("accounts/list", {});
    assert.equal(r.status, 404);
    assert.equal(existsSync(join(ctx.cfg.dataDir, "ws", "ghost.duckdb")), false);
  });

  it("deletes a workspace only with a matching confirm, removing its files", async () => {
    const ws = ctx.client.ws("doomed");
    await ws.post("provision");
    assert.equal((await ws.post("accounts/upsert", { records: fixtureAccounts(5), source: "t", idempotencyKey: "d1" })).status, 200);
    const file = join(ctx.cfg.dataDir, "ws", "doomed.duckdb");
    assert.equal(existsSync(file), true);
    assert.equal((await ws.post("delete", {})).status, 400, "confirm is required");
    assert.equal((await ws.post("delete", { confirm: "other" })).status, 400, "confirm must match");
    assert.equal(existsSync(file), true, "nothing deleted by rejected calls");
    assert.deepEqual((await ws.post("delete", { confirm: "doomed" })).json, { deleted: true });
    assert.equal(existsSync(file), false);
    assert.equal(existsSync(`${file}.wal`), false);
    assert.equal((await ws.post("accounts/list", {})).status, 404, "gone, and not recreated by a read");
    assert.deepEqual((await ws.post("delete", { confirm: "doomed" })).json, { deleted: false }, "idempotent");
    // Re-provisioning starts empty.
    await ws.post("provision");
    assert.equal((await ws.post("accounts/list", {})).json.total, 0);
  });

  it("provision is idempotent", async () => {
    const ws = ctx.client.ws("prov");
    assert.deepEqual((await ws.post("provision")).json, { created: true });
    assert.deepEqual((await ws.post("provision")).json, { created: false });
  });

  it("upserts, lists sorted by fit desc with a correct total, pages with a cursor, counts segments", async () => {
    const ws = ctx.client.ws("list");
    await ws.post("provision");
    assert.equal((await ws.post("rescore", { icp: ICP })).status, 200);
    const recs = fixtureAccounts(250);
    const up = await ws.post("accounts/upsert", { records: recs, source: "test", idempotencyKey: "u1" });
    assert.equal(up.status, 200, JSON.stringify(up.json));
    assert.equal(up.json.upserted, 250);

    const l = await ws.post("accounts/list", { limit: 100 });
    assert.equal(l.status, 200);
    assert.equal(l.json.total, 250);
    assert.equal(l.json.rows.length, 100);
    const fits = l.json.rows.map((r: { fit: number }) => r.fit);
    assert.deepEqual(fits, [...fits].sort((a, b) => b - a));
    assert.equal(fits[0], 95); // software + US + 100..1000 employees: 10+50+20+15
    assert.ok(Array.isArray(l.json.rows[0].segmentIds));

    let seen = l.json.rows.length;
    let cursor = l.json.nextCursor;
    while (cursor) {
      const p = await ws.post("accounts/list", { limit: 100, cursor });
      seen += p.json.rows.length;
      cursor = p.json.nextCursor;
    }
    assert.equal(seen, 250);

    const filtered = await ws.post("accounts/list", { filter: { industry: ["software"], country: ["US"], minFit: 80 }, sort: { field: "name", dir: "asc" } });
    assert.ok(filtered.json.rows.every((r: any) => r.industry === "Software" && r.country === "US" && r.fit >= 80));
    const names = filtered.json.rows.map((r: any) => r.name);
    assert.deepEqual(names, [...names].sort());

    const seg = await ws.post("segments/count", { filter: { segmentId: "seg-a" } });
    assert.equal(seg.json.total, Math.ceil(250 / 3));
    const q = await ws.post("segments/count", { filter: { q: "co0-12" } });
    assert.ok(q.json.total >= 1);
  });

  it("facets group by TAM dimensions and annotate carries revenue and traits (1.4.0)", async () => {
    const ws = ctx.client.ws("facets");
    await ws.post("provision");
    const records = [...fixtureAccounts(20), { domain: "bare.example.com", name: "Bare Co" }];
    const up = await ws.post("accounts/upsert", { records, source: "t", idempotencyKey: "f1" });
    const ids: string[] = up.json.ids;

    const ind = await ws.post("accounts/facets", { groupBy: "industry" });
    assert.equal(ind.status, 200);
    assert.equal(ind.json.total, 21);
    const software = records.filter((r: any) => r.industry?.toLowerCase() === "software");
    // Facet keys are canonical industries (1.16.0): "Software" groups as "software development".
    assert.deepEqual(ind.json.groups.find((g: any) => g.key === "software development"), {
      key: "software development", count: 4, revenue: 0, revenueKnown: 0,
      employees: software.reduce((sum: number, r: any) => sum + (r.employees ?? 0), 0),
    });
    assert.equal(ind.json.employees, records.reduce((sum: number, r: any) => sum + (r.employees ?? 0), 0));
    assert.equal(ind.json.groups.find((g: any) => g.key === "__none__").count, 1);

    const region = await ws.post("accounts/facets", { groupBy: "region" });
    const byRegion = Object.fromEntries(region.json.groups.map((g: any) => [g.key, g.count]));
    assert.deepEqual(byRegion, { "north-america": 10, europe: 10, __none__: 1 }); // US+CA, GB+DE

    const size = await ws.post("accounts/facets", { groupBy: "sizeBand", filter: { region: ["europe"] } });
    assert.equal(size.json.total, 10);
    const band = size.json.groups[0].key;
    const inBand = await ws.post("segments/count", { filter: { region: ["europe"], sizeBand: [band] } });
    assert.equal(inBand.json.total, size.json.groups[0].count);
    assert.equal((await ws.post("segments/count", { filter: { industry: ["__none__"] } })).json.total, 1);

    // Revenue: crm beats estimate; estimates fill gaps. Traits merge and clear.
    const ann = await ws.post("accounts/annotate", {
      records: [
        { id: ids[0], revenue: 5_000_000, revenueSource: "crm", traits: { "reps": "yes" } },
        { id: ids[1], revenue: 2_000_000, revenueSource: "estimate", revenueConfidence: 0.6, traits: { "reps": "no" } },
        { id: "missing-id", traits: { reps: "yes" } },
        { domain: "https://www.BARE.example.com/", revenue: 9, revenueSource: "crm" },
        { domain: "nowhere.example.com", revenue: 9 },
      ],
    });
    assert.deepEqual(ann.json, { updated: 3, missing: ["missing-id", "nowhere.example.com"] });
    await ws.post("accounts/annotate", { records: [{ domain: "bare.example.com", revenue: null }] });
    assert.equal((await ws.post("accounts/annotate", { records: [{ traits: { a: "b" } }] })).status, 400);
    await ws.post("accounts/annotate", { records: [{ id: ids[0], revenue: 1, revenueSource: "estimate", traits: { jtbd: "buyer-a" } }] });
    const got = await ws.post("accounts/get", { id: ids[0] });
    assert.equal(got.json.account.revenue, 5_000_000);
    assert.equal(got.json.account.revenueSource, "crm");
    assert.deepEqual(got.json.account.traits, { reps: "yes", jtbd: "buyer-a" });
    assert.equal(got.json.account.version, 1, "annotations do not bump the version");

    const reps = await ws.post("accounts/facets", { groupBy: "trait:reps" });
    assert.deepEqual(reps.json.groups.map((g: any) => [g.key, g.count]), [["__none__", 19], ["no", 1], ["yes", 1]]);
    assert.equal(reps.json.revenue, 7_000_000);
    assert.equal(reps.json.revenueKnown, 2);
    const yes = await ws.post("accounts/list", { filter: { traits: { reps: ["yes"] } } });
    assert.deepEqual(yes.json.rows.map((r: any) => r.id), [ids[0]]);

    await ws.post("accounts/annotate", { records: [{ id: ids[0], traits: { reps: null } }] });
    assert.equal((await ws.post("segments/count", { filter: { traits: { reps: ["__none__"] } } })).json.total, 20);

    // A later upsert leaves derived columns alone.
    await ws.post("accounts/upsert", { records: [{ ...records[0], name: "Renamed" }], source: "t", idempotencyKey: "f2" });
    const after = await ws.post("accounts/get", { id: ids[0] });
    assert.equal(after.json.account.revenue, 5_000_000);
    assert.deepEqual(after.json.account.traits, { jtbd: "buyer-a" });

    assert.equal((await ws.post("accounts/facets", { groupBy: "trait:Bad Key" })).status, 400);
    assert.equal((await ws.post("accounts/facets", { groupBy: "industry", limit: 2 })).json.truncated, true);
  });

  it("upsert is idempotent by key and by content", async () => {
    const ws = ctx.client.ws("idem");
    await ws.post("provision");
    const body = { records: fixtureAccounts(5), source: "t", idempotencyKey: "same" };
    const a = await ws.post("accounts/upsert", body);
    const b = await ws.post("accounts/upsert", body);
    assert.deepEqual(a.json, b.json);
    const c = await ws.post("accounts/upsert", { ...body, idempotencyKey: "different" });
    assert.equal(c.json.upserted, 5);
    const changes = await ws.get("changes?after=0");
    assert.equal(changes.json.changes.length, 5, "no-op re-upsert emits no changes");
    const l = await ws.post("accounts/list", {});
    assert.ok(l.json.rows.every((r: any) => r.version === 1));
  });

  it("fill: missing keeps existing values; a LinkedIn contact attaches to the same person stored by name", async () => {
    const ws = ctx.client.ws("fill");
    await ws.post("provision");
    await ws.post("accounts/upsert", { records: [{ domain: "acme.com", name: "Acme Corp", industry: "software" }], source: "crm", idempotencyKey: "a1" });
    const filled = await ws.post("accounts/upsert", {
      records: [{ domain: "acme.com", name: "Acme", industry: "retail", employees: 120 }], source: "population", idempotencyKey: "a2", fill: "missing",
    });
    assert.equal(filled.status, 200, JSON.stringify(filled.json));
    const [acc] = (await ws.post("accounts/list", {})).json.rows;
    assert.deepEqual([acc.name, acc.industry, acc.employees], ["Acme Corp", "software", 120], "only the empty field was set");
    await ws.post("accounts/upsert", { records: [{ domain: "acme.com", name: "Acme Inc" }], source: "names", idempotencyKey: "a3" });
    assert.equal((await ws.post("accounts/list", {})).json.rows[0].name, "Acme Inc", "the default still overwrites");

    await ws.post("contacts/upsert", { records: [{ accountDomain: "acme.com", fullName: "Ada Lovelace", title: "VP Sales" }], source: "leadsforge", idempotencyKey: "c1", fill: "missing" });
    await ws.post("contacts/upsert", {
      records: [{ accountDomain: "acme.com", fullName: "Ada Lovelace", title: "CRO", linkedinUrl: "https://linkedin.com/in/ada" }],
      source: "quickenrich", idempotencyKey: "c2", fill: "missing",
    });
    const contacts = (await ws.post("contacts/list", {})).json.rows;
    assert.equal(contacts.length, 1, "one person, not two");
    assert.deepEqual([contacts[0].title, contacts[0].linkedinUrl], ["VP Sales", "https://linkedin.com/in/ada"]);
  });

  it("nameIfCurrently replaces only the placeholder; contacts match in either source order", async () => {
    const ws = ctx.client.ws("guard");
    await ws.post("provision");
    await ws.post("accounts/upsert", { records: [{ domain: "acme.com", name: "Acme" }, { domain: "beta.io", name: "Beta" }], source: "leadsforge", idempotencyKey: "g1", fill: "missing" });
    await ws.post("records/edit", { object: "account", id: (await ws.post("accounts/list", { filter: { q: "beta" } })).json.rows[0].id, patch: { name: "Beta Labs (rep)" }, actorId: "u1", idempotencyKey: "e1" });
    const named = await ws.post("accounts/upsert", {
      records: [{ domain: "acme.com", name: "Acme Corporation", nameIfCurrently: "Acme" }, { domain: "beta.io", name: "Beta Inc", nameIfCurrently: "Beta" }],
      source: "names", idempotencyKey: "g2", fill: "missing",
    });
    assert.equal(named.status, 200, JSON.stringify(named.json));
    const names = Object.fromEntries((await ws.post("accounts/list", {})).json.rows.map((r: any) => [r.domain, r.name]));
    assert.deepEqual(names, { "acme.com": "Acme Corporation", "beta.io": "Beta Labs (rep)" }, "the rep's name survives");

    // QuickEnrich (LinkedIn) first, then Leadsforge (name only): one contact.
    await ws.post("contacts/upsert", { records: [{ accountDomain: "acme.com", fullName: "Grace Hopper", linkedinUrl: "https://linkedin.com/in/grace" }], source: "quickenrich", idempotencyKey: "c1", fill: "missing" });
    await ws.post("contacts/upsert", { records: [{ accountDomain: "acme.com", fullName: "grace hopper", title: "CTO" }], source: "leadsforge", idempotencyKey: "c2", fill: "missing" });
    const grace = (await ws.post("contacts/list", { filter: { q: "grace" } })).json.rows;
    assert.equal(grace.length, 1, "one person, not two");
    assert.deepEqual([grace[0].linkedinUrl, grace[0].title], ["https://linkedin.com/in/grace", "CTO"]);

    // Two people with one name at an account: a name-only record matches neither.
    await ws.post("contacts/upsert", { records: [
      { accountDomain: "beta.io", fullName: "Sam Lee", linkedinUrl: "https://linkedin.com/in/sam1" },
      { accountDomain: "beta.io", fullName: "Sam Lee", linkedinUrl: "https://linkedin.com/in/sam2" },
    ], source: "quickenrich", idempotencyKey: "c3", fill: "missing" });
    await ws.post("contacts/upsert", { records: [{ accountDomain: "beta.io", fullName: "Sam Lee", title: "VP" }], source: "leadsforge", idempotencyKey: "c4", fill: "missing" });
    const sams = (await ws.post("contacts/list", { filter: { q: "sam lee" } })).json.rows;
    assert.equal(sams.length, 3, "ambiguous: kept apart");
    assert.ok(sams.every((r: any) => !r.linkedinUrl || r.title !== "VP"), "the name-only VP attached to neither Sam");

    // Name-only Sam, enriched with sam-a's LinkedIn; then another Sam (sam-b): a later
    // name-only record identifies neither, whichever kept the name-derived id.
    await ws.post("contacts/upsert", { records: [{ accountDomain: "acme.com", fullName: "Sam Kim" }], source: "leadsforge", idempotencyKey: "k1", fill: "missing" });
    await ws.post("contacts/upsert", { records: [{ accountDomain: "acme.com", fullName: "Sam Kim", linkedinUrl: "https://linkedin.com/in/sam-a" }], source: "quickenrich", idempotencyKey: "k2", fill: "missing" });
    await ws.post("contacts/upsert", { records: [{ accountDomain: "acme.com", fullName: "Sam Kim", linkedinUrl: "https://linkedin.com/in/sam-b" }], source: "quickenrich", idempotencyKey: "k3", fill: "missing" });
    await ws.post("contacts/upsert", { records: [{ accountDomain: "acme.com", fullName: "Sam Kim", title: "VP" }], source: "leadsforge", idempotencyKey: "k4", fill: "missing" });
    const kims = (await ws.post("contacts/list", { filter: { q: "sam kim" } })).json.rows;
    assert.ok(kims.filter((r: any) => r.linkedinUrl).every((r: any) => r.title !== "VP"), "the VP title went to neither identified Sam");
    // Re-importing the same name-only record converges on the one unidentified Sam.
    for (const k of ["k5", "k6"]) {
      await ws.post("contacts/upsert", { records: [{ accountDomain: "acme.com", fullName: "Sam Kim", title: "VP" }], source: "leadsforge", idempotencyKey: k, fill: "missing" });
    }
    assert.equal((await ws.post("contacts/list", { filter: { q: "sam kim" } })).json.rows.length, kims.length, "no new duplicates");

    // Within one batch, in either order: one person.
    await ws.post("accounts/upsert", { records: [{ domain: "gamma.io", name: "Gamma" }], source: "t", idempotencyKey: "g3" });
    for (const [i, records] of [
      [{ accountDomain: "gamma.io", fullName: "Ada Byron", linkedinUrl: "https://linkedin.com/in/ada-b" }, { accountDomain: "gamma.io", fullName: "Ada Byron", title: "CEO" }],
      [{ accountDomain: "gamma.io", fullName: "Alan Kay", title: "CTO" }, { accountDomain: "gamma.io", fullName: "Alan Kay", linkedinUrl: "https://linkedin.com/in/alan" }],
    ].entries()) {
      await ws.post("contacts/upsert", { records, source: "mixed", idempotencyKey: `b${i}`, fill: "missing" });
    }
    const gamma = (await ws.post("contacts/list", {})).json.rows.filter((r: any) => r.fullName === "Ada Byron" || r.fullName === "Alan Kay");
    assert.equal(gamma.length, 2, "one contact per person whatever the order inside the batch");

    // A rename earlier in the batch leaves the old name's key: a name-only record
    // for the old name is a new person, not the renamed one.
    await ws.post("contacts/upsert", { records: [{ accountDomain: "gamma.io", fullName: "Alice Liddell", linkedinUrl: "https://linkedin.com/in/al" }], source: "crm", idempotencyKey: "r1" });
    await ws.post("contacts/upsert", { records: [
      { accountDomain: "gamma.io", fullName: "Bob Liddell", linkedinUrl: "https://linkedin.com/in/al" },
      { accountDomain: "gamma.io", fullName: "Alice Liddell", title: "CFO" },
    ], source: "crm", idempotencyKey: "r2" });
    const lid = (await ws.post("contacts/list", { filter: { q: "liddell" } })).json.rows;
    assert.deepEqual(lid.map((r: any) => [r.fullName, r.linkedinUrl ?? null]).sort(), [["Alice Liddell", null], ["Bob Liddell", "https://linkedin.com/in/al"]]);

    // A rep found the name-only contact's email; the LinkedIn record still attaches to it.
    await ws.post("contacts/upsert", { records: [{ accountDomain: "gamma.io", fullName: "Edsger Dijkstra", email: "ed@gamma.io" }], source: "rep", idempotencyKey: "m1" });
    await ws.post("contacts/upsert", { records: [{ accountDomain: "gamma.io", fullName: "Edsger Dijkstra", linkedinUrl: "https://linkedin.com/in/ewd" }], source: "quickenrich", idempotencyKey: "m2", fill: "missing" });
    const ewd = (await ws.post("contacts/list", { filter: { q: "dijkstra" } })).json.rows;
    assert.deepEqual(ewd.map((r: any) => [r.email, r.linkedinUrl]), [["ed@gamma.io", "https://linkedin.com/in/ewd"]]);

    // Fill-only never moves an existing contact to another account.
    await ws.post("contacts/upsert", { records: [{ accountDomain: "acme.com", fullName: "Grace Hopper", linkedinUrl: "https://linkedin.com/in/grace" }], source: "quickenrich", idempotencyKey: "c5", fill: "missing" });
    await ws.post("contacts/upsert", { records: [{ accountDomain: "beta.io", fullName: "Grace Hopper", linkedinUrl: "https://linkedin.com/in/grace" }], source: "quickenrich", idempotencyKey: "c6", fill: "missing" });
    const acme = (await ws.post("accounts/list", { filter: { q: "acme" } })).json.rows[0].id;
    const graceNow = (await ws.post("contacts/list", { filter: { q: "grace" } })).json.rows;
    assert.deepEqual(graceNow.map((r: any) => r.accountId), [acme]);
  });

  it("edit is idempotent, versions, writes history, and shows in the 360 view", async () => {
    const ws = ctx.client.ws("edit");
    await ws.post("provision");
    const up = await ws.post("accounts/upsert", { records: [{ domain: "https://www.Acme.com/", name: "Acme" }], source: "t", idempotencyKey: "a" });
    const id = up.json.ids[0];
    const cu = await ws.post("contacts/upsert", {
      records: [{ accountDomain: "acme.com", fullName: "Ada Lovelace", email: "ADA@acme.com", title: "CTO" }, { accountId: id, fullName: "Bob" }],
      source: "t", idempotencyKey: "c",
    });
    assert.equal(cu.status, 200, JSON.stringify(cu.json));
    const unknown = await ws.post("contacts/upsert", { records: [{ accountDomain: "nope.com", fullName: "X" }], source: "t", idempotencyKey: "c2" });
    assert.equal(unknown.status, 400);

    const cl = await ws.post("contacts/list", { limit: 1 });
    assert.equal(cl.status, 200, JSON.stringify(cl.json));
    assert.equal(cl.json.total, 2);
    assert.equal(cl.json.rows.length, 1);
    assert.ok(cl.json.nextCursor);
    const byQ = await ws.post("contacts/list", { filter: { accountId: id, q: "cto" } });
    assert.deepEqual(byQ.json.rows.map((c: any) => c.fullName), ["Ada Lovelace"]);
    assert.equal((await ws.post("contacts/list", { filter: { accountId: "acc_none" } })).json.total, 0);

    const body ={ object: "account", id, patch: { status: "working", ownerId: "u1" }, actorId: "user-1", idempotencyKey: "e1", sourceTimestamp: 1_700_000_000_000 };
    const e1 = await ws.post("records/edit", body);
    assert.equal(e1.json.version, 2);
    const e2 = await ws.post("records/edit", { ...body, patch: { status: "qualified" }, idempotencyKey: "e2", sourceTimestamp: 1_700_000_000_500 });
    assert.equal(e2.json.version, 3);
    assert.ok(e2.json.at > e1.json.at);
    const e1again = await ws.post("records/edit", { ...body, sourceTimestamp: 1_700_000_000_900 });
    assert.deepEqual(e1again.json, e1.json, "a replayed key answers with its first version and time, and does not re-apply");
    const missing = await ws.post("records/edit", { ...body, id: "acc_missing", idempotencyKey: "e3" });
    assert.equal(missing.status, 404);

    const g = await ws.post("accounts/get", { id });
    assert.equal(g.status, 200);
    assert.equal(g.json.account.domain, "acme.com");
    assert.equal(g.json.account.status, "qualified");
    assert.equal(g.json.account.version, 3);
    assert.equal(g.json.contacts.length, 2);
    assert.equal(g.json.contacts.find((c: any) => c.fullName === "Ada Lovelace").email, "ada@acme.com");
    const statusHist = g.json.history.filter((h: any) => h.field === "status");
    assert.deepEqual(statusHist.map((h: any) => [h.oldValue, h.newValue]), [["working", "qualified"], ["new", "working"]]);
    assert.equal((await ws.post("accounts/get", { id: "acc_nope" })).status, 404);

    const ada = g.json.contacts.find((c: any) => c.fullName === "Ada Lovelace");
    const cg = await ws.post("contacts/get", { id: ada.id });
    assert.equal(cg.status, 200, JSON.stringify(cg.json));
    assert.deepEqual([cg.json.contact.id, cg.json.contact.fullName, cg.json.contact.email, cg.json.contact.title], [ada.id, "Ada Lovelace", "ada@acme.com", "CTO"]);
    assert.equal((await ws.post("contacts/get", { id: "con_nope" })).status, 404);
  });

  it("outbox is ordered, paginates with after/lastSeq, and includes every write", async () => {
    const ws = ctx.client.ws("outbox");
    await ws.post("provision");
    const up = await ws.post("accounts/upsert", { records: fixtureAccounts(30), source: "t", idempotencyKey: "o1" });
    // concurrent edits are group-committed; each still gets its own change row
    await Promise.all(up.json.ids.slice(0, 20).map((id: string, i: number) =>
      ws.post("records/edit", { object: "account", id, patch: { ownerId: `o${i}` }, actorId: "a", idempotencyKey: `oe${i}` })));
    assert.equal((await ws.post("rescore", { icp: ICP, version: 2 })).status, 200);
    const all: any[] = [];
    let afterSeq = 0;
    for (;;) {
      const r = await ws.get(`changes?after=${afterSeq}&limit=7`);
      assert.equal(r.status, 200);
      if (!r.json.changes.length) {
        assert.equal(r.json.lastSeq, afterSeq);
        break;
      }
      all.push(...r.json.changes);
      afterSeq = r.json.lastSeq;
    }
    assert.equal(all.length, 30 + 20 + 1);
    const seqs = all.map((c) => c.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    assert.equal(new Set(seqs).size, seqs.length);
    assert.deepEqual(all.slice(0, 30).map((c) => c.op), Array(30).fill("upsert"));
    assert.deepEqual(all.slice(30, 50).map((c) => c.op), Array(20).fill("edit"));
    assert.equal(all.at(-1).op, "rescore");
    assert.deepEqual(all[30].fields, ["ownerId"]);
    assert.equal(all[30].origin, "fsgtm");
    assert.equal(all[0].origin, "t");
    assert.equal((await ws.get("changes?after=-1")).status, 400);
  });

  it("records/edit: `at` follows the order the service committed edits, not the callers' timestamps", async () => {
    const ws = ctx.client.ws("edit-order");
    await ws.post("provision");
    const id = (await ws.post("accounts/upsert", { records: fixtureAccounts(1), source: "t", idempotencyKey: "u" })).json.ids[0];
    const edit = (industry: string, idempotencyKey: string, sourceTimestamp?: number) =>
      ws.post("records/edit", { object: "account", id, patch: { industry }, actorId: "u1", idempotencyKey, ...(sourceTimestamp ? { sourceTimestamp } : {}) });
    // B was stamped later by its caller but committed first; A commits second, so A's value is the row's.
    const b = await edit("Edit B", "kB", 1_700_000_000_101);
    const a = await edit("Edit A", "kA", 1_700_000_000_100);
    assert.equal((await ws.post("accounts/get", { id })).json.account.industry, "Edit A");
    assert.ok(a.json.at > b.json.at, `A committed after B, so its at (${a.json.at}) is after B's (${b.json.at})`);
    assert.equal((await edit("Edit A", "kA", 1_700_000_000_999)).json.at, a.json.at, "a replay answers with the first at");

    const many = await Promise.all(Array.from({ length: 20 }, (_, i) => edit(`Concurrent ${i}`, `c${i}`)));
    const byVersion = many.map((r) => r.json).sort((x, y) => x.version - y.version);
    for (let i = 1; i < byVersion.length; i++) assert.ok(byVersion[i].at > byVersion[i - 1].at, `version ${byVersion[i].version} has a later at than ${byVersion[i - 1].version}`);
  });

  it("records/edit: `at` keeps increasing across a restart even when the clock goes back", async () => {
    const dataDir = tempDir();
    const first = await startApp({ dataDir });
    const body = (idempotencyKey: string) => ({ object: "account", patch: { status: "working" }, actorId: "u", idempotencyKey });
    let id = "";
    let before = 0;
    try {
      const ws = first.client.ws("clock");
      await ws.post("provision");
      id = (await ws.post("accounts/upsert", { records: fixtureAccounts(1), source: "t", idempotencyKey: "u" })).json.ids[0];
      before = (await ws.post("records/edit", { ...body("k1"), id })).json.at;
    } finally {
      await first.app.shutdown();
    }
    const realNow = Date.now;
    Date.now = () => before - 60_000;
    const second = await startApp({ dataDir });
    try {
      const after = await second.client.ws("clock").post("records/edit", { ...body("k2"), id, patch: { status: "qualified" } });
      assert.ok(after.json.at > before, `at after restart (${after.json.at}) is after the last one (${before})`);
    } finally {
      Date.now = realNow;
      await second.app.shutdown();
    }
  });

  it("records/edit: reusing an idempotency key with a different patch is a 409 and applies nothing", async () => {
    const ws = ctx.client.ws("edit-key-reuse");
    await ws.post("provision");
    const id = (await ws.post("accounts/upsert", { records: fixtureAccounts(1), source: "t", idempotencyKey: "u" })).json.ids[0];
    const body = { object: "account", id, patch: { industry: "Edit A" }, actorId: "u1", idempotencyKey: "k" };
    const first = await ws.post("records/edit", body);
    assert.equal(first.status, 200);
    const reused = await ws.post("records/edit", { ...body, patch: { industry: "Edit B" } });
    assert.equal(reused.status, 409);
    assert.match(reused.json.error, /idempotency key k was already used for a different request/);
    assert.equal((await ws.post("accounts/get", { id })).json.account.industry, "Edit A");
    const retried = await ws.post("records/edit", { ...body, sourceTimestamp: 1_700_000_000_000 });
    assert.deepEqual(retried.json, first.json, "a retry of the same edit, re-stamped by its caller, is still a replay");
  });

  it("rescore recomputes fit for every account", async () => {
    const ws = ctx.client.ws("rescore");
    await ws.post("provision");
    await ws.post("accounts/upsert", { records: fixtureAccounts(100), source: "t", idempotencyKey: "r" });
    const r = await ws.post("rescore", { icp: { base: 0, industries: { retail: 100 } } });
    assert.equal(r.json.rescored, 100);
    assert.equal((await ws.post("segments/count", { filter: { minFit: 100 } })).json.total, 20);
  });

  it("rescore atomically keeps the newest configuration and treats an acknowledged version as idempotent", async () => {
    const ws = ctx.client.ws("fit-versions");
    await ws.post("provision");
    await ws.post("accounts/upsert", { records: [{ domain: "fit.example", name: "Fit" }], source: "fixture", idempotencyKey: "fit" });
    const versioned = (version: number, base: number) => ws.post("rescore", { version, icp: { base } });
    const responses = await Promise.all([versioned(3, 70), versioned(2, 20)]);
    assert.equal(responses[0].status, 200);
    assert.ok([200, 409].includes(responses[1].status));
    assert.equal((await versioned(1, 10)).status, 409);
    assert.equal((await ws.post("rescore", { icp: { base: 10 } })).status, 409);
    assert.equal((await versioned(3, 10)).json.rescored, 0);
    const rows = await ws.post("accounts/list", {});
    assert.deepEqual(rows.json.rows.map((r: { fit: number }) => r.fit), [70]);
    const events = await ws.get("changes?after=0&limit=20");
    assert.equal(events.json.changes.filter((c: { op: string }) => c.op === "rescore").at(-1).values.version, 3);
  });

  it("LRU closes idle workspaces and reopens them transparently", async () => {
    const small = await startApp({ maxOpen: 2 });
    try {
      for (const id of ["l1", "l2", "l3", "l4"]) {
        const ws = small.client.ws(id);
        await ws.post("provision");
        await ws.post("accounts/upsert", { records: fixtureAccounts(3, id.length), source: "t", idempotencyKey: id });
      }
      assert.ok(small.app.registry.openCount <= 2);
      for (const id of ["l1", "l2", "l3", "l4"]) assert.equal((await small.client.ws(id).post("segments/count", { filter: {} })).json.total, 3);
    } finally {
      await small.app.shutdown();
    }
  });

  it("PDL search returns 503 until the index is loaded", async () => {
    const r = await ctx.client.call("POST", "/v1/shared/prospects/search", { limit: 5 });
    assert.equal(r.status, 503);
  });
});
