import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "../engine/src/cli.ts";
import { accountHierarchyToMarkdown, buildAccountHierarchy, buildParentLinkPlan } from "../engine/src/hierarchy.ts";
import { buildRelationshipMap } from "../engine/src/relationships.ts";
import type { CanonicalGtmSnapshot } from "../engine/src/types.ts";

function snapshot(): CanonicalGtmSnapshot {
  return {
    generatedAt: "2026-06-30T00:00:00.000Z",
    provider: "mock",
    users: [],
    accounts: [
      { id: "acct-root", name: "Acme", domain: "acme.com" },
      { id: "acct-emea", name: "Acme EMEA", domain: "emea.acme.com" },
    ],
    contacts: [{ id: "c1", firstName: "Dana", lastName: "Director", email: "dana@acme.com", accountId: "acct-root", title: "VP Sales" }],
    deals: [{ id: "d1", name: "Acme expansion", accountId: "acct-root", stage: "Proposal", amount: 50000, isClosed: false }],
    activities: [{ id: "a1", accountId: "acct-root", contactId: "c1", type: "call", occurredAt: "2026-06-29", subject: "Champion excited about next step" }],
  };
}

async function captureCli(argv: string[]): Promise<{ out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (message?: unknown) => out.push(String(message ?? ""));
  console.error = (message?: unknown) => err.push(String(message ?? ""));
  try {
    await runCli(argv);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return { out: out.join("\n"), err: err.join("\n") };
}

async function withSnapshotFile<T>(fn: (input: string, dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-hierarchy-relationships-"));
  try {
    const input = join(dir, "snapshot.json");
    writeFileSync(input, `${JSON.stringify(snapshot(), null, 2)}\n`);
    return await fn(input, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("hierarchy: infers subdomain child accounts", () => {
  const report = buildAccountHierarchy(snapshot());
  assert.equal(report.counts.linkedChildren, 1);
  const acme = report.roots.find((node) => node.accountId === "acct-root");
  assert.equal(acme?.children[0]?.accountId, "acct-emea");
  assert.equal(acme?.children[0]?.parentReason, "domain-subdomain");
});

test("hierarchy: preserves Berkshire-style related accounts that share a domain", () => {
  const report = buildAccountHierarchy({
    ...snapshot(),
    accounts: [
      { id: "berkshire", name: "Berkshire Hathaway", domain: "berkshirehathaway.com" },
      { id: "energy", name: "Berkshire Hathaway Energy", domain: "berkshirehathaway.com", parentAccountId: "berkshire" },
      { id: "insurance", name: "Berkshire Hathaway Specialty Insurance", domain: "berkshirehathaway.com", parentAccountId: "berkshire" },
    ],
    contacts: [], deals: [], activities: [],
  });
  assert.equal(report.counts.linkedChildren, 2);
  assert.ok(report.conflicts.some((conflict) => conflict.type === "related_shared_domain"));
  assert.ok(!report.conflicts.some((conflict) => conflict.type === "duplicate_domain"));
});

test("hierarchy parent-link plan is governed, idempotent, and refuses cycles or implicit re-parenting", () => {
  const base = {
    ...snapshot(),
    accounts: [
      { id: "parent", name: "Parent", domain: "parent.example" },
      { id: "child", name: "Child", domain: "child.example" },
    ],
  };
  const plan = buildParentLinkPlan(base, { childAccountId: "child", parentAccountId: "parent" });
  assert.equal(plan.status, "needs_approval");
  assert.deepEqual(plan.operations.map((operation) => ({ operation: operation.operation, field: operation.field, before: operation.beforeValue, after: operation.afterValue })), [
    { operation: "link_record", field: "parentAccountId", before: null, after: "parent" },
  ]);

  const linked = { ...base, accounts: base.accounts.map((account) => account.id === "child" ? { ...account, parentAccountId: "parent" } : account) };
  assert.equal(buildParentLinkPlan(linked, { childAccountId: "child", parentAccountId: "parent" }).operations.length, 0);
  assert.throws(() => buildParentLinkPlan(linked, { childAccountId: "parent", parentAccountId: "child" }), /cycle/);
  assert.throws(() => buildParentLinkPlan({ ...linked, accounts: [...linked.accounts, { id: "other", name: "Other" }] }, { childAccountId: "child", parentAccountId: "other" }), /refusing to re-parent/);
});

test("hierarchy: cycle parent hints are conflicts and accounts remain visible", () => {
  const report = buildAccountHierarchy({
    ...snapshot(),
    accounts: [
      { id: "acct-a", name: "Acme A", raw: { parentAccountId: "acct-b" } },
      { id: "acct-b", name: "Acme B", raw: { parentAccountId: "acct-a" } },
    ],
    contacts: [],
    deals: [],
    activities: [],
  });

  const conflict = report.conflicts.find((item) => item.type === "cycle");
  assert.deepEqual(conflict?.accountIds, ["acct-a", "acct-b"]);
  assert.equal(report.counts.linkedChildren, 0);
  assert.deepEqual(
    report.roots.map((node) => node.accountId).sort(),
    ["acct-a", "acct-b"],
  );
  const markdown = accountHierarchyToMarkdown(report);
  assert.match(markdown, /Acme A \(acct-a\)/);
  assert.match(markdown, /Acme B \(acct-b\)/);
  assert.match(markdown, /cycle/);
});

test("relationships: maps stakeholders, sentiment evidence, open deals, and gaps", () => {
  const map = buildRelationshipMap(snapshot(), { accountId: "acct-root" });
  assert.equal(map.counts.stakeholders, 1);
  assert.equal(map.openDeals[0].dealId, "d1");
  assert.equal(map.stakeholders[0].role, "decision_maker");
  assert.equal(map.stakeholders[0].sentiment, "positive");
  assert.ok(map.gaps.some((gap) => gap.includes("economic buyer")));
});

test("hierarchy CLI: renders markdown from --input", async () => {
  await withSnapshotFile(async (input) => {
    const { out, err } = await captureCli(["hierarchy", "report", "--input", input]);
    assert.equal(err, "");
    assert.match(out, /^# Account hierarchy/);
    assert.match(out, /Acme EMEA \(acct-emea — emea\.acme\.com; via domain-subdomain\)/);
  });
});

test("hierarchy CLI: writes JSON report to --out and stdout", async () => {
  await withSnapshotFile(async (input, dir) => {
    const outPath = join(dir, "hierarchy.json");
    const { out, err } = await captureCli(["hierarchy", "report", "--input", input, "--json", "--out", outPath]);
    assert.equal(err, "");
    assert.ok(existsSync(outPath));
    const written = JSON.parse(readFileSync(outPath, "utf8")) as ReturnType<typeof buildAccountHierarchy>;
    const printed = JSON.parse(out) as ReturnType<typeof buildAccountHierarchy>;
    assert.equal(written.counts.linkedChildren, 1);
    assert.deepEqual(printed.counts, written.counts);
  });
});

test("hierarchy CLI: emits a reviewable parent-link plan", async () => {
  await withSnapshotFile(async (input) => {
    const { out } = await captureCli([
      "hierarchy", "link", "--child-account-id", "acct-emea", "--parent-account-id", "acct-root",
      "--input", input, "--json",
    ]);
    const plan = JSON.parse(out);
    assert.equal(plan.operations[0].field, "parentAccountId");
    assert.equal(plan.operations[0].operation, "link_record");
    assert.equal(plan.operations[0].afterValue, "acct-root");
  });
});

test("relationships CLI: renders markdown from --input and --account-id", async () => {
  await withSnapshotFile(async (input) => {
    const { out, err } = await captureCli(["relationships", "account", "--account-id", "acct-root", "--input", input]);
    assert.equal(err, "");
    assert.match(out, /^# Relationship map: Acme/);
    assert.match(out, /Dana Director — decision_maker, positive \(VP Sales\)/);
    assert.match(out, /evidence: Champion excited about next step/);
  });
});

test("relationships CLI: selects by domain and writes JSON map to --out", async () => {
  await withSnapshotFile(async (input, dir) => {
    const outPath = join(dir, "relationships.json");
    const { out, err } = await captureCli(["relationships", "account", "--domain", "acme.com", "--input", input, "--json", "--out", outPath]);
    assert.equal(err, "");
    assert.ok(existsSync(outPath));
    const written = JSON.parse(readFileSync(outPath, "utf8")) as ReturnType<typeof buildRelationshipMap>;
    const printed = JSON.parse(out) as ReturnType<typeof buildRelationshipMap>;
    assert.equal(written.account.accountId, "acct-root");
    assert.equal(written.counts.openDeals, 1);
    assert.deepEqual(printed.counts, written.counts);
  });
});
