import assert from "node:assert/strict";
import test from "node:test";
import { mapOpportunity, planDealRoles, stageKey, type SfStage } from "../engine/src/sync/salesforceImport/deals.ts";
import { planImportedPipelines, resolvePipelines } from "../convex/lib/pipelines.ts";
import { resolveObjectDef, STANDARD_OBJECTS } from "../convex/lib/objects/registry.ts";

const RT_NEW = "012Sm0000000001IAA";
const RT_RENEW = "012Sm0000000002IAA";

test("a closed-lost opportunity becomes a deal in its record type's stage, in cents, with its owner's member", () => {
  const ctx = {
    stages: new Map([[stageKey(RT_RENEW, "Renewal Lost"), "Renewal Lost"], [stageKey(RT_NEW, "Prospecting"), "Prospecting"]]),
    owners: new Map([["005Sm0000000001IAA", { sfUserId: "005Sm0000000001IAA", name: "Avery", email: "avery@x.example", memberId: "user_avery" }]]),
    defaultCurrency: "USD",
  };
  const row = {
    Id: "006Sm0000000007", Name: " Acme renewal ", StageName: "Renewal Lost", RecordTypeId: RT_RENEW, Amount: "1234.5", Probability: "", CloseDate: "2026-03-31",
    IsClosed: "true", IsWon: "false", ForecastCategoryName: "Omitted", Type: "Renewal", OwnerId: "005Sm0000000001IAA", AccountId: "001Sm0000000003",
    CurrencyIsoCode: "eur", CreatedDate: "2025-01-02T03:04:05.000+0000", SystemModstamp: "2025-02-01T00:00:00.000+0000",
  };
  const defaults = new Map<string, SfStage>([["Renewal Lost", { name: "Renewal Lost", probability: 0, forecastCategory: "closed_lost" }]]);
  assert.deepEqual(mapOpportunity(row, ctx, defaults), {
    ok: {
      sfId: "006Sm0000000007IAA", name: "Acme renewal", closeDate: "2026-03-31", stage: "Renewal Lost", currency: "EUR", amount: 123450,
      forecastCategory: "closed_lost", probability: 0, isClosed: true, isWon: false, dealType: "renewal", revenueType: "recurring",
      ownerSfId: "005Sm0000000001IAA", memberId: "user_avery", accountSfId: "001Sm0000000003IAA",
      createdAt: Date.parse("2025-01-02T03:04:05.000Z"), modifiedAt: Date.parse("2025-02-01T00:00:00.000Z"),
    },
  });
});

test("contact roles map to Canon roles; the primary keeps a single role a second person also maps to, whatever the row order", () => {
  const rows = [
    { Id: "00KSm0000000003", OpportunityId: "006Sm0000000001", ContactId: "003Sm0000000003", Role: "Decision Maker", IsPrimary: "false", CreatedDate: "" },
    { Id: "00KSm0000000002", OpportunityId: "006Sm0000000001", ContactId: "003Sm0000000002", Role: "Economic Buyer", IsPrimary: "false", CreatedDate: "" },
    { Id: "00KSm0000000001", OpportunityId: "006Sm0000000001", ContactId: "003Sm0000000001", Role: "Executive Sponsor", IsPrimary: "true", CreatedDate: "" },
    { Id: "00KSm0000000004", OpportunityId: "006Sm0000000001", ContactId: "003Sm0000000001", Role: "Champion", IsPrimary: "false", CreatedDate: "" },
    { Id: "00KSm0000000005", OpportunityId: "006Sm0000000001", ContactId: "003Sm0000000005", Role: "Vendor Manager", IsPrimary: "false", CreatedDate: "" },
  ];
  const expected = {
    deals: [{
      opportunitySfId: "006Sm0000000001IAA",
      roles: [
        { roleSfId: "00KSm0000000001MAA", contactSfId: "003Sm0000000001IAA", role: "executive" },
        { roleSfId: "00KSm0000000002MAA", contactSfId: "003Sm0000000002IAA", role: "signer" },
        { roleSfId: "00KSm0000000003MAA", contactSfId: "003Sm0000000003IAA", role: "involved" },
        { roleSfId: "00KSm0000000005MAA", contactSfId: "003Sm0000000005IAA", role: "involved" },
      ],
    }],
    rejected: [{ sfId: "00KSm0000000004MAA", reason: "Contact already has a role on this opportunity; Canon keeps one per person" }],
  };
  assert.deepEqual(planDealRoles(rows), expected);
  assert.deepEqual(planDealRoles([...rows].reverse()), expected);
});

test("two sales processes become two pipelines with a stage each for a shared name, and planning again writes nothing", () => {
  const options = (resolveObjectDef(STANDARD_OBJECTS.deal).byApiName.get("stage") as unknown as { options: Array<{ value: string; label: string; active: boolean }> }).options;
  const processes = [
    { name: "New Business", recordTypeIds: [RT_NEW], stages: [{ name: "Prospecting", probability: 10, forecastCategory: "pipeline" as const }, { name: "Closed Won", probability: 100, forecastCategory: "closed_won" as const }] },
    { name: "Renewals", recordTypeIds: [RT_RENEW], stages: [{ name: "Prospecting", probability: 20, forecastCategory: "pipeline" as const }] },
  ];
  const first = planImportedPipelines(options, [], processes);
  assert.deepEqual(first.writes.map((w) => w.kind === "insert" && [w.name, w.stages.map((s) => s.value)]), [
    ["Sales pipeline", ["prospecting", "qualification", "proposal", "negotiation", "closed_won", "closed_lost"]],
    ["New Business", ["Prospecting", "Closed Won"]],
    ["Renewals", ["Prospecting (Renewals)"]],
  ]);
  assert.deepEqual(first.placements, [
    { recordTypeId: RT_NEW, stageName: "Prospecting", value: "Prospecting" },
    { recordTypeId: RT_NEW, stageName: "Closed Won", value: "Closed Won" },
    { recordTypeId: RT_RENEW, stageName: "Prospecting", value: "Prospecting (Renewals)" },
  ]);
  const stored = first.writes.map((w, i) => ({ id: `p${i}`, name: w.name, stages: w.stages, createdAt: i }));
  const again = planImportedPipelines(first.options, stored, processes);
  assert.deepEqual([again.writes, again.options.length, again.placements], [[], first.options.length, first.placements]);
  assert.deepEqual(resolvePipelines(first.options, stored).map((p) => [p.name, p.stages.map((s) => s.label)]), [
    ["Sales pipeline", ["Prospecting", "Qualification", "Proposal", "Negotiation", "Closed won", "Closed lost"]],
    ["New Business", ["Prospecting", "Closed Won"]],
    ["Renewals", ["Prospecting"]],
  ]);
});
