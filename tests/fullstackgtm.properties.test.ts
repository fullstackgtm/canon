import assert from "node:assert/strict";
import test from "node:test";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { auditSnapshot, defaultPolicy } from "../engine/src/audit.ts";
import { applyPatchPlan } from "../engine/src/connector.ts";
import { scoreProspectAgainstIcp } from "../engine/src/icp.ts";
import { signApproval } from "../engine/src/integrity.ts";
import { mergeSnapshots, normalizeDomain } from "../engine/src/merge.ts";
import { buildStripeBackfillPlan } from "../engine/src/backfill.ts";
import { buildRevenueContracts, type StripeRevenueInvoice, type StripeRevenueSubscription } from "../engine/src/revenueContracts.ts";
import type { CanonicalGtmSnapshot, GtmConnector, PatchOperation, PatchPlan } from "../engine/src/types.ts";

const settings = { profile: "ci", testCases: Number(process.env.CANONCRM_HEGEL_CASES ?? 150), seed: 42 };
const label = gs.text({ alphabet: "abcdefghijklmnopqrstuvwxyz", minSize: 1, maxSize: 12 });
const amount = gs.integers({ minValue: 0, maxValue: 100_000 });
const policy = defaultPolicy("2026-05-03");

function snapshot(provider: CanonicalGtmSnapshot["provider"] = "hubspot"): CanonicalGtmSnapshot {
  return { generatedAt: "2026-05-01", provider, accounts: [], contacts: [], users: [], deals: [], activities: [] };
}

test("audit leaves input untouched and requires review for generated operations", () => {
  hegel.test((tc) => {
    const source = snapshot();
    source.deals = tc.draw(gs.arrays(gs.record({
      amount,
      name: label,
      isClosed: gs.booleans(),
      closeDate: gs.sampledFrom(["2026-04-01", "2026-06-01", undefined]),
      nextStep: gs.sampledFrom(["Call buyer", undefined]),
    }), { maxSize: 12 })).map((deal, index) => ({ ...deal, id: `deal-${index}` }));
    const before = structuredClone(source);
    const plan = auditSnapshot(source, policy);
    assert.deepEqual(source, before);
    assert.equal(plan.dryRun, true);
    assert.equal(plan.status, plan.operations.length ? "needs_approval" : "draft");
    for (const operation of plan.operations) assert.equal(operation.approvalRequired, true);
  }, settings);
});

test("a plain DNS name normalizes idempotently across case, www and path variants", () => {
  hegel.test((tc) => {
    const domain = `company-${tc.draw(label)}.example`;
    const scheme = tc.draw(gs.sampledFrom(["", "http://", "https://"]));
    const prefix = tc.draw(gs.sampledFrom(["", "www."]));
    const path = tc.draw(gs.sampledFrom(["", "/", "/about"]));
    const normalized = normalizeDomain(` ${scheme}${prefix}${domain.toUpperCase()}${path} `);
    assert.equal(normalized, domain);
    assert.equal(normalizeDomain(normalized), normalized);
  }, settings);
});

test("a website URL's query and fragment do not affect its account domain", () => {
  hegel.test((tc) => {
    const domain = `${tc.draw(label)}.example`;
    tc.assume(!domain.startsWith("www."));
    const suffix = tc.draw(gs.sampledFrom(["?", "#", "/?"]));
    const website = `https://${domain}${suffix}${tc.draw(label)}`;
    tc.note(website);
    assert.equal(normalizeDomain(website), new URL(website).hostname);
  }, settings);
});

test("merging coalesces domain variants and keeps first source precedence", () => {
  hegel.test((tc) => {
    const domain = `company-${tc.draw(label)}.example`;
    const first = snapshot("hubspot");
    const second = snapshot("salesforce");
    const industry = tc.draw(label);
    first.accounts = [{ id: "a", domain, name: "First", industry }];
    second.accounts = [{ id: "b", domain: `https://www.${domain.toUpperCase()}/`, name: "Second", industry: `${industry} tech` }];
    for (const [primary, secondary] of [[first, second], [second, first]]) {
      const { snapshot: merged, report } = mergeSnapshots([primary, secondary]);
      assert.equal(merged.accounts.length, 1);
      assert.equal(merged.accounts[0].industry, primary.accounts[0].industry);
      assert.deepEqual(merged.accounts[0].identities, [primary, secondary].map((source) => ({
        provider: source.provider, externalId: source.accounts[0].id,
      })));
      assert.ok(report.conflicts.some(({ field }) => field === "industry"));
    }
  }, settings);
});

test("merging keeps a contact linked to its canonical account and owner", () => {
  hegel.test((tc) => {
    const id = tc.draw(label);
    const source = snapshot();
    const accountId = `account-${id}`;
    const ownerId = tc.draw(gs.booleans()) ? accountId : `user-${id}`;
    source.accounts = [{ id: accountId, name: "Account", ownerId, domain: `company-${id}.example` }];
    source.users = [{ id: ownerId, name: "Owner", email: `owner-${id}@example.com` }];
    source.contacts = [{ id: `contact-${id}`, accountId, ownerId }];
    const matching = snapshot("salesforce");
    matching.accounts = [{ ...source.accounts[0], id: "other-account", ownerId: "other-owner" }];
    matching.users = [{ ...source.users[0], id: "other-owner" }];

    for (const sources of [[source], [matching, source]]) {
      const { snapshot: merged } = mergeSnapshots(sources);
      assert.equal(merged.contacts[0].accountId, merged.accounts[0].id);
      assert.equal(merged.contacts[0].ownerId, merged.users[0].id);
      assert.equal(merged.accounts[0].ownerId, merged.users[0].id);
    }
  }, settings);
});

const operation: PatchOperation = {
  id: "next-step",
  operation: "set_field",
  objectType: "deal",
  objectId: "deal-1",
  field: "nextStep",
  reason: "Set the next step",
  beforeValue: "initial",
  afterValue: "proposed",
  riskLevel: "low",
  approvalRequired: true,
};

test("approval signatures bind attempted changes to the value, target, and override", () => {
  hegel.test((tc) => {
    const key = Buffer.alloc(32, 42);
    const value = tc.draw(label);
    const candidate = { ...operation, afterValue: value };
    const digest = signApproval(candidate, value, key);
    assert.equal(digest, signApproval({ ...candidate }, value, key));
    assert.notEqual(digest, signApproval({ ...candidate, afterValue: `${value} changed` }, value, key));
    assert.notEqual(digest, signApproval({ ...candidate, objectId: `deal-${value}` }, value, key));
    assert.notEqual(digest, signApproval(candidate, `${value} changed`, key));
  }, settings);
});

test("strict ICP persona scoring requires a title or headline match even with matching level and department", () => {
  hegel.test((tc) => {
    const title = tc.draw(label);
    const department = tc.draw(label);
    const level = tc.draw(label);
    const prospect = { jobTitle: title, jobLevel: level, jobDepartment: department };
    const keyword = `${title} lead`;
    const icp = {
      name: "Strict persona",
      firmographics: {},
      persona: { titleKeywords: [keyword], jobLevels: [level], departments: [department] },
      scoring: { requireTitleKeyword: true },
    };
    const headline = tc.draw(gs.sampledFrom([undefined, "Unknown", keyword.toUpperCase()]));
    assert.equal(scoreProspectAgainstIcp({ ...prospect, headline }, icp).score, headline === keyword.toUpperCase() ? 1 : 0);
  }, settings);
});

type ApplyState = {
  live: string;
  expected: string;
  planned: { beforeValue: string; afterValue: string };
};

const emptyPlan = auditSnapshot(snapshot(), policy);

const applyMachine: hegel.stateful.StateMachine<ApplyState> = {
  rules: {
    planNextStep(tc, state) {
      state.planned = { beforeValue: state.live, afterValue: tc.draw(label) };
    },
    editProvider(tc, state) {
      state.live = state.expected = tc.draw(label);
    },
    async attemptApply(tc, state) {
      const approved = tc.draw(gs.booleans());
      const eligible = approved && state.expected === state.planned.beforeValue;
      const plan: PatchPlan = {
        ...emptyPlan,
        status: "needs_approval",
        operations: [{ ...operation, ...state.planned }],
      };
      const connector: GtmConnector = {
        provider: "hubspot",
        fetchSnapshot: async () => snapshot(),
        readField: async () => state.live,
        applyOperation: async (write) => {
          assert.ok(eligible, "ineligible operation reached the provider");
          assert.ok(typeof write.afterValue === "string");
          state.live = write.afterValue;
          return { status: "applied", operationId: write.id };
        },
      };
      const result = await applyPatchPlan(connector, plan, { approvedOperationIds: approved ? [operation.id] : [] });
      assert.equal(result.results[0]?.status, eligible ? "applied" : approved ? "conflict" : "skipped");
      if (eligible) state.expected = state.planned.afterValue;
    },
  },
  invariants: {
    providerMatchesModel: { check: (_tc, state) => assert.equal(state.live, state.expected), alwaysCheck: true },
  },
};

test("apply follows a compare-and-set model across replans, external edits, approvals and retries", async () => {
  await hegel.testAsync((tc) => hegel.stateful.runAsync(tc, applyMachine, {
    live: "initial",
    expected: "initial",
    planned: { beforeValue: "initial", afterValue: "proposed" },
  }, { stepCount: 15 }), settings);
});

// Revenue contracts (docs/revenue-contracts.md): one booking per subscription, never per invoice.
function revenueFixture(tc: hegel.TestCase) {
  const subscriptionCount = tc.draw(gs.integers({ minValue: 0, maxValue: 4 }));
  const subscriptions: StripeRevenueSubscription[] = Array.from({ length: subscriptionCount }, (_, i) => ({
    id: `sub_${i}`,
    status: tc.draw(gs.sampledFrom(["active", "canceled", "past_due", "trialing"])),
    customerName: `Customer ${tc.draw(label)}`,
    startDate: "2026-01-01",
    lines: [{ quantity: 1, unitAmount: tc.draw(amount), interval: tc.draw(gs.sampledFrom(["month", "year", "week"])) }],
  }));
  const invoiceCount = tc.draw(gs.integers({ minValue: 0, maxValue: 12 }));
  const invoices: StripeRevenueInvoice[] = Array.from({ length: invoiceCount }, (_, i) => {
    const paid = tc.draw(amount);
    const subscription = tc.draw(gs.integers({ minValue: -1, maxValue: subscriptionCount }));
    return {
      id: `in_${i}`,
      subscriptionId: subscription >= 0 ? `sub_${subscription}` : undefined,
      status: "paid",
      amountDue: paid,
      amountPaid: paid,
      amountRemaining: 0,
    };
  });
  return { subscriptions, invoices };
}

test("every invoice attaches to exactly one known contract or is listed unattached, and grouping ignores order", () => {
  hegel.test((tc) => {
    const { subscriptions, invoices } = revenueFixture(tc);
    const result = buildRevenueContracts(subscriptions, invoices);
    const attached = result.contracts.flatMap((contract) => contract.invoiceIds);
    assert.equal(new Set(attached).size, attached.length);
    assert.equal(attached.length + result.unattached.length, invoices.length);
    assert.deepEqual(buildRevenueContracts([...subscriptions].reverse(), [...invoices].reverse()), result);
  }, settings);
});

test("adding invoices never changes how many deals the backfill books", () => {
  hegel.test((tc) => {
    const { subscriptions, invoices } = revenueFixture(tc);
    const cut = tc.draw(gs.integers({ minValue: 0, maxValue: invoices.length }));
    const book = (rows: StripeRevenueInvoice[]) => {
      const { contracts } = buildRevenueContracts(subscriptions, rows);
      return buildStripeBackfillPlan(contracts, snapshot(), { now: () => new Date("2026-07-01T00:00:00.000Z") })
        .plan.operations.filter((operation) => operation.objectType === "deal")
        .map((operation) => operation.id);
    };
    const deals = book(invoices.slice(0, cut));
    assert.equal(deals.length, subscriptions.length);
    assert.deepEqual(book(invoices), deals);
  }, settings);
});
