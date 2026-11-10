import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  auditSnapshot,
  defaultPolicy,
  generateDemoSnapshot,
} from "../engine/src/index.ts";
import { cli } from "./support/cli.ts";

const DEMO_TODAY = "2026-06-09";

// Golden expectations for the default seed. If the generator changes, these
// must be reviewed deliberately — they are the contract that audits over
// realistic data stay deterministic.
const GOLDEN_FINDINGS_BY_RULE: Record<string, number> = {
  "orphan-account": 7,
  "missing-deal-owner": 9,
  "missing-deal-account": 8,
  "past-close-date": 12,
  "stale-deal": 33,
  "duplicate-account-domain": 3,
  "duplicate-contact-email": 1,
};

test("demo snapshot is deterministic and realistically sized", () => {
  const first = generateDemoSnapshot();
  const second = generateDemoSnapshot();
  assert.deepEqual(first, second);

  assert.equal(first.users.length, 12);
  assert.equal(first.accounts.length, 56);
  assert.ok(first.contacts.length > 50);
  assert.equal(first.deals.length, 80);
  assert.ok(first.activities.length > 100);
  assert.deepEqual(
    first.accounts.slice(0, 6).map(({ name, domain }) => ({ name, domain })),
    [
      { name: "Apple", domain: "apple.com" },
      { name: "Apple, Inc.", domain: "apple.com" },
      { name: "Nike", domain: "nike.com" },
      { name: "Nike, Inc.", domain: "nike.com" },
      { name: "Starbucks", domain: "starbucks.com" },
      { name: "Starbucks Corporation", domain: "starbucks.com" },
    ],
  );
  assert.match(first.deals[0].name, /^Apple, Inc\. — Customer Journey Pilot$/);
  assert.ok(first.users.every((user) => user.email?.endsWith("@acmesoftware.com") === true));
  assert.ok(first.accounts.every((account) => /^001[A-Za-z0-9]{15}$/.test(account.id)));
  assert.ok(first.contacts.every((contact) => /^003[A-Za-z0-9]{15}$/.test(contact.id)));
  assert.ok(first.deals.every((deal) => /^006[A-Za-z0-9]{15}$/.test(deal.id)));
  assert.ok(first.activities.every((activity) => /^00T[A-Za-z0-9]{15}$/.test(activity.id)));
  assert.ok(first.users.every((user) => /^005[A-Za-z0-9]{15}$/.test(user.id)));

  const other = generateDemoSnapshot({ seed: 8 });
  assert.notDeepEqual(first.deals, other.deals);
});

test("demo snapshot is referentially coherent apart from injected issues", () => {
  const snapshot = generateDemoSnapshot();
  const accountIds = new Set(snapshot.accounts.map((account) => account.id));
  const dealIds = new Set(snapshot.deals.map((deal) => deal.id));
  const userIds = new Set(snapshot.users.map((user) => user.id));

  for (const contact of snapshot.contacts) {
    assert.ok(contact.accountId && accountIds.has(contact.accountId));
  }
  for (const activity of snapshot.activities) {
    assert.ok(activity.dealId && dealIds.has(activity.dealId));
  }
  // Injected mess: departed owners reference users outside the snapshot.
  const departed = snapshot.deals.filter(
    (deal) => deal.ownerId && !userIds.has(deal.ownerId),
  );
  assert.ok(departed.length > 0);
  assert.ok(departed.every((deal) => /^005[A-Za-z0-9]{15}$/.test(deal.ownerId!)));
});

test("audit over the demo dataset matches golden finding counts", () => {
  const snapshot = generateDemoSnapshot();
  const plan = auditSnapshot(snapshot, defaultPolicy(DEMO_TODAY));

  const byRule: Record<string, number> = {};
  for (const finding of plan.findings) {
    byRule[finding.ruleId] = (byRule[finding.ruleId] ?? 0) + 1;
  }
  assert.deepEqual(byRule, GOLDEN_FINDINGS_BY_RULE);

  // Every proposed operation must target a record that exists in the snapshot.
  const recordIds = new Set([
    ...snapshot.accounts.map((account) => account.id),
    ...snapshot.contacts.map((contact) => contact.id),
    ...snapshot.deals.map((deal) => deal.id),
  ]);
  assert.ok(plan.operations.every((operation) => recordIds.has(operation.objectId)));
  assert.ok(plan.operations.every((operation) => operation.approvalRequired));
});

// ── CLI ergonomics, exercised through the CLI entry (in-process) ──────────

test("cli audit --demo --json emits a valid plan and gates on --fail-on", async () => {
  const gated = await cli([
    "audit", "--demo", "--json", "--today", DEMO_TODAY, "--fail-on", "warning",
  ]);
  assert.equal(gated.status, 2);
  const plan = JSON.parse(gated.stdout);
  assert.equal(plan.dryRun, true);
  assert.equal(plan.findings.length, 73);

  const clean = await cli([
    "audit", "--demo", "--json", "--today", DEMO_TODAY, "--fail-on", "critical",
  ]);
  assert.equal(clean.status, 0);
});

test("cli audit --rules scopes the audit and rejects unknown rules", async () => {
  const scoped = await cli([
    "audit", "--demo", "--json", "--today", DEMO_TODAY, "--rules", "orphan-account",
  ]);
  assert.equal(scoped.status, 0);
  const plan = JSON.parse(scoped.stdout);
  assert.equal(plan.findings.length, GOLDEN_FINDINGS_BY_RULE["orphan-account"]);
  assert.ok(plan.findings.every((finding: { ruleId: string }) => finding.ruleId === "orphan-account"));

  const unknown = await cli(["audit", "--demo", "--rules", "no-such-rule"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Available rules/);
});

test("cli snapshot/audit pipeline round-trips through a file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-"));
  try {
    const snapshotPath = join(dir, "snapshot.json");
    const planPath = join(dir, "plan.json");

    const snapshotResult = await cli(["snapshot", "--demo", "--out", snapshotPath]);
    assert.equal(snapshotResult.status, 0);
    assert.match(snapshotResult.stdout, /80 deals/);

    const auditResult = await cli([
      "audit", "--input", snapshotPath, "--today", DEMO_TODAY, "--json", "--out", planPath,
    ]);
    assert.equal(auditResult.status, 0);

    const fromPipeline = JSON.parse(readFileSync(planPath, "utf8"));
    const direct = auditSnapshot(generateDemoSnapshot(), defaultPolicy(DEMO_TODAY));
    assert.deepEqual(
      fromPipeline.operations.map((operation: { id: string }) => operation.id),
      direct.operations.map((operation) => operation.id),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli rules --json lists the built-in rules for agent discovery", async () => {
  const result = await cli(["rules", "--json"]);
  assert.equal(result.status, 0);
  const rules = JSON.parse(result.stdout);
  assert.deepEqual(
    rules.map((rule: { id: string }) => rule.id).sort(),
    [
      "account-single-source",
      "active-deal-account-without-contacts",
      "closing-soon-inactive",
      "duplicate-account-domain",
      "duplicate-contact-email",
      "duplicate-open-deal",
      "missing-deal-account",
      "missing-deal-amount",
      "missing-deal-owner",
      "orphan-account",
      "past-close-date",
      "stale-deal",
    ],
  );
  assert.ok(rules.every((rule: { description: string }) => rule.description.length > 0));
  assert.ok(rules.every((rule: { category: string }) => rule.category.length > 0));
});
