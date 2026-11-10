import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_SIGNATURES, ProfileBuilder, agreement, autoMap, candidatesFor, canonAttribute, canonFactValue, canonOwnedFields, canonRecords, canonValue, conceptKeywords, consolidationStatus, coverageWaterfall,
  decide, decideDestination, destinationFits, destinationsOf, enrichmentColumns, fieldDefinition, enrichmentValue, hubspotColumn, isCatchAll, mapOf, mappedShare, matchesConcept, pairKey,
  parseQuantity, picklistParity, quantityCandidates, resolveValue, salesforceColumn, salesforceOwned, standardKind, suggestScales, toCsv, translateOption,
  writableColumn, type Candidate, type Column, type CrmRecord, type FieldDefinition, type Policy,
} from "../convex/lib/consolidate.ts";

const OPTIONS = [
  { label: "Retail", value: "retail" },
  { label: "Agency", value: "agency" },
  { label: "Food & Beverage", value: "food_beverage" },
  { label: "Other", value: "other" },
];

test("discovery keeps the concept's picklists and free-text columns, not checkboxes", () => {
  const keywords = conceptKeywords("industry");
  assert.ok(keywords.includes("sector"));
  const vm = hubspotColumn("companies", { name: "vm_industry__c", label: "VM Industry", type: "enumeration", fieldType: "select", options: OPTIONS });
  const multi = hubspotColumn("companies", { name: "industries", label: "Industries", type: "enumeration", fieldType: "checkbox", options: [] });
  const lead = salesforceColumn("Lead", { name: "Industry", label: "Industry", type: "string", custom: false });
  assert.equal(vm?.kind, "picklist");
  assert.equal(vm?.options.length, 4);
  assert.equal(multi, null);
  assert.equal(lead?.kind, "text");
  assert.ok(matchesConcept(vm!, keywords) && matchesConcept(lead!, keywords));
});

test("a profile counts fill and values, and agreement compares columns after mapping", () => {
  const builder = new ProfileBuilder(["industry", "vm_industry__c"]);
  builder.add({ industry: "Retail", vm_industry__c: "retail" });
  builder.add({ industry: "Retail", vm_industry__c: "agency" });
  builder.add({ industry: " Marketing Agency ", vm_industry__c: "agency" }, true);
  builder.add({ industry: null, vm_industry__c: "retail" });
  const profile = builder.result("companies", 10, false);
  assert.equal(profile.read, 4);
  assert.equal(profile.linked, 1);
  assert.equal(profile.columns.industry!.filled, 3);
  assert.deepEqual(profile.columns.industry!.values[0], ["Retail", 2]);

  const map = mapOf([{ from: "marketing agency", to: "agency", origin: "user", confidence: 1 }]);
  const pair = profile.pairs[pairKey("industry", "vm_industry__c")]!;
  const r = agreement(pair, true, (side, value) => (side === "a" ? resolveValue(value, map, OPTIONS)?.to ?? null : value));
  assert.equal(r.both, 3);
  assert.deepEqual([r.agree, r.compared], [2, 3]);
});

test("a profile records which columns each record fills, and folds rare combinations into other", () => {
  const builder = new ProfileBuilder(["a", "b"]);
  builder.add({ a: "x" });
  builder.add({ a: "x", b: " " });
  builder.add({ b: "y" }, true);
  builder.add({});
  assert.deepEqual(builder.result("companies", null, false).signatures, { columns: ["a", "b"], masks: [[1, 2], [6, 1], [0, 1]], other: 0 });

  const columns = Array.from({ length: 13 }, (_, i) => `c${i}`);
  const many = new ProfileBuilder(columns);
  for (let i = 0; i < MAX_SIGNATURES + 2; i++) many.add(Object.fromEntries(columns.map((c, bit) => [c, i & (1 << bit) ? "v" : null])));
  const sig = many.result("Account", null, false).signatures!;
  assert.deepEqual([sig.masks.length, sig.other], [MAX_SIGNATURES, 2]);
});

test("the coverage waterfall cascades sources in order, keeps Salesforce-owned records apart and counts folded records as blank", () => {
  const builder = new ProfileBuilder(["vm_industry__c", "industry", "zi_industry"]);
  builder.add({ vm_industry__c: "retail", industry: "Retail" });
  builder.add({ industry: "Retail" });
  builder.add({ industry: "Retail", zi_industry: "Shops" });
  builder.add({ zi_industry: "Shops" });
  builder.add({});
  builder.add({ industry: "Retail" }, true);
  const profile = builder.result("companies", null, false);
  const shares: Record<string, number> = { "companies.industry": 0.5, "companies.zi_industry": 1 };
  const args = { profile, target: "companies.vm_industry__c", sources: ["companies.industry", "companies.zi_industry"], share: (k: string) => shares[k]! };

  assert.deepEqual(coverageWaterfall({ ...args, mode: "blanks" }), {
    total: 6, alreadySet: 1, owned: 1, blank: 1.5, exact: false,
    bySource: [{ key: "companies.industry", adds: 1 }, { key: "companies.zi_industry", adds: 1.5 }],
  });
  assert.deepEqual(coverageWaterfall({ ...args, mode: "overwrite" }), {
    total: 6, alreadySet: 0.5, owned: 1, blank: 1.5, exact: false,
    bySource: [{ key: "companies.industry", adds: 1.5 }, { key: "companies.zi_industry", adds: 1.5 }],
  });
  const folded = coverageWaterfall({ ...args, profile: { ...profile, signatures: { ...profile.signatures!, other: 4 } }, mode: "blanks" });
  assert.deepEqual([folded.total, folded.blank], [10, 5.5]);

  assert.equal(mappedShare([["Retail", 3], ["Widgets", 1]], mapOf([]), OPTIONS, 0.9), 0.75);
});

test("exact matches map ignoring case, punctuation and '&' vs 'and'; catch-alls are recognised", () => {
  const entries = autoMap(["food and beverage", "RETAIL", "Widgets"], OPTIONS);
  assert.deepEqual(entries.map((e) => [e.from, e.to]), [["food and beverage", "food_beverage"], ["retail", "retail"]]);
  assert.ok(isCatchAll(OPTIONS[3]!));
  assert.ok(!isCatchAll(OPTIONS[0]!));
  // A user's explicit "leave unmapped" wins over a value that names an option.
  assert.equal(resolveValue("Retail", mapOf([{ from: "retail", to: null, origin: "user", confidence: 1 }]), OPTIONS), null);
  // An entry made for another standard column names no option here: it is ignored, never written.
  assert.equal(resolveValue("Software", mapOf([{ from: "software", to: "COMPUTER_SOFTWARE", origin: "user", confidence: 1 }]), OPTIONS), null);
});

test("Salesforce owns HubSpot contacts synced with a Lead as well as with a Contact", () => {
  assert.ok(salesforceOwned("contacts", { salesforceleadid: "00Q1" }));
  assert.ok(salesforceOwned("companies", { salesforceaccountid: "0011" }));
  assert.ok(!salesforceOwned("contacts", { salesforceaccountid: "0011", salesforcecontactid: "" }));
});

test("decisions: protected values stay, blanks-only keeps disagreements, the threshold drops weak mappings", () => {
  const policy: Policy = { mode: "blanks", protectedValues: ["agency"], minConfidence: 0.9 };
  const strong: Candidate = { column: "Industry", raw: "Retail", value: "retail", confidence: 1 };
  const weak: Candidate = { column: "ZoomInfo", raw: "Shops", value: "retail", confidence: 0.6 };
  assert.equal(decide(null, [strong], policy).kind, "fill");
  assert.equal(decide("retail", [strong], policy).kind, "agree");
  assert.equal(decide("agency", [strong], policy).kind, "protected");
  assert.equal(decide("other", [strong], policy).kind, "kept");
  assert.equal(decide("other", [strong], { ...policy, mode: "overwrite" }).kind, "change");
  assert.equal(decide(null, [weak], policy).kind, "noSource");
  // Priority order: the first usable source decides.
  const agency: Candidate = { column: "UserGems", raw: "Agencies", value: "agency", confidence: 1 };
  assert.equal(decide(null, [weak, agency, strong], policy).proposed, "agency");
});

test("picklist parity calls out a label matching under another internal value, and writes translate to it", () => {
  const hubspot = [
    { label: "Retail", value: "Retail" },
    { label: "Agency", value: "agency" },
  ];
  const { rows, mirrorOnly } = picklistParity(OPTIONS, hubspot);
  assert.deepEqual(rows.map((r) => r.status), ["valueDiffers", "same", "missing", "missing"]);
  assert.deepEqual(mirrorOnly, []);
  assert.equal(translateOption("retail", OPTIONS, hubspot), "Retail");
  assert.equal(translateOption("food_beverage", OPTIONS, hubspot), null);
});

test("CSV quotes cells with commas, quotes and newlines", () => {
  assert.equal(toCsv(["a", "b"], [["x, y", 'say "hi"'], [null, 2]]), 'a,b\r\n"x, y","say ""hi"""\r\n,2');
});

test("a consolidation's status comes from its setup and latest run, a writing run first", () => {
  const ready = { stage: "ready" as const, target: "companies.vm_industry__c", settingsVersion: 3 };
  const run = (status: "previewing" | "ready" | "applying" | "applied" | "undoing" | "undone" | "failed", extra = {}) => ({
    status, settingsVersion: 3, writes: 12, createdAt: 100, updatedAt: 400, ...extra,
  });
  const outcome = { applied: 10, conflict: 1, failed: 1 };
  const sections = [{ counts: { fill: 9, change: 2 } }, { counts: { fill: 1, change: 0 } }];
  assert.deepEqual(
    [
      consolidationStatus({ stage: "discovering" }, null),
      consolidationStatus({ stage: "profiling", target: ready.target }, null),
      consolidationStatus({ stage: "ready" }, null),
      consolidationStatus(ready, null),
      consolidationStatus(ready, run("ready", { settingsVersion: 2 })),
      consolidationStatus(ready, run("previewing")),
      consolidationStatus(ready, run("ready", { sections })),
      consolidationStatus({ ...ready, stage: "profiling" }, run("applying")),
      consolidationStatus(ready, run("applied", { appliedAt: 200, applied: outcome })),
      consolidationStatus(ready, run("undoing")),
      consolidationStatus(ready, run("undone", { undoneAt: 300, undone: outcome })),
      consolidationStatus(ready, run("failed", { failedDuring: "apply", error: "rate limited" })),
      consolidationStatus({ stage: "error", error: "HubSpot refused" }, null),
    ],
    [
      { state: "findingColumns" },
      { state: "findingColumns" },
      { state: "chooseStandard" },
      { state: "readyToPreview", changedSince: null },
      { state: "readyToPreview", changedSince: 100 },
      { state: "previewing" },
      { state: "readyToApply", previewedAt: 100, fill: 10, change: 2, writes: 12 },
      { state: "applying", writes: 12 },
      { state: "applied", at: 200, outcome },
      { state: "undoing" },
      { state: "undone", at: 300, outcome },
      { state: "stopped", during: "apply", error: "rate limited" },
      { state: "stopped", during: "columns", error: "HubSpot refused" },
    ],
  );
  // A defined field is ready to preview without a standard column; shadow sections don't count as writes.
  assert.deepEqual(consolidationStatus({ stage: "ready", kind: "category", level: "account" }, null), { state: "readyToPreview", changedSince: null });
  const shadow = [{ mode: "shadow", counts: { fill: 5, change: 1 } }, { counts: { fill: 2, change: 0 } }];
  assert.deepEqual(consolidationStatus({ ...ready, settingsVersion: 1 }, run("ready", { settingsVersion: 1, sections: shadow })), {
    state: "readyToApply", previewedAt: 100, fill: 2, change: 0, writes: 12,
  });
});

const picklist = (object: Column["object"], name: string, options = OPTIONS): Column => ({
  key: `${object}.${name}`, object, name, label: name, kind: "picklist", options, standard: false,
});
const text = (object: Column["object"], name: string): Column => ({ key: `${object}.${name}`, object, name, label: name, kind: "text", options: [], standard: false });

test("a field set up before destinations reads its standard and counterpart as its definition and first destinations", () => {
  const columns = [picklist("companies", "industry"), picklist("Account", "Industry")];
  const legacy = { target: "companies.industry", mirror: "Account.Industry" };
  assert.deepEqual(fieldDefinition(legacy, columns), { measure: "category", level: "account", options: OPTIONS });
  assert.deepEqual(destinationsOf(legacy), [
    { column: "companies.industry", mode: "review" },
    { column: "Account.Industry", mode: "review" },
  ]);
  const defined = { kind: "category" as const, level: "account" as const, options: OPTIONS.slice(0, 2), destinations: [{ column: "Account.Industry", mode: "shadow" as const }] };
  assert.deepEqual(fieldDefinition({ ...defined, target: "companies.industry" }, columns)?.options, OPTIONS.slice(0, 2));
  assert.deepEqual(destinationsOf({ ...defined, ...legacy }), defined.destinations);
  assert.equal(fieldDefinition({}, columns), null);
});

test("destinations are writable columns of the field's kind on its records, in either CRM", () => {
  const field: FieldDefinition = { measure: "category", level: "account", options: OPTIONS };
  assert.ok(destinationFits(picklist("companies", "industry"), field));
  assert.ok(destinationFits(picklist("Account", "Industry"), field));
  assert.ok(!destinationFits(picklist("contacts", "industry"), field), "person-level column");
  assert.ok(!destinationFits(picklist("Lead", "Industry"), field), "Canon doesn't write Leads");
  assert.ok(!destinationFits(text("Account", "Sector"), field), "free text");
  assert.ok(!destinationFits({ ...picklist("Account", "Industry"), readOnly: true }, field));
});

test("records HubSpot links to Salesforce form one Canon record; unlinked records stand alone", () => {
  const records: CrmRecord[] = [
    { object: "companies", id: "1", values: { salesforceaccountid: "001000000000001AAA" } },
    { object: "companies", id: "2", values: { salesforceaccountid: "001000000000001" } },
    { object: "companies", id: "3", values: { salesforceaccountid: null } },
    { object: "Account", id: "001000000000001AAA", values: {} },
    { object: "Account", id: "001000000000002AAA", values: {} },
  ];
  const groups = canonRecords(records).map((g) => g.map((r) => `${r.object}:${r.id}`).sort());
  assert.deepEqual(groups.sort((a, b) => b.length - a.length), [
    ["Account:001000000000001AAA", "companies:1", "companies:2"],
    ["companies:3"],
    ["Account:001000000000002AAA"],
  ]);
});

test("a Canon value blends sources across CRMs in priority order, then each destination gets it in its own values", () => {
  const field: FieldDefinition = { measure: "category", level: "account", options: OPTIONS };
  const zi = text("companies", "zi_industry");
  const sfIndustry = text("Account", "Industry");
  const policy: Policy = { mode: "overwrite", protectedValues: [], minConfidence: 0.9 };
  const map = mapOf([{ from: "consumer goods", to: "food_beverage", origin: "user", confidence: 1 }]);
  const group: CrmRecord[] = [
    { object: "companies", id: "1", values: { zi_industry: null, salesforceaccountid: "001A" } },
    { object: "Account", id: "001A", values: { Industry: "Consumer Goods" } },
  ];
  // The HubSpot source is blank, so the Salesforce one decides, through the map.
  const value = canonValue(group, [zi, sfIndustry], field, map, [], policy);
  assert.equal(value?.value, "food_beverage");
  assert.equal(value?.evidence.column, "Industry (Salesforce Accounts)");
  assert.equal(value?.evidence.source, "Account.Industry");
  // A destination whose option has another internal value gets its own; one without the option is skipped.
  const sfPick = picklist("Account", "VM_Industry__c", [{ label: "Food & Beverage", value: "F&B" }, { label: "Retail", value: "Retail" }]);
  assert.deepEqual(decideDestination(null, value, field, sfPick, policy).proposed, "F&B");
  const narrow = picklist("Account", "Narrow__c", [{ label: "Retail", value: "retail" }]);
  assert.equal(decideDestination("retail", value, field, narrow, policy).kind, "missingOption");
  // Protected values are in the field's terms and hold in every destination.
  assert.equal(decideDestination("Retail", value, field, sfPick, { ...policy, protectedValues: ["retail"] }).kind, "protected");
  assert.equal(decideDestination(null, null, field, sfPick, policy).kind, "noSource");
});

test("a quantity's Canon value combines amounts across CRMs and is written to each destination's precision", () => {
  const field: FieldDefinition = { measure: "quantity", level: "account", options: [] };
  const hs: Column = { key: "companies.annualrevenue", object: "companies", name: "annualrevenue", label: "Annual Revenue", kind: "number", options: [], standard: true };
  const sf: Column = { key: "Account.AnnualRevenue", object: "Account", name: "AnnualRevenue", label: "Annual Revenue", kind: "number", options: [], standard: true, decimals: 0 };
  const zi: Column = { key: "companies.zi_revenue", object: "companies", name: "zi_revenue", label: "ZoomInfo Revenue", kind: "number", options: [], standard: false };
  const group: CrmRecord[] = [
    { object: "companies", id: "1", values: { zi_revenue: "21000", salesforceaccountid: "001A" } },
    { object: "Account", id: "001A", values: { AnnualRevenue: "19000000.4" } },
  ];
  const policy: Policy = { mode: "blanks", protectedValues: [], minConfidence: 0.9, combine: "mean" };
  const value = canonValue(group, [zi, sf], field, mapOf([]), [{ column: "companies.zi_revenue", factor: 1000, origin: "user" }], policy);
  assert.equal(value?.amount, 20000000.2);
  assert.equal(decideDestination(null, value, field, sf, policy).proposed, "20000000");
  // A destination that keeps decimals gets them.
  assert.equal(decideDestination(null, value, field, { ...sf, decimals: 2 }, policy).proposed, "20000000.2");
  assert.equal(decideDestination("19500000", value, field, hs, policy).kind, "agree");
});

test("an industry consolidation reads PDL and Crustdata industry as read-only sources", () => {
  const columns = enrichmentColumns(conceptKeywords("industry"));
  assert.deepEqual(columns.map((c) => [c.key, c.label, c.kind, c.enrichment]), [
    ["companies.@pdl.industry", "PDL industry", "text", "pdl"],
    ["companies.@crustdata.industry", "Crustdata industry", "text", "crustdata"],
  ]);
  assert.deepEqual(enrichmentColumns(["headcount"]).map((c) => c.name), ["@pdl.numberofemployees", "@crustdata.numberofemployees"]);
  assert.equal(writableColumn(columns[0]!), false);
  assert.equal(writableColumn({ object: "companies", name: "vm_industry__c" }), true);
});

test("a PDL industry fills a blank through the value map, and its evidence names the source column", () => {
  const match = { source: "pdl" as const, values: { industry: "retail stores", numberofemployees: 51 } };
  const values = { "@pdl.industry": enrichmentValue("@pdl.industry", match), "@crustdata.industry": enrichmentValue("@crustdata.industry", match) };
  assert.deepEqual(values, { "@pdl.industry": "retail stores", "@crustdata.industry": null });
  assert.equal(enrichmentValue("@pdl.numberofemployees", match), "51");

  const sources = enrichmentColumns(["industry"]);
  const map = mapOf([{ from: "retail stores", to: "retail", origin: "user", confidence: 1 }]);
  const decision = decide(null, candidatesFor(values, sources, map, OPTIONS), { mode: "blanks", protectedValues: [], minConfidence: 0.9 });
  assert.deepEqual(decision, { kind: "fill", current: null, proposed: "retail", evidence: { column: "PDL industry", raw: "retail stores", value: "retail", confidence: 1, source: "companies.@pdl.industry" } });
});

test("a Canon field owns the HubSpot company columns it writes and the free-fill fields its concept names", () => {
  const owned = canonOwnedFields([
    { _id: "a", concept: "Industry", keywords: ["industry", "sector"], target: "companies.vm_industry__c", mirror: "Account.VM_Industry__c" },
    { _id: "b", concept: "Country", keywords: ["country"] },
    { _id: "c", concept: "Sector", keywords: ["sector"], destinations: [{ column: "companies.sector", mode: "shadow" }, { column: "companies.old_sector", mode: "off" }] },
  ]);
  assert.deepEqual(owned, [
    { property: "vm_industry__c", concept: "Industry", consolidationId: "a" },
    { property: "industry", concept: "Industry", consolidationId: "a" },
    { property: "sector", concept: "Sector", consolidationId: "c" },
  ]);
});

test("number columns are quantities; calculated and read-only ones are sources, never the standard", () => {
  const revenue = hubspotColumn("companies", { name: "annualrevenue", label: "Annual Revenue", type: "number", fieldType: "number", hubspotDefined: true })!;
  const formula = hubspotColumn("companies", { name: "rev_calc", label: "Revenue calc", type: "number", fieldType: "calculation_equation", calculated: true })!;
  const sf = salesforceColumn("Account", { name: "AnnualRevenue", label: "Annual Revenue", type: "currency", scale: 0, updateable: true })!;
  assert.equal(revenue.kind, "number");
  assert.ok(standardKind(revenue));
  assert.ok(!standardKind(formula));
  assert.deepEqual([sf.kind, sf.decimals], ["number", 0]);
  assert.equal(enrichmentColumns(conceptKeywords("employees")).every((c) => c.kind === "number"), true);
});

test("values read as amounts: plain numbers, units, ranges at their midpoint, open bounds less surely", () => {
  assert.deepEqual(parseQuantity("23,500,000"), { amount: 23_500_000, confidence: 1 });
  assert.deepEqual(parseQuantity("$23.5M"), { amount: 23_500_000, confidence: 0.8 });
  assert.deepEqual(parseQuantity("$10M - $50M"), { amount: 30_000_000, confidence: 0.9 });
  assert.deepEqual(parseQuantity("10-50 million"), { amount: 30_000_000, confidence: 0.9 });
  assert.deepEqual(parseQuantity("5,000+"), { amount: 5000, confidence: 0.6 });
  assert.equal(parseQuantity("Software"), null);
});

test("quantity decisions combine the sources by the policy's method and agree within the tolerance", () => {
  const sources = [
    { key: "companies.zi_revenue", name: "zi_revenue", label: "ZoomInfo" },
    { key: "companies.ug_range", name: "ug_range", label: "UserGems" },
    { key: "companies.ug_bound", name: "ug_bound", label: "Bound" },
  ];
  const scales = [{ column: "companies.zi_revenue", factor: 1000, origin: "user" as const }];
  const candidates = quantityCandidates({ zi_revenue: "20000", ug_range: "$10M-$50M", ug_bound: "1B+" }, sources, scales);
  assert.deepEqual(candidates.map((c) => c.amount), [20_000_000, 30_000_000, 1_000_000_000]);
  const policy = (p: Partial<Policy>): Policy => ({ mode: "overwrite", protectedValues: [], minConfidence: 0.9, ...p });
  // The open bound reads at 60%, under the threshold: it never counts.
  assert.equal(decide(null, candidates, policy({ combine: "first" }), "quantity").proposed, "20000000");
  assert.equal(decide(null, candidates, policy({ combine: "mean" }), "quantity").proposed, "25000000");
  assert.equal(decide(null, candidates, policy({ combine: "max" }), "quantity").evidence?.column, "UserGems");
  assert.equal(decide("21000000", candidates, policy({ combine: "first" }), "quantity").kind, "agree");
  assert.equal(decide("21000000", candidates, policy({ combine: "first", tolerance: 0.01 }), "quantity").kind, "change");
  assert.equal(decide("90000000", candidates, policy({ mode: "blanks" }), "quantity").kind, "kept");
  const mean = decide(null, candidates, policy({ combine: "median" }), "quantity");
  assert.equal(mean.evidence?.raw, "ZoomInfo: 20000; UserGems: $10M-$50M");
});

test("a source a power of 1,000 off the standard gets that scale suggested, from the records holding both", () => {
  const builder = new ProfileBuilder(["annualrevenue", "zi_revenue"]);
  for (let i = 1; i <= 6; i++) builder.add({ annualrevenue: String(i * 1_000_000), zi_revenue: String(i * 1000 * (i % 2 ? 1.05 : 1)) });
  const profile = builder.result("companies", 6, false);
  assert.equal(profile.columns.annualrevenue!.quantity!.read, 6);
  const suggested = suggestScales({
    profiles: new Map([["companies", profile]]),
    destinations: [{ object: "companies", name: "annualrevenue" }],
    sources: [{ key: "companies.zi_revenue", object: "companies", name: "zi_revenue" }],
    scales: [],
  });
  assert.deepEqual(suggested, [{ column: "companies.zi_revenue", factor: 1000, origin: "auto" }]);
});

test("a field's values are saved in the standard attribute it is about, else its own custom one", () => {
  const category: FieldDefinition = { measure: "category", level: "account", options: OPTIONS };
  const amount: FieldDefinition = { measure: "quantity", level: "account", options: [] };
  assert.equal(canonAttribute("Industry", category, ["companies.vm_industry__c"]), "industry", "by name");
  assert.equal(canonAttribute("Vertical", category, ["Account.Industry"]), "industry", "by a column the sync reads into it");
  assert.equal(canonAttribute("Revenue", amount, []), "annualRevenue");
  assert.equal(canonAttribute("Revenue", category, []), "custom.revenue", "a revenue band is not an amount");
  assert.equal(canonAttribute("EHR vendor", category, []), "custom.ehr_vendor");
  assert.equal(canonAttribute("Industry", { ...category, level: "person" }, []), "custom.industry");
  const evidence: Candidate = { column: "Industry (Salesforce Accounts)", raw: "Consumer Goods", value: "food_beverage", confidence: 1 };
  assert.equal(canonFactValue({ value: "food_beverage", evidence }, category, "industry"), "Food & Beverage", "an option's label, not a CRM value");
  assert.equal(canonFactValue({ value: "12.5", amount: 12.5, evidence }, amount, "annualRevenue"), 1250, "annual revenue in cents");
  assert.equal(canonFactValue({ value: "300", amount: 300, evidence }, amount, "employees"), 300);
});
