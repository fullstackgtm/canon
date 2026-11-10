import assert from "node:assert/strict";
import test from "node:test";
import { loadConvex, memoryDb } from "./convexHandlers.ts";
const modules = loadConvex(["tamInvestigations.ts"], {
  "lib.ts": (real) => ({ ...real, requireCap: async () => ({ _id: "user", orgId: "org", role: "admin" }) }),
  "permissions.ts": (real) => ({ ...real, accessFor: async () => ({ role: "admin", rules: {} }) }),
  "lib/access.ts": (real) => ({ ...real, refuseNarrowed: () => undefined }),
});
const handlers = modules["tamInvestigations.ts"];
const source = { kind: "directory", url: "https://builders.org", quote: "Acme is a member." };
function fixture(cap = 2) {
  const db = memoryDb({
    organizations: [{ _id: "org", creditUnit: "credits", creditBalanceMicro: 0 }],
    backgroundJobs: [{ _id: "job", orgId: "org", counters: { cap_micro: cap * 1000000, spent_micro: 0 }, phases: [] }],
    stagedRuns: [{ _id: "stage", orgId: "org", jobId: "job", state: "collecting" }],
    tamInvestigations: [{ _id: "run", orgId: "org", jobId: "job", status: "awaiting_start", estimateCredits: 3, capCredits: cap, spentCredits: 0, plan: { sources: [] }, progress: { phase: "websites", step: 0, sourceIndex: 0, page: 1 }, counts: { found: 3, duplicates: 0, rejected: 0, kept: 0 }, events: [] }],
    tamCandidates: ["acme", "reject", "duplicate"].map((id) => ({ _id: id, name: id, orgId: "org", investigationId: "run", keys: {}, sources: [source], state: "found" })),
  });
  const scheduled: string[] = [];
  const ctx = { db, scheduler: { runAfter: async (_delay: number, ref: unknown) => { scheduled.push(String(ref)); } }, runMutation: async () => null };
  return { ctx, db, scheduled };
}
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
test("only kept companies are charged and staged; retries, duplicates and rejects are free", async () => {
  const { ctx, db } = fixture();
  await handlers.start.handler(ctx, { investigationId: "run" });
  assert.equal(db.rows("creditLedger")[0].amountMicro, -2000000);
  const kept = { investigationId: "run", candidateId: "acme", step: 0, domain: "acme.com" };
  await handlers.resolved.handler(ctx, kept);
  await handlers.resolved.handler(ctx, kept);
  await handlers.resolved.handler(ctx, { investigationId: "run", candidateId: "reject", step: 1, reason: "Different company" });
  await handlers.resolved.handler(ctx, { investigationId: "run", candidateId: "duplicate", step: 2, domain: "old.com", workspaceDuplicate: true });
  await handlers.complete.handler(ctx, { investigationId: "run" });
  const run = await db.get("run");
  assert.ok(run);
  assert.deepEqual(plain({ status: run.status, spentCredits: run.spentCredits, counts: run.counts }), { status: "done", spentCredits: 1, counts: { found: 3, duplicates: 1, rejected: 1, kept: 1 } });
  assert.deepEqual(plain(db.rows("stagedRecords").map((r) => ({ name: r.name, domain: r.domain, sources: r.discoverySources }))), [{ name: "acme", domain: "acme.com", sources: [source] }]);
  assert.equal(db.rows("creditLedger").reduce((n, row) => n + Number(row.amountMicro), 0), -1000000);
  assert.equal((await db.get("org"))!.freeCreditsUsedMicro, 1000000);
  assert.equal((await db.get("org"))!.creditBalanceMicro, 0);
  assert.equal((await db.get("stage"))!.state, "ready");
});
test("cap pauses preserve pending candidates and require a user continuation", async () => {
  const { ctx, db } = fixture(1);
  await handlers.start.handler(ctx, { investigationId: "run" });
  await handlers.resolved.handler(ctx, { investigationId: "run", candidateId: "acme", step: 0, domain: "acme.com" });
  await handlers.resolved.handler(ctx, { investigationId: "run", candidateId: "reject", step: 1, domain: "second.com" });
  assert.equal((await db.get("run"))!.status, "paused_at_cap");
  assert.equal((await db.get("reject"))!.state, "found");
  assert.equal((await db.get("stage"))!.state, "collecting");
  await assert.rejects(handlers.start.handler(ctx, { investigationId: "run", capCredits: 1 }));
  await handlers.start.handler(ctx, { investigationId: "run", capCredits: 2 });
  await handlers.resolved.handler(ctx, { investigationId: "run", candidateId: "reject", step: 1, domain: "second.com" });
  await handlers.complete.handler(ctx, { investigationId: "run" });
  assert.equal((await db.get("run"))!.spentCredits, 2);
  assert.equal(db.rows("stagedRecords").length, 2);
});
test("source checkpoints ignore replays and merge evidence before enrichment", async () => {
  const { ctx, db } = fixture();
  for (const id of ["acme", "reject", "duplicate"]) await db.delete(id);
  await db.patch("run", { status: "running", counts: { found: 0, duplicates: 0, rejected: 0, kept: 0 }, plan: { sources: [{ kind: "directory", ref: "https://builders.org", label: "Builders", estimatedCompanies: 2 }] }, progress: { phase: "source", step: 0, sourceIndex: 0, page: 1 } });
  const rows = [{ name: "Smith Inc", address: "12 Main Street", sources: [source], keys: {} }, { name: "Smith LLC", address: "12 Main St", sources: [{ ...source, url: "https://others.org" }], keys: {} }];
  const page = { investigationId: "run", step: 0, rows, note: "Found two" };
  await handlers.sourced.handler(ctx, page); await handlers.sourced.handler(ctx, page);
  await handlers.deduped.handler(ctx, { investigationId: "run", step: 1, workspace: [] });
  assert.deepEqual(plain(db.rows("tamCandidates").map((r) => [r.state, (r.sources as unknown[]).length])), [["found", 2], ["duplicate", 1]]);
  assert.equal(((await db.get("run"))!.counts as { found: number }).found, 2);
  assert.equal(((await db.get("run"))!.counts as { duplicates: number }).duplicates, 1);
});
test("company provenance includes only approved runs from this workspace", async () => {
  const { ctx, db } = fixture();
  await db.patch("stage", { state: "approved" });
  await db.patch("acme", { state: "kept", domain: "acme.com", keys: { domain: "acme.com" } });
  await db.insert("tamInvestigations", { _id: "pending", orgId: "org", jobId: "pendingJob" });
  await db.insert("stagedRuns", { jobId: "pendingJob", state: "ready" });
  await db.insert("tamCandidates", { investigationId: "pending", orgId: "org", keys: { domain: "acme.com" }, state: "kept", sources: [{ ...source, quote: "Not approved" }] });
  await db.insert("tamCandidates", { investigationId: "run", orgId: "another", keys: { domain: "acme.com" }, state: "kept", sources: [{ ...source, quote: "Another workspace" }] });
  assert.deepEqual(plain(await handlers.sourcesForDomain.handler(ctx, { orgId: "org", domain: "acme.com" })), [source]);
});
