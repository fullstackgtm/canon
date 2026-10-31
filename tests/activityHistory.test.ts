import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const { feed } = loadConvex(["activity.ts"], {
  "lib.ts": (real) => ({ ...real, getCurrentUser: async (ctx: { user: unknown }) => ctx.user }),
})["activity.ts"];

test("run history drains every ledger beyond the old caps without crossing organizations", async () => {
  const sources = {
    artifacts: ["cliArtifacts", { kind: "signal_run", updatedAt: 1, document: {}, label: "Evidence" }],
    cli: ["cliRuns", { command: "audit", status: "error", createdAt: 1 }],
    sync: ["integrationSyncRuns", { provider: "hubspot", status: "success", startedAt: 1 }],
    audit: ["operationAuditLog", { verb: "plan", operation: "apply", status: "success", createdAt: 1 }],
    health: ["healthSnapshots", { at: 1, score: 100 }],
    jobs: ["backgroundJobs", { title: "Populate", status: "completed", startedAt: 1, updatedAt: 1, phases: [] }],
  } as const;
  const db = memoryDb(Object.fromEntries(Object.values(sources).map(([table, fields]) => [table,
    Array.from({ length: 122 }, (_, i) => ({ ...fields, _id: `${table}:${i}`, orgId: i === 121 ? "other" : "org" })),
  ])));
  const ctx = { db, user: { orgId: "org", role: "admin" } };
  for (const source of Object.keys(sources)) {
    let cursor: string | null = null;
    const ids: string[] = [];
    for (let request = 0; request < 16; request++) {
      const result = await feed.handler(ctx, { source, paginationOpts: { numItems: 50, cursor } });
      const page = Array.isArray(result) ? result : result.page;
      if (!Array.isArray(result)) assert.ok(page.length <= 50);
      ids.push(...page.map((row: { id: string }) => row.id));
      if (Array.isArray(result) || result.isDone) break;
      cursor = result.continueCursor;
    }
    assert.equal(ids.length, 121, source);
    assert.equal(new Set(ids).size, 121, source);
    assert.ok(!ids.some((id) => id.endsWith(":121")), source);
  }
  const unauthenticated = await feed.handler({ db, user: null }, { source: "jobs", paginationOpts: { numItems: 50, cursor: null } });
  assert.equal(unauthenticated.page.length, 0);
  assert.equal(unauthenticated.isDone, true);
});

test("CLI deduplication finds retained output independently of artifact pages", async () => {
  const db = memoryDb({
    cliRuns: [{ _id: "cli", orgId: "org", command: "signals discover", status: "success", counts: { signals: 1 }, startedAt: 2000, finishedAt: 3000 }],
    cliArtifacts: [{ _id: "artifact", orgId: "org", kind: "signal_run", updatedAt: 2500 }],
  });
  const args = { source: "cli", paginationOpts: { numItems: 50, cursor: null } };
  const ctx = { db, user: { orgId: "org" } };
  assert.equal((await feed.handler(ctx, args)).page.length, 0);
  await db.patch("artifact", { orgId: "other" });
  assert.equal((await feed.handler(ctx, args)).page.length, 1);
});
