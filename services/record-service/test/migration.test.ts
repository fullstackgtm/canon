import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { MIGRATIONS } from "../src/db.ts";
import { startApp, tempDir } from "./helpers.ts";

// A workspace file written by contract 1.2/1.3 (schema_version 2) must open
// under 1.4.0, gain the TAM explorer columns, and keep its rows.
describe("migration 3 on an existing workspace file", () => {
  it("upgrades a schema_version 2 file in place", async () => {
    const dataDir = tempDir("rs-mig-");
    mkdirSync(join(dataDir, "ws"), { recursive: true });
    const db = await DuckDBInstance.create(join(dataDir, "ws", "legacy.duckdb"));
    const c = await db.connect();
    await c.run(`CREATE TABLE schema_version (version INTEGER NOT NULL, appliedAt BIGINT NOT NULL)`);
    for (const [i, stmts] of MIGRATIONS.slice(0, 2).entries()) {
      for (const stmt of stmts) await c.run(typeof stmt === "function" ? stmt() : stmt);
      await c.run(`INSERT INTO schema_version VALUES (${i + 1}, 0)`);
    }
    await c.run(`INSERT INTO accounts (id, domain, name, industry, employees, country, source, updatedAt, version, fieldUpdatedAt)
      VALUES ('acc_old', 'old.example.com', 'Old Co', 'Software', 120, 'Germany', 'legacy', 1, 3, '{}')`);
    await c.run("CHECKPOINT");
    c.closeSync();
    db.closeSync();

    const { app, client } = await startApp({ dataDir });
    try {
      const ws = client.ws("legacy");
      const got = await ws.post("accounts/get", { id: "acc_old" });
      assert.equal(got.status, 200);
      assert.equal(got.json.account.name, "Old Co");
      assert.equal(got.json.account.version, 3);
      assert.deepEqual(got.json.account.traits, {});
      assert.equal(got.json.account.revenue, undefined);

      const region = await ws.post("accounts/facets", { groupBy: "region" });
      assert.deepEqual(region.json.groups, [{ key: "europe", count: 1, revenue: 0, revenueKnown: 0, employees: 120 }]);
      const ann = await ws.post("accounts/annotate", { records: [{ domain: "old.example.com", revenue: 2_000_000, revenueSource: "estimate", traits: { reps: "yes" } }] });
      assert.deepEqual(ann.json, { updated: 1, missing: [] });
      const after = await ws.post("accounts/get", { id: "acc_old" });
      assert.equal(after.json.account.revenue, 2_000_000);
      assert.deepEqual(after.json.account.traits, { reps: "yes" });
    } finally {
      await app.shutdown();
    }

    // Reopening is a no-op: the file now reports the latest schema version.
    const check = await DuckDBInstance.create(join(dataDir, "ws", "legacy.duckdb"), { access_mode: "READ_ONLY" });
    const cc = await check.connect();
    const v = (await cc.runAndReadAll(`SELECT max(version) AS v FROM schema_version`)).getRowObjectsJS()[0].v;
    assert.equal(Number(v), MIGRATIONS.length);
    cc.closeSync();
    check.closeSync();
  });
});
