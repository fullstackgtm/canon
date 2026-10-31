import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { startApp, tempDir } from "./helpers.ts";

const gate = (id: string, over: Record<string, unknown> = {}) => ({
  id, base: 10, max: 75, industries: {}, countries: {}, employees: [], excludeIndustries: [], excludeCountries: [], custom: [], ...over,
});

// SaaS in the US, 51-500 people, excluding staffing; and UK banks (only those an AI field calls "regulated").
const SAAS = gate("saas", { industries: { software: 40 }, countries: { "united states": 25 }, employees: [{ min: 51, max: 500, weight: 25 }], max: 100 });
const BANKS = gate("banks", { industries: { banking: 40 }, countries: { "united kingdom": 25 }, max: 75, custom: [{ key: "custom.regulated", values: ["yes"] }] });

const ACCOUNTS = [
  { domain: "saas.example.com", name: "Saas", industry: "Software", country: "United States", employees: 200 },
  // One ICP's industry with the other's country: in neither.
  { domain: "mixed.example.com", name: "Mixed", industry: "Software", country: "United Kingdom", employees: 200 },
  { domain: "nosize.example.com", name: "No size", industry: "Software", country: "United States" },
  { domain: "bank.example.com", name: "Bank", industry: "Banking", country: "United Kingdom" },
  { domain: "bank2.example.com", name: "Bank 2", industry: "Banking", country: "United Kingdom" },
];

describe("ICP gates (contract 1.14.0)", () => {
  it("scores each account inside the ICPs it passes as a whole, and 0 outside them", async () => {
    const dataDir = tempDir("rs-gates-");
    let { app, client } = await startApp({ dataDir });
    let ws = client.ws("gates");
    try {
      await ws.post("provision");
      await ws.post("accounts/upsert", { records: ACCOUNTS, source: "t", idempotencyKey: "g" });
    } finally {
      await app.shutdown();
    }
    // An accepted AI-field answer, as the register writes it back from the ledger.
    const db = await DuckDBInstance.create(join(dataDir, "ws", "gates.duckdb"));
    const c = await db.connect();
    await c.run(`UPDATE accounts SET custom = '{"custom.regulated":"Yes"}' WHERE domain = 'bank.example.com'`);
    c.closeSync();
    db.closeSync();

    ({ app, client } = await startApp({ dataDir }));
    ws = client.ws("gates");
    try {
      assert.equal((await ws.post("rescore", { icp: {}, version: 2, gates: [SAAS, BANKS] })).status, 200);
      const rows = (await ws.post("accounts/list", { limit: 10 })).json.rows as Array<{ domain: string; fit: number; icpIds: string[] }>;
      const by = Object.fromEntries(rows.map((r) => [r.domain, { fit: r.fit, icpIds: r.icpIds }]));
      assert.deepEqual(by["saas.example.com"], { fit: 100, icpIds: ["saas"] });
      assert.deepEqual(by["mixed.example.com"], { fit: 0, icpIds: [] });
      assert.deepEqual(by["nosize.example.com"], { fit: 0, icpIds: [] }, "an unknown size fails a size criterion");
      assert.deepEqual(by["bank.example.com"], { fit: 100, icpIds: ["banks"] });
      assert.deepEqual(by["bank2.example.com"], { fit: 0, icpIds: [] }, "an unanswered AI field fails its criterion");

      const histogram = await ws.post("register/account/aggregate", { groupBy: [{ field: "fit" }], measures: [{ fn: "count" }] });
      assert.equal(histogram.status, 200);
      assert.deepEqual(histogram.json.groups, [{ keys: [0], values: [3] }, { keys: [100], values: [2] }]);
      assert.equal(histogram.json.truncated, false);
      assert.deepEqual((await ws.post("register/account/aggregate", {
        groupBy: [{ field: "fit" }], measures: [{ fn: "count" }], scope: { field: "ownerId", owners: [], unowned: false },
      })).json.groups, []);

      assert.equal((await ws.post("segments/count", { filter: { icpId: "saas" } })).json.total, 1);
      // 1.21.0: AI-field answers as a treemap level and a filter.
      const byField = Object.fromEntries((await ws.post("accounts/facets", { groupBy: "field:regulated" })).json.groups.map((g: { key: string; count: number }) => [g.key, g.count]));
      assert.deepEqual(byField, { yes: 1, __none__: 4 });
      assert.equal((await ws.post("segments/count", { filter: { custom: { regulated: ["Yes"] } } })).json.total, 1);
      assert.equal((await ws.post("segments/count", { filter: { custom: { regulated: ["__none__"] } } })).json.total, 4);

      // 1.15.0: a contact lists, filters and sorts by its account's fit and ICPs; so does an account by its ICPs.
      await ws.post("contacts/upsert", { records: [
        { accountDomain: "saas.example.com", fullName: "Sam Saas", email: "sam@saas.example.com" },
        { accountDomain: "mixed.example.com", fullName: "Mo Mixed", email: "mo@mixed.example.com" },
      ], source: "t", idempotencyKey: "gc" });
      const contacts = async (body: unknown) => ((await ws.post("register/contact/list", body)).json.rows as Array<{ title: string; values: Record<string, unknown> }>)
        .map((r) => [r.title, r.values.accountFit, r.values.accountIcpIds]);
      assert.deepEqual(await contacts({ filter: [{ field: "accountIcpIds", op: "hasAny", value: ["saas"] }] }), [["Sam Saas", 100, ["saas"]]]);
      assert.deepEqual(await contacts({ sort: { field: "accountFit", dir: "asc" } }), [["Mo Mixed", 0, null], ["Sam Saas", 100, ["saas"]]]);
      const inBanks = (await ws.post("register/account/list", { filter: [{ field: "icpIds", op: "hasAny", value: ["banks"] }] })).json.rows as Array<{ title: string }>;
      assert.deepEqual(inBanks.map((r) => r.title), ["Bank"]);
      const stats = (await ws.post("icp-stats")).json;
      assert.deepEqual(stats.gates, [{ id: "banks", members: 1, unverified: 1 }, { id: "saas", members: 1, unverified: 1 }]);

      // Exclusions apply inside their own ICP; an edit moves the account out at once.
      assert.equal((await ws.post("rescore", { icp: {}, version: 3, gates: [{ ...SAAS, excludeCountries: ["united states"] }, BANKS] })).status, 200);
      assert.deepEqual((await ws.post("segments/count", { filter: { icpId: "saas" } })).json.total, 0);

      // Without gates, the legacy weights score again and memberships clear.
      assert.equal((await ws.post("rescore", { icp: { base: 0, industries: { software: 100 } }, version: 4 })).status, 200);
      const legacy = (await ws.post("accounts/list", { limit: 10 })).json.rows as Array<{ domain: string; fit: number; icpIds: string[] }>;
      assert.equal(legacy.find((r) => r.domain === "mixed.example.com")?.fit, 100);
      assert.ok(legacy.every((r) => r.icpIds.length === 0));
    } finally {
      await app.shutdown();
    }
  });
});

describe("canonical industries (contract 1.17.0)", () => {
  it("groups, filters and gates every source's spelling of an industry as one, and keeps unmapped values apart", async () => {
    const { app, client } = await startApp({ dataDir: tempDir("rs-ind-") });
    const ws = client.ws("ind");
    try {
      await ws.post("provision");
      await ws.post("accounts/upsert", {
        source: "t", idempotencyKey: "i",
        records: [
          { domain: "pdl.example.com", name: "PDL", industry: "computer software" }, // PDL / LinkedIn's earlier name
          { domain: "qe.example.com", name: "QE", industry: "Software Development" }, // QuickEnrich
          { domain: "hs.example.com", name: "HubSpot", industry: "COMPUTER_SOFTWARE" }, // HubSpot enum
          { domain: "it.example.com", name: "IT", industry: "IT Services and IT Consulting" },
          { domain: "mc.example.com", name: "MC", industry: "management consulting" },
          { domain: "odd.example.com", name: "Odd", industry: "Quantum Widgets" },
        ],
      });
      const groups = Object.fromEntries((await ws.post("accounts/facets", { groupBy: "industry" })).json.groups.map((g: { key: string; count: number }) => [g.key, g.count]));
      assert.deepEqual(groups, { "software development": 3, "it services and it consulting": 1, "business consulting and services": 1, "~quantum widgets": 1 });
      assert.equal((await ws.post("segments/count", { filter: { industry: ["software development"] } })).json.total, 3);
      assert.equal((await ws.post("segments/count", { filter: { industry: ["computer software"] } })).json.total, 3, "any spelling filters the same accounts");
      assert.equal((await ws.post("segments/count", { filter: { industry: ["~quantum widgets"] } })).json.total, 1);
      // An ICP for IT services lights IT services only: no loose rule pulls in management consulting.
      await ws.post("rescore", { icp: {}, gates: [gate("it", { industries: { "it services and it consulting": 40 }, max: 50 })] });
      assert.equal((await ws.post("segments/count", { filter: { icpId: "it" } })).json.total, 1);
      await ws.post("rescore", { icp: {}, gates: [gate("sw", { industries: { "computer software": 40 }, max: 50 })] });
      assert.equal((await ws.post("segments/count", { filter: { icpId: "sw" } })).json.total, 3, "a gate written in an earlier spelling is re-keyed");
    } finally {
      await app.shutdown();
    }
  });

});

describe("ICP buyers (contract 1.30.0)", () => {
  it("with a buyer, admits only accounts where someone with a matching title works (1.30.0)", async () => {
    const { app, client } = await startApp({ dataDir: tempDir("rs-buyer-") });
    const ws = client.ws("buyer");
    try {
      await ws.post("provision");
      await ws.post("accounts/upsert", { records: [
        { domain: "revops.example.com", name: "RevOps Co", industry: "Software", country: "United States", employees: 120 },
        { domain: "sales.example.com", name: "Sales Co", industry: "Software", country: "United States", employees: 120 },
        { domain: "empty.example.com", name: "Empty Co", industry: "Software", country: "United States", employees: 120 },
      ], source: "t", idempotencyKey: "a" });
      await ws.post("contacts/upsert", { records: [
        { accountDomain: "revops.example.com", fullName: "Ada", title: "VP RevOps" },
        { accountDomain: "sales.example.com", fullName: "Bo", title: "Director of Sales" },
        { accountDomain: "sales.example.com", fullName: "Vi", title: "VP of Sales" },
        { accountDomain: "sales.example.com", fullName: "Cy", title: "Revenue Operations Intern" },
      ], source: "t", idempotencyKey: "c" });
      // VP or Head of RevOps, or anyone titled "head of sales"; interns never count.
      const buyer = { levels: ["vp", "head"], departments: ["revenue operations"], topics: ["revenue operations"], titles: ["head of sales"], exclude: ["intern"] };
      await ws.post("rescore", { icp: {}, version: 1, gates: [{ ...SAAS, buyer }] });
      const fits = async () => Object.fromEntries(((await ws.post("accounts/list", { limit: 10 })).json.rows as Array<{ domain: string; icpIds: string[] }>).map((r) => [r.domain, r.icpIds]));
      assert.deepEqual(await fits(), { "revops.example.com": ["saas"], "sales.example.com": [], "empty.example.com": [] });
      assert.deepEqual((await ws.post("icp-stats")).json.gates, [{ id: "saas", members: 1, unverified: 2 }], "the company fits but no buyer is there yet");
      // A buyer joining an account brings it in, without a rescore.
      await ws.post("contacts/upsert", { records: [{ accountDomain: "sales.example.com", fullName: "Di", title: "Head of Sales", email: "di@x.io" }], source: "t", idempotencyKey: "c2" });
      assert.deepEqual((await fits())["sales.example.com"], ["saas"]);
      // Moving the only buyer takes the company they left out, and brings the one they joined in.
      await ws.post("contacts/upsert", { records: [{ accountDomain: "empty.example.com", fullName: "Di", title: "Head of Sales", email: "di@x.io" }], source: "t", idempotencyKey: "c3" });
      const moved = await fits();
      assert.deepEqual([moved["sales.example.com"], moved["empty.example.com"]], [[], ["saas"]]);
    } finally {
      await app.shutdown();
    }
  });
});
