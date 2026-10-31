import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { startSfSim, type ObjectDef, type SfSim } from "../src/index.ts";
import { parseSoql, runQuery } from "../src/soql.ts";
import {
  bulkIngest, bulkQuery, describeGlobal, describeSObject, patchRecord, patchRecords, SalesforceApiError, soql, type SfConn,
} from "../../../engine/src/connectors/salesforce/client.ts";
import { defaultSyncAuthority, importMetadataCore, objectDef } from "../../../engine/src/connectors/salesforce/metadata.ts";

const CUSTOM: ObjectDef[] = [
  {
    name: "Project__c", label: "Project",
    fields: [
      { name: "Budget__c", type: "number" }, { name: "Active__c", type: "boolean" }, { name: "Kickoff__c", type: "date" },
      { name: "Phase__c", type: "picklist" }, { name: "Account__c", type: "reference", referenceTo: ["Account"] }, { name: "Fit_Score__c", type: "number" },
    ],
  },
  { name: "Renewal__c", label: "Renewal", fields: [{ name: "Due__c", type: "datetime" }, { name: "Notes__c", type: "json" }] },
];

function conn(sim: SfSim): SfConn & { refreshes: number } {
  const c = {
    instanceUrl: sim.baseUrl,
    apiVersion: sim.apiVersion,
    refreshes: 0,
    tok: sim.token,
    async getToken() {
      return c.tok;
    },
    async refreshToken() {
      c.refreshes++;
      const r = await fetch(`${sim.baseUrl}/services/oauth2/token`, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: sim.refreshToken }).toString(),
      });
      c.tok = (await r.json()).access_token;
      return c.tok;
    },
  };
  return c;
}

describe("SOQL subset", () => {
  const recs = [
    { Id: "1", Name: "Acme", N: 5, D: "2026-01-02T00:00:00.000+0000", B: true },
    { Id: "2", Name: "beta", N: 10, D: "2026-03-02T00:00:00.000+0000", B: false },
    { Id: "3", Name: "Gamma", N: null, D: "2025-01-02T00:00:00.000+0000", B: false },
  ];
  const canon = (f: string) => {
    const k = Object.keys(recs[0]).find((x) => x.toLowerCase() === f.toLowerCase());
    if (!k) throw new Error(`INVALID_FIELD ${f}`);
    return k;
  };
  const ids = (q: string) => runQuery(parseSoql(q), recs, canon).rows.map((r) => r.Id);
  it("filters, orders and limits", () => {
    assert.deepEqual(ids("SELECT Id FROM X WHERE N > 4 ORDER BY N DESC"), ["2", "1"]);
    assert.deepEqual(ids("SELECT Id FROM X WHERE D >= 2026-01-01T00:00:00Z"), ["1", "2"]);
    assert.deepEqual(ids("SELECT Id FROM X WHERE Name LIKE 'a%' OR Name = 'BETA'"), ["1", "2"]);
    assert.deepEqual(ids("SELECT Id FROM X WHERE (N = null OR B = true) AND Name != 'acme'"), ["3"]);
    assert.deepEqual(ids("SELECT Id FROM X WHERE Id IN ('1','3') ORDER BY Name LIMIT 1"), ["1"]);
    assert.deepEqual(ids("SELECT Id FROM X WHERE Id NOT IN ('1') LIMIT 5 OFFSET 1"), ["3"]);
    assert.equal(parseSoql("SELECT COUNT() FROM Account WHERE Name LIKE 'FSGTMSYNC %'").count, true);
    assert.throws(() => parseSoql("SELECT Id FROM X WHERE N ~ 3"), /unsupported operator|unexpected token/);
    assert.throws(() => ids("SELECT Nope FROM X"), /INVALID_FIELD/);
  });
});

describe("sf-sim + client", () => {
  let sim: SfSim;
  before(async () => {
    sim = await startSfSim({ seed: 7, accounts: 300, contacts: 900, customObjects: CUSTOM, customRecords: 40 });
  });
  after(async () => {
    await sim.stop();
  });

  it("serves describeGlobal and describe, including custom objects and non-queryable entities", async () => {
    const c = conn(sim);
    const all = await describeGlobal(c);
    assert.ok(all.some((o) => o.name === "Project__c" && o.custom && o.queryable));
    assert.ok(all.some((o) => o.name === "AccountChangeEvent" && !o.queryable));
    const acc = await describeSObject(c, "Account");
    assert.ok(acc.fields.find((f) => f.name === "Industry")!.picklistValues!.length > 0);
    assert.equal(acc.fields.find((f) => f.name === "Id")!.updateable, false);
    await assert.rejects(describeSObject(c, "Nope__c"), (e: SalesforceApiError) => e.status === 404 && e.errorCode === "NOT_FOUND");
  });

  it("pages REST queries (2000/page) and counts", async () => {
    const c = conn(sim);
    const r = await soql<{ Id: string; Email: string | null }>(c, "SELECT Id, Email FROM Contact");
    assert.equal(r.records.length, 900);
    assert.equal(r.totalSize, 900);
    const n = await soql(c, "SELECT COUNT() FROM Account");
    assert.equal(n.totalSize, 300);
    const big = await startSfSim({ seed: 1, accounts: 4500, contacts: 0 });
    try {
      const b = await soql(conn(big), "SELECT Id FROM Account");
      assert.equal(b.records.length, 4500);
      assert.equal(big.calls().filter((x) => x.path.includes("/query")).length, 3, "3 pages of 2000");
    } finally {
      await big.stop();
    }
  });

  it("refreshes the token once on 401 and retries", async () => {
    const c = conn(sim);
    sim.expireToken();
    const r = await soql(c, "SELECT Id FROM User");
    assert.equal(r.records.length, 5);
    assert.equal(c.refreshes, 1);
  });

  it("PATCH and composite writes update records, count as writes and emit change events", async () => {
    const c = conn(sim);
    const [acc] = sim.records("Account");
    const modstamp0 = String(acc.SystemModstamp);
    const before = sim.writeCount();
    const replay = sim.cdcEvents().length;
    await patchRecord(c, "Account", String(acc.Id), { Industry: acc.Industry === "Energy" ? "Media" : "Energy", Description: "fsgtm-sync-test" });
    assert.equal(sim.get("Account", String(acc.Id))!.Description, "fsgtm-sync-test");
    const ids = sim.records("Contact").slice(0, 3).map((r) => String(r.Id));
    const res = await patchRecords(c, "Contact", [...ids.map((id) => ({ id, fields: { Title: "Chief Sim" } })), { id: ids[0], fields: { Bogus__c: 1 } }]);
    assert.deepEqual(res.map((r) => r.success), [true, true, true, false]);
    assert.equal(res[3].errors[0].statusCode, "INVALID_FIELD");
    await assert.rejects(patchRecord(c, "Account", String(acc.Id), { Id: "x", CreatedDate: "2020-01-01" }), /INVALID_FIELD_FOR_INSERT_UPDATE/);
    assert.equal(sim.writeCount() - before, 3);
    const ev = sim.cdcEvents().slice(replay);
    assert.equal(ev.length, 4);
    assert.deepEqual(ev[0].payload.ChangeEventHeader.changedFields.sort(), ["Description", "Industry", "LastModifiedDate"]);
    assert.equal(ev[0].payload.ChangeEventHeader.changeType, "UPDATE");
    assert.match(ev[0].payload.ChangeEventHeader.changeOrigin, /api\/rest/);
    // A Salesforce-side edit emits an event but is not an API write.
    const w = sim.writeCount();
    sim.edit("Account", String(acc.Id), { Name: "Edited In SF" });
    assert.equal(sim.writeCount(), w);
    const cdc = await (await fetch(`${sim.baseUrl}/sim/cdc?replayId=${replay + 4}`)).json();
    assert.equal(cdc.events.length, 1);
    assert.equal(cdc.events[0].payload.Name, "Edited In SF");
    assert.equal(cdc.latestReplayId, replay + 5);
    // SystemModstamp polling sees the edit.
    const since = modstamp0.replace("+0000", "Z");
    const polled = await soql(c, `SELECT Id, Name FROM Account WHERE SystemModstamp > ${since}`);
    assert.ok(polled.records.some((r) => r.Id === acc.Id));
  });

  it("Bulk 2.0 query pages CSV via locators and ingest reports per-row results", async () => {
    const c = { ...conn(sim), maxRetries: 2 };
    const pages: number[] = [];
    let rows = 0;
    for await (const page of bulkQuery(c, "SELECT Id, Name, Website, NumberOfEmployees FROM Account", { pollIntervalMs: 1, maxRecords: 128 })) {
      pages.push(page.length);
      rows += page.length;
      assert.equal(typeof page[0].NumberOfEmployees, "string");
    }
    assert.equal(rows, 300);
    assert.equal(pages.length, 3);
    const created = await bulkIngest(c, {
      object: "Account", operation: "insert", pollIntervalMs: 1,
      records: [{ Name: "FSGTMSYNC Bulk 1", Website: "bulk1.example.com", Description: "fsgtm-sync-test" }, { Name: "FSGTMSYNC Bulk 2", Description: 'quote "x", comma' }, { Website: "noname.example.com" }],
    });
    assert.equal(created.processed, 3);
    assert.equal(created.failed, 1);
    assert.match(created.failures[0].error, /REQUIRED_FIELD_MISSING/);
    const id = created.successes[1].id;
    assert.equal(sim.get("Account", id)!.Description, 'quote "x", comma');
    const upd = await bulkIngest(c, { object: "Account", operation: "update", pollIntervalMs: 1, records: [{ Id: id, Industry: "Energy", Description: null }] });
    assert.equal(upd.failed, 0);
    assert.equal(sim.get("Account", id)!.Industry, "Energy");
    assert.equal(sim.get("Account", id)!.Description, null);
    const del = await bulkIngest(c, { object: "Account", operation: "delete", pollIntervalMs: 1, records: created.successes.map((s) => ({ Id: s.id })) });
    assert.equal(del.processed, 2);
    assert.equal(sim.get("Account", id), undefined);
  });

  it("retries 503s under failRate and still returns complete results", async () => {
    const flaky = await startSfSim({ seed: 3, accounts: 500, contacts: 0, failRate: 0.3 });
    try {
      const c = { ...conn(flaky), maxRetries: 10 };
      let n = 0;
      for await (const p of bulkQuery(c, "SELECT Id FROM Account", { pollIntervalMs: 1, maxRecords: 100 })) n += p.length;
      assert.equal(n, 500);
      assert.ok(flaky.calls().some((x) => x.status === 503));
      assert.equal(flaky.writeCount(), 0, "a bulk query job is not a write");
    } finally {
      await flaky.stop();
    }
  });

  it("returns 404 for /sim/cdc when CDC is off (clients fall back to polling)", async () => {
    sim.setCdc(false);
    assert.equal((await fetch(`${sim.baseUrl}/sim/cdc?replayId=0`)).status, 404);
    sim.setCdc(true);
  });

  it("metadata import gives every field of every queryable object a syncAuthority", async () => {
    const c = conn(sim);
    const m = await importMetadataCore(c, { concurrency: 4 });
    const queryable = (await describeGlobal(c)).filter((o) => o.queryable).length;
    assert.equal(m.objects.length, queryable);
    assert.equal(m.failed.length, 0);
    assert.ok(m.fields.length > 100);
    for (const f of m.fields) assert.ok(["fsgtm", "salesforce", "newest", "review"].includes(f.syncAuthority), `${f.object}.${f.apiName}`);
    const get = (o: string, f: string) => m.fields.find((x) => x.object === o && x.apiName === f)!;
    assert.equal(get("Account", "OwnerId").syncAuthority, "salesforce");
    assert.equal(get("Account", "SystemModstamp").syncAuthority, "salesforce");
    assert.equal(get("Account", "BillingAddress").syncAuthority, "salesforce", "non-updateable");
    assert.equal(get("Lead", "Status").syncAuthority, "fsgtm");
    assert.equal(get("Project__c", "Fit_Score__c").syncAuthority, "fsgtm");
    assert.equal(get("Account", "Industry").syncAuthority, "newest");
    assert.equal(get("Account", "Website").mappedTo, "domain");
    assert.deepEqual(m.objects.filter((o) => o.syncEnabled).map((o) => o.apiName).sort(), ["Account", "Contact", "Lead", "Opportunity", "Project__c", "Renewal__c", "User"]);
    const def = objectDef(m.described.find((d) => d.name === "Project__c")!);
    assert.equal(def.fields.find((f) => f.name === "Budget__c")!.type, "number");
    assert.deepEqual(def.fields.find((f) => f.name === "Account__c")!.referenceTo, ["Account"]);
    assert.equal(defaultSyncAuthority("X__c", { name: "Formula__c", updateable: false, calculated: true }), "salesforce");
  });
});

describe("sf-sim at acceptance scale", () => {
  it("Bulk 2.0 retrieves all 10k accounts and 50k contacts, deterministically", async () => {
    const t0 = Date.now();
    const sim = await startSfSim({ seed: 42, accounts: 10_000, contacts: 50_000, customObjects: CUSTOM, customRecords: 2_000 });
    try {
      const c = conn(sim);
      const count = async (q: string) => {
        const ids = new Set<string>();
        for await (const p of bulkQuery(c, q, { pollIntervalMs: 1 })) for (const r of p) ids.add(r.Id);
        return ids;
      };
      const accounts = await count("SELECT Id, Name, Website, Industry, NumberOfEmployees, BillingCountry, OwnerId FROM Account");
      const contacts = await count("SELECT Id, AccountId, FirstName, LastName, Email, Title FROM Contact");
      const projects = await count("SELECT Id, Name, Budget__c, Account__c FROM Project__c");
      assert.equal(accounts.size, 10_000);
      assert.equal(contacts.size, 50_000);
      assert.equal(projects.size, 2_000);
      // Every contact id is a valid, unique 18-char id.
      for (const id of contacts) assert.equal(id.length, 18);
      // Same seed -> same data.
      const again = await startSfSim({ seed: 42, accounts: 10_000, contacts: 50_000 });
      try {
        assert.deepEqual(again.records("Contact").slice(0, 50).map((r) => [r.Id, r.Email]), sim.records("Contact").slice(0, 50).map((r) => [r.Id, r.Email]));
      } finally {
        await again.stop();
      }
      console.log(`# 10k/50k bulk retrieval: ${Date.now() - t0} ms, ${sim.calls().length} calls`);
    } finally {
      await sim.stop();
    }
  });
});
