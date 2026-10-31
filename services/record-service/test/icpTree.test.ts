import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { startApp, tempDir } from "./helpers.ts";

const person = (over: Record<string, unknown>) => ({ levels: [], departments: [], titles: [], exclude: [], ...over });

describe("ICP trees (contract 1.31.0)", () => {
  it("counts ICPs, segments and personas, and the accounts siblings share", async () => {
    const { app, client } = await startApp({ dataDir: tempDir("rs-tree-") });
    const ws = client.ws("tree");
    try {
      await ws.post("provision");
      await ws.post("accounts/upsert", { records: [
        { domain: "a.example.com", name: "A", industry: "Software", country: "United States", employees: 300 },
        { domain: "b.example.com", name: "B", industry: "Software", country: "United States", employees: 300 },
        { domain: "c.example.com", name: "C", industry: "Software", country: "United States", employees: 40 },
        { domain: "d.example.com", name: "D", industry: "Banking", country: "United States", employees: 300 },
      ], source: "t", idempotencyKey: "a" });
      await ws.post("contacts/upsert", { records: [
        { accountDomain: "a.example.com", fullName: "Ada", title: "VP RevOps" },
        { accountDomain: "a.example.com", fullName: "Al", title: "RevOps Manager" },
        { accountDomain: "a.example.com", fullName: "An", title: "Revenue Operations Manager" },
        { accountDomain: "b.example.com", fullName: "Bo", title: "VP of Sales" },
        { accountDomain: "b.example.com", fullName: "Bi", title: "Sales Ops Intern" },
        { accountDomain: "c.example.com", fullName: "Cy", title: "Head of Revenue Operations" },
      ], source: "t", idempotencyKey: "c" });
      const revops = person({ departments: ["revenue operations"], exclude: ["intern"] });
      const body = { nodes: [
        { id: "saas", account: { industries: ["software development"], countries: ["united states"] } },
        { id: "leader", parent: "saas", account: { employees: [{ min: 201, max: 1000 }] }, has: [{ person: person({ levels: ["vp", "head"], departments: ["revenue operations"] }) }] },
        { id: "managers", parent: "leader", person: person({ levels: ["manager"], departments: ["revenue operations"] }) },
        { id: "sales-led", parent: "saas", has: [{ person: person({ levels: ["vp"], departments: ["sales"] }) }, { neg: true, person: revops }] },
        { id: "banks", account: { industries: ["Banking"] } },
      ] };
      const res = await ws.post("icp-tree/counts", body);
      assert.equal(res.status, 200, JSON.stringify(res.json));
      const counts = Object.fromEntries((res.json.nodes as Array<{ id: string; accounts: number; people: number }>).map((n) => [n.id, [n.accounts, n.people]]));
      assert.deepEqual(counts, {
        saas: [3, 0],
        leader: [1, 0], // C has a RevOps head but 40 people; B's RevOps person is an intern.
        managers: [1, 2],
        "sales-led": [1, 0], // B: a VP of Sales, and its only RevOps title is an intern's, which never counts.
        banks: [1, 0],
      });
      assert.deepEqual(res.json.overlaps, [
        { a: "saas", b: "banks", accounts: 0 },
        { a: "leader", b: "sales-led", accounts: 0 },
      ]);

      // Siblings that share accounts, and a scope that sees only owned accounts (none here are owned).
      const shared = await ws.post("icp-tree/counts", { nodes: [
        { id: "any", account: {} },
        { id: "big", parent: "any", account: { employees: [{ min: 100, max: 1000 }] } },
        { id: "us", parent: "any", account: { countries: ["united states"] } },
      ] });
      assert.deepEqual(shared.json.overlaps.find((o: { a: string; b: string }) => o.a === "big" && o.b === "us"), { a: "big", b: "us", accounts: 3 });
      const scoped = await ws.post("icp-tree/counts", { nodes: [{ id: "any", account: {} }], accountScope: { field: "ownerId", owners: ["u1"], unowned: false } });
      assert.equal(scoped.json.nodes[0].accounts, 0);

      assert.equal((await ws.post("icp-tree/counts", { nodes: [{ id: "p", person: revops }, { id: "x", parent: "p", account: {} }] })).status, 400, "a person node has no children");
    } finally {
      await app.shutdown();
    }
  });
  it("counts all 100 nodes and 3075 sibling pairs at the valid cap within caller scopes", async () => {
    const { app, client } = await startApp({ dataDir: tempDir("rs-tree-cap-") });
    const ws = client.ws("tree-cap");
    try {
      await ws.post("provision");
      await ws.post("accounts/upsert", { records: [
        { domain: "a.example.com", name: "A", industry: "Software", ownerId: "visible" },
        { domain: "b.example.com", name: "B", industry: "Software", ownerId: "visible" },
        { domain: "c.example.com", name: "C", industry: "Software", ownerId: "hidden" },
        { domain: "d.example.com", name: "D", industry: "Banking", ownerId: "visible" },
      ], source: "t", idempotencyKey: "a" });
      await ws.post("contacts/upsert", { records: [
        { accountDomain: "a.example.com", fullName: "Ada", title: "VP RevOps" },
        { accountDomain: "a.example.com", fullName: "Al", title: "RevOps Manager" },
        { accountDomain: "a.example.com", fullName: "An", title: "Revenue Operations Manager" },
        { accountDomain: "b.example.com", fullName: "Bo", title: "VP of Sales" },
        { accountDomain: "b.example.com", fullName: "Bi", title: "Sales Ops Intern" },
        { accountDomain: "c.example.com", fullName: "Cy", title: "Head of Revenue Operations" },
      ], source: "t", idempotencyKey: "c" });
      await app.registry.with("tree-cap", (w) => w.write(async (c) => {
        await c.run("UPDATE contacts SET ownerId = CASE WHEN fullName = 'An' THEN 'hidden' ELSE 'visible' END");
      }, "exclusive"));
      const res = await ws.post("icp-tree/counts", {
        nodes: [
          ...Array.from({ length: 24 }, (_, i) => ({ id: `root${i}`, account: { industries: ["software development"] } })),
          { id: "banks", account: { industries: ["Banking"] } },
          ...Array.from({ length: 73 }, (_, i) => ({ id: `child${i}`, parent: "root0", account: {} })),
          { id: "empty", parent: "root0", account: { industries: ["Banking"] } },
          { id: "revops", parent: "root0", person: person({ departments: ["revenue operations"], exclude: ["intern"] }) },
        ],
        accountScope: { field: "ownerId", owners: ["visible"], unowned: false },
        contactScope: { field: "ownerId", owners: ["visible"], unowned: false },
      });
      assert.equal(res.status, 200, JSON.stringify(res.json));
      const overlaps: Array<{ a: string; b: string; accounts: number }> = [];
      for (let i = 0; i < 24; i++) {
        for (let j = i + 1; j < 24; j++) overlaps.push({ a: `root${i}`, b: `root${j}`, accounts: 2 });
        overlaps.push({ a: `root${i}`, b: "banks", accounts: 0 });
      }
      for (let i = 0; i < 73; i++) {
        for (let j = i + 1; j < 73; j++) overlaps.push({ a: `child${i}`, b: `child${j}`, accounts: 2 });
        overlaps.push({ a: `child${i}`, b: "empty", accounts: 0 });
        overlaps.push({ a: `child${i}`, b: "revops", accounts: 1 });
      }
      overlaps.push({ a: "empty", b: "revops", accounts: 0 });
      assert.equal(res.json.nodes.length, 100);
      assert.equal(res.json.overlaps.length, 3075);
      assert.deepEqual(res.json, {
        nodes: [
          ...Array.from({ length: 24 }, (_, i) => ({ id: `root${i}`, accounts: 2, people: 0 })),
          { id: "banks", accounts: 1, people: 0 },
          ...Array.from({ length: 73 }, (_, i) => ({ id: `child${i}`, accounts: 2, people: 0 })),
          { id: "empty", accounts: 0, people: 0 },
          { id: "revops", accounts: 1, people: 2 },
        ],
        overlaps,
      });
      assert.equal((await ws.post("icp-tree/counts", { nodes: [{ id: "orphan", parent: "missing", account: {} }] })).status, 400);
    } finally {
      await app.shutdown();
    }
  });
  it("lists only the accounts every query line's criteria pass (1.40.0)", async () => {
    const { app, client } = await startApp({ dataDir: tempDir("rs-criteria-") });
    const ws = client.ws("criteria");
    try {
      await ws.post("provision");
      await ws.post("accounts/upsert", { records: [
        { domain: "a.example.com", name: "Atlas", country: "Germany", employees: 300, ownerId: "ava" },
        { domain: "b.example.com", name: "Borealis", country: "France", employees: 300 },
        { domain: "c.example.com", name: "Cobalt", country: "United States", employees: 300 },
        { domain: "d.example.com", name: "Dune", country: "France", employees: 5000 },
      ], source: "t", idempotencyKey: "a" });
      const names = async (criteria: unknown[]) => ((await ws.post("accounts/list", { filter: { criteria }, sort: { field: "name", dir: "asc" } })).json.rows as Array<{ name: string }>).map((r) => r.name);
      assert.deepEqual(await names([{ excludeCountries: ["united states", "us"] }, { employees: [{ min: 1, max: 1000 }] }]), ["Atlas", "Borealis"], "a territory and the line above it");
      assert.deepEqual(await names([{ owners: ["__none__"] }]), ["Borealis", "Cobalt", "Dune"]);
      assert.deepEqual(await names([{ excludeOwners: ["__none__"] }]), ["Atlas"]);
    } finally {
      await app.shutdown();
    }
  });
});
