import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { all } from "../src/db.ts";
import { Workspace } from "../src/workspace.ts";
import { tempDir } from "./helpers.ts";

describe("workspace writer", () => {
  it("runs a write queued in the same tick the previous one resolved", async () => {
    const w = await Workspace.open("w1", join(tempDir(), "w1.duckdb"), { memoryLimit: "256MB", threads: 1, readPool: 1, maxGroup: 8, lockWaitMs: 0 });
    try {
      await w.write((c) => c.run("CREATE TABLE z (a INTEGER)"), "exclusive");
      const second = w.write((c) => c.run("INSERT INTO z VALUES (1)"), "exclusive");
      const stalled = new Promise((r) => setTimeout(() => r("stalled"), 2000).unref());
      assert.equal(await Promise.race([second.then(() => "written"), stalled]), "written");
      await w.checkpoint();
      assert.deepEqual(await w.read((c) => all(c, "SELECT a FROM z")), [{ a: 1 }]);
    } finally {
      await w.close();
    }
  });
});
