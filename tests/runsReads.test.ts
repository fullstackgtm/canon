import assert from "node:assert/strict";
import { test } from "node:test";
import { accessOf } from "../convex/lib/access.ts";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

type Runs = typeof import("../convex/lib/runs.ts");
const { runsBetween, runsRead } = loadConvex(["lib/runs.ts"])["lib/runs.ts"] as unknown as Runs;
const plain = (x: unknown) => JSON.parse(JSON.stringify(x));

const DAY = 86_400_000;
const T = Date.parse("2026-10-10T00:00:00Z");

const world = () => memoryDb({
  cliRuns: [
    { _id: "cli1", orgId: "org", command: "audit", status: "partial", startedAt: T + 1000, finishedAt: T + 2000, durationMs: 1000, counts: { findings: 2 }, findings: [{ objectType: "deal", objectId: "9", severity: "info", ruleId: "r" }], createdAt: T + 1000 },
    { _id: "cli2", orgId: "org", command: "status", status: "success", startedAt: T + 3000, finishedAt: T + 3000, durationMs: 0, createdAt: T + 3000 },
    { _id: "old", orgId: "org", command: "audit", status: "error", error: "x", startedAt: T - 5 * DAY, finishedAt: T - 5 * DAY, durationMs: 1, createdAt: T - 5 * DAY },
    { _id: "away", orgId: "org2", command: "audit", status: "error", error: "x", startedAt: T, finishedAt: T, durationMs: 1, createdAt: T + 4000 },
  ],
  cliArtifacts: [
    { _id: "ev", orgId: "org", kind: "signal_run", key: "k", label: "Signals", document: { signals: [{}, {}], counts: { new: 1 } }, updatedAt: T + 5000 },
    { _id: "icp", orgId: "org", kind: "icp", key: "i", label: "ICP", document: {}, updatedAt: T + 5000 },
  ],
  integrationSyncRuns: [{ _id: "sync", _creationTime: T + 6000, orgId: "org", provider: "hubspot", trigger: "system", status: "success", startedAt: T + 6000, finishedAt: T + 7000, counts: { accounts: 3 } }],
  operationAuditLog: [{ _id: "plan", _creationTime: T + 8000, orgId: "org", verb: "apply", operation: "update", status: "applied", createdAt: T + 8000 }],
  healthSnapshots: [{ _id: "health", orgId: "org", at: T + 9000, source: "cron", score: 80, findings: 4 }],
  backgroundJobs: [{ _id: "job", orgId: "org", kind: "contact_sweep", title: "Find people", status: "processing", phases: [], counters: { pending: 3 }, startedAt: T + 10_000, updatedAt: T + 10_000, href: "/dashboard/contacts" }],
  researchAgents: [{ _id: "field", orgId: "org", label: "Product", createdBy: "owner" }],
  researchRuns: [{ _id: "research1", orgId: "org", agentId: "field", runtime: "pi", status: "done", createdBy: "starter", createdAt: T + 11_000, updatedAt: T + 12_000, done: 1, answered: 1, unknown: 0, noEvidence: 0, errors: 0, pagesRead: 1, llmCalls: 1 }],
  researchTraces: [{ _id: "trace1", orgId: "org", runId: "research1", recordId: "private-account", label: "Private company", status: "answered", value: "Forecasting", quote: "A private quote", steps: [], calls: 1 }],
});

test("runs.between reads every ledger in the range, newest first, and refuses past its limit", async () => {
  const ctx = { db: world() } as never;
  const rows = await runsBetween(ctx, "org" as never, T, T + DAY, 50, T + 10_000);
  assert.deepEqual(plain(rows.map((r) => [r.id, r.kind, r.href])), [
    ["research1", "research", "/dashboard/runs/research/research1"],
    ["job", "records", "/dashboard/contacts"],
    ["health", "health", "/dashboard"],
    ["plan", "plan", "/dashboard/patch-plans"],
    ["sync", "sync", "/dashboard/integrations/hubspot"],
    ["ev", "evidence", "/dashboard/runs/artifacts/ev"],
    ["cli1", "cli", "/dashboard/runs/cli1"],
  ]);
  assert.equal(rows.find((r) => r.id === "job")?.stoppable, true);
  await assert.rejects(runsBetween(ctx, "org" as never, T, T + DAY, 5, T), /more than 5 runs in this range/);
});

test("research receipts preserve trace ids and expose records only under the existing principal visibility rule", async () => {
  const ctx = { db: world() } as never;
  const read = async (userId: string, role: "admin" | "rep", orgId = "org") => plain(await runsRead(ctx, orgId as never, accessOf({ userId, role, rules: [{ object: "account", visibility: "own", unowned: false }] as never }), ["kind", "document"], "runs.research", { run: "research1" }, 1));
  const admin = await read("admin", "admin");
  assert.equal(admin[0].id, "research1");
  assert.equal(admin[0].document.records[0].id, "trace1");
  assert.equal(admin[0].document.records[0].recordId, "private-account");
  assert.equal((await read("starter", "rep"))[0].document.recordsVisible, true);
  assert.equal((await read("owner", "rep"))[0].document.recordsVisible, true);
  assert.deepEqual((await read("other", "rep"))[0].document, { runtime: "pi", recordsVisible: false, records: [] });
  assert.deepEqual(await read("admin", "admin", "org2"), []);
});

test("a CLI run's findings read only for a role that sees every record", async () => {
  const ctx = { db: world() } as never;
  const admin = accessOf({ userId: "a", role: "admin" });
  const narrowed = accessOf({ userId: "r", role: "rep", rules: [{ object: "deal", visibility: "own", unowned: false }] as never });
  const read = async (access: typeof admin, run: string) => plain(await runsRead(ctx, "org" as never, access, ["title", "findings"], "runs.cli", { run }, 1));
  assert.deepEqual(await read(admin, "cli1"), [{ id: "cli1", createdAt: T + 1000, title: "audit", findings: [{ objectType: "deal", objectId: "9", severity: "info", ruleId: "r" }] }]);
  assert.deepEqual(await read(narrowed, "cli1"), []);
  assert.deepEqual(await read(admin, "away"), []);
  assert.deepEqual(await read(admin, "not-an-id"), []);
});
