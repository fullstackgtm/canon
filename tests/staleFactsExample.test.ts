/**
 * Stale facts (examples/modules/stale-facts), the module built the way an outside author builds one: from its own
 * directory with module:build, its calls run with the kit's runCall, which refuses reads its manifest doesn't grant.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildModule } from "../modules/kernel/tools/build.ts";
import { parseModuleManifest, type ModuleManifest } from "../modules/kernel/manifest.ts";
import { runCall } from "../modules/kernel/testing.ts";
import type { ProposalOutcome } from "../modules/kernel/proposals.ts";
import { calls } from "../examples/modules/stale-facts/server.ts";

const DIR = "examples/modules/stale-facts";
const NOW = Date.UTC(2026, 10, 9);
const DAY = 86_400_000;
const parsed = parseModuleManifest(JSON.parse(readFileSync(`${DIR}/module.json`, "utf8")));
const manifest = (parsed.ok ? parsed.manifest : assert.fail(JSON.stringify(parsed))) as ModuleManifest;
const run = (call: string, reads: Record<string, unknown>, args?: Record<string, unknown>) =>
  runCall(manifest, calls, call, { reads, args, now: NOW, caller: { userId: "users:ria", role: "rep" } });
const doc = (key: string, data: Record<string, unknown>) => ({ key, version: 1, data, owner: null, parentKey: null, createdAt: NOW, updatedAt: NOW });
const stale = {
  deals: [{ id: "deals:big", name: "Big deal", companyId: null, companyName: "Atlas" }],
  companies: [{ id: "acc_a", name: "Atlas Cloud" }, { id: "acc_gone", name: "Gone Co", next: "cursor-2" }],
  dealFacts: [{ id: "deals:big", fields: [
    { attribute: "amount", value: 1_450_000, state: "resolved", winner: "f1", confirmedAt: NOW - 3 * DAY },
    { attribute: "nextStep", value: null, state: "empty", winner: null },
  ] }],
  dealCompanyFacts: [],
  companyFacts: [{ id: "acc_a", fields: [
    { attribute: "industry", value: "SaaS", state: "contested", winner: "f2", contestedBy: ["f3"], confirmedAt: NOW - DAY },
    { attribute: "employees", value: 640, state: "resolved", winner: "f4", confirmedAt: NOW - 40 * DAY },
  ] }, { id: "acc_gone", fields: [{ attribute: "industry", value: null, state: "empty", winner: null }] }],
};

test("the committed bundle is what module:build makes of the source", async () => {
  assert.equal((await buildModule(DIR)).code, readFileSync(`${DIR}/dist/module.js`, "utf8"), `dist/module.js is stale: npm run module:build -- ${DIR}`);
});

test("stale lists contested fields first, then the oldest confirmed, then empty ones", async () => {
  const { rows, next } = (await run("stale", stale)).value as { rows: Array<Record<string, unknown>>; next: string | null };
  assert.equal(next, "cursor-2", "the page's next links the following page");
  assert.deepEqual(rows.map((r) => [r.name, r.attribute, r.valueText, r.stateText, r.ageDays, r.proposable]), [
    ["Atlas Cloud", "industry", "SaaS", "Contested by 1", 1, true],
    ["Atlas Cloud", "employees", "640", "Resolved", 40, true],
    ["Big deal", "amount", "14500", "Resolved", 3, false],
    ["Big deal", "nextStep", "", "No value", null, true],
    ["Gone Co", "industry", "", "No value", null, true],
  ]);
});

test("a test can't hand stale reads the manifest doesn't grant", async () => {
  await assert.rejects(run("stale", { ...stale, companies: [{ id: "acc_a", name: "Atlas Cloud", domain: "atlas.example" }] }), /reads.companies\[0\].domain: reads.companies doesn't grant domain/);
  await assert.rejects(run("stale", { ...stale, companyFacts: [{ id: "acc_a", fields: [{ attribute: "custom.tier", value: null, state: "unknown", winner: null }] }] }), /custom.tier, which facts.companies.read doesn't declare/);
  const { companies: _, ...missing } = stale;
  await assert.rejects(run("stale", missing), /reads.companies is missing/);
});

test("propose writes the correction before the stamped fact proposal, and outcomes reads each proposal's fate", async () => {
  const out = await run("propose", {}, { object: "companies", record: "acc_a", recordName: "Atlas Cloud", attribute: "annualRevenue", was: "76000000", value: "80,000,000", evidence: "10-K: revenue $80M" });
  const key = `t${NOW}~companies~acc_a~annualRevenue`;
  assert.deepEqual(out.intents, [
    { op: "put", collection: "corrections", key, data: { object: "companies", record: "acc_a", recordName: "Atlas Cloud", attribute: "annualRevenue", was: "76000000", value: "80,000,000", evidence: "10-K: revenue $80M", by: "users:ria" }, expect: [{ collection: "corrections", key, version: null }] },
    { op: "propose", operation: "facts.propose", reason: "Stale facts: Atlas Cloud's annualRevenue", stamp: { collection: "corrections", key, field: "proposal" },
      args: { object: "companies", facts: [{ id: "acc_a", attribute: "annualRevenue", value: 8_000_000_000, evidence: "10-K: revenue $80M" }] } },
  ]);
  await assert.rejects(run("propose", {}, { object: "deals", record: "deals:big", attribute: "amount", value: "1", evidence: "x" }), /doesn't propose amount/);

  const outcome = (id: string, counts: Partial<ProposalOutcome>) => ({ id, operation: "facts.propose", status: "pending_approval", pending: 0, applied: 0, skipped: 0, unchanged: 0, rejected: [], ...counts });
  const listed = await run("outcomes", {
    corrections: ["p1", "p2", "p3", "p4"].map((proposal) => doc(proposal, { recordName: "Atlas Cloud", proposal })),
    proposals: [outcome("p1", { pending: 1 }), outcome("p2", { status: "applied", applied: 1 }), outcome("p3", { status: "rejected", rejected: [{ index: 0, reason: "unknown_record" }] })],
  });
  assert.deepEqual((listed.value as { rows: Array<{ outcome: string }> }).rows.map((r) => r.outcome), [
    "Waiting for review", "Accepted", "Not stored: not a record you can see", "Not proposed",
  ]);
});
