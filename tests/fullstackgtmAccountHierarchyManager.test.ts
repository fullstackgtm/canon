import assert from "node:assert/strict";
import test from "node:test";
import { detectCandidateGroups } from "../engine/src/accountHierarchy/detect.ts";
import { domainOf, normName } from "../engine/src/accountHierarchy/normalize.ts";
import { assertNoOwnerWrites, buildHierarchyProposal, toPatchPlan } from "../engine/src/accountHierarchy/plan.ts";
import { checkPolicyInput, resolvePolicy } from "../engine/src/accountHierarchy/policy.ts";
import { readSalesforceSnapshot } from "../engine/src/accountHierarchy/salesforceSnapshot.ts";
import { checkResearch, verifyResearch, type GroupResearch, type PageReader } from "../engine/src/accountHierarchy/research.ts";
import { researchGroup } from "../engine/src/accountHierarchy/researchAgent.ts";
import type { CanonicalGtmSnapshot } from "../engine/src/types.ts";
import { companionPath } from "../engine/src/cli/accountHierarchy.ts";

const policy = resolvePolicy({
  fillableFields: ["domain", "BillingCountry", "Sales_Region__c"],
  activeContract: { endDateField: "Contract_End__c" },
  customerStatus: { field: "Status__c", rank: ["Existing", "Churned"] },
  ultimateParentField: "Vendor_Parent__c",
  region: { countryField: "BillingCountry", regionField: "Sales_Region__c", byCountry: { France: "EMEA", "United States": "NA" } },
  shellBatches: [{ createdDate: "2026-07-14", createdByName: "Bulk Loader" }],
  poolOwnerNames: ["Pool"],
});

const acct = (id: string, name: string, extra: Record<string, unknown> = {}, raw: Record<string, unknown> = {}) => ({
  id,
  name,
  ownerId: "u-active",
  raw: { CreatedDate: "2020-01-01T00:00:00Z", ...raw },
  ...extra,
});

function snapshot(): CanonicalGtmSnapshot {
  return {
    generatedAt: "2026-11-06T00:00:00.000Z",
    provider: "salesforce",
    users: [
      { id: "u-active", name: "Active Seller", active: true },
      { id: "u-gone", name: "Gone Seller", active: false },
      { id: "u-bulk", name: "Bulk Loader", active: true },
    ],
    accounts: [
      acct("root", "Maison Group SE", { domain: "maison.com" }, { BillingCountry: "France" }),
      // a bulk-created shell duplicating the root by domain
      acct("shell", "Maison", { domain: "maison.com" }, { CreatedDate: "2026-07-14T10:00:00Z", CreatedById: "u-bulk" }),
      // owned brand, no parent today; the vendor says Maison
      acct("brand", "Brand A", { domain: "branda.com" }, { Vendor_Parent__c: "Maison", BillingCountry: "France" }),
      // divested brand still under the root
      acct("sold", "Sold Co", { domain: "sold.com", parentAccountId: "root" }, { Vendor_Parent__c: "Maison" }),
      // same name, different countries: never duplicates
      acct("shop-us", "Shop USA", { domain: "shop.com", parentAccountId: "root" }),
      acct("shop-sg", "Shop Singapore", { domain: "shop.sg", parentAccountId: "root" }),
      // two accounts sharing a domain that research says are different entities (parent brand and its perfume arm)
      acct("couture", "Couture House", { domain: "couture.com" }),
      acct("parfums", "Parfums Couture House", { domain: "couture.com", parentAccountId: "root" }),
      // a duplicate pair where the older record has no contract and the newer one has an active contract
      acct("dup-old", "Gamma Ltd", { domain: "gamma.com", parentAccountId: "root" }, { CreatedDate: "2015-01-01T00:00:00Z" }),
      acct("dup-new", "Gamma", { domain: "gamma.com", parentAccountId: "root", ownerId: "u-gone" }, { CreatedDate: "2024-01-01T00:00:00Z", BillingCountry: "France" }),
      // two duplicates that both have active contracts: held
      acct("both-1", "Delta", { domain: "delta.com", parentAccountId: "root" }),
      acct("both-2", "Delta Inc", { domain: "delta.com", parentAccountId: "root" }),
      // unrelated
      acct("other", "Unrelated", { domain: "other.com" }),
    ],
    contacts: [{ id: "c1", accountId: "dup-old" }],
    deals: [
      { id: "d1", name: "Gamma renewal", accountId: "dup-new", ownerId: "u-active", isWon: true, isClosed: true, raw: { Contract_End__c: "2027-06-30" } },
      { id: "d2", name: "Delta 1", accountId: "both-1", isWon: true, isClosed: true, raw: { Contract_End__c: "2027-01-01" } },
      { id: "d3", name: "Delta 2", accountId: "both-2", isWon: true, isClosed: true, raw: { Contract_End__c: "2027-01-01" } },
    ],
    activities: [],
  };
}

const PAGES: Record<string, string> = {
  "https://maison.example/brands": "Maison Group is home to Brand A and Couture House among its houses.",
  "https://news.example/sold": "Maison completed the sale of Sold Co to Buyer Holdings in September 2026.",
  "https://couture.example/": "Couture House is the parent brand of Parfums Couture House and its fashion line.",
};
const reader: PageReader = async (url) => (url in PAGES ? { ok: true, text: PAGES[url] } : { ok: false, detail: "HTTP 403" });

function research(): GroupResearch {
  const cite = (url: string, quote: string) => ({ url, quote });
  return {
    group: "Maison",
    ultimateParent: { name: "Maison Group SE", accountId: "root", citations: [cite("https://maison.example/brands", "Maison Group is home to Brand A")] },
    researchedAt: "2026-11-06",
    researchedBy: "test",
    entities: [
      { name: "Brand A", status: "owned", accountIds: ["brand"], citations: [cite("https://maison.example/brands", "home to Brand A and Couture House")] },
      { name: "Sold Co", status: "divested", accountIds: ["sold"], ownerNow: "Buyer Holdings", citations: [cite("https://news.example/sold", "completed the sale of Sold Co to Buyer Holdings")] },
      { name: "Couture House", status: "owned", accountIds: ["couture"], citations: [cite("https://maison.example/brands", "home to Brand A and Couture House")] },
      { name: "Parfums Couture House", status: "owned", accountIds: ["parfums"], parent: "Couture House", citations: [cite("https://couture.example/", "the parent brand of Parfums Couture House")] },
      // a claim whose only source can't be read: never an operation
      { name: "Gamma", status: "owned", accountIds: ["dup-old"], citations: [cite("https://blocked.example/", "Gamma is part of Maison Group")], facts: [{ field: "BillingCountry", value: "United States", citations: [cite("https://blocked.example/", "Gamma bills from New York")] }] },
    ],
  };
}

test("normalizing keeps country words and drops legal forms", () => {
  assert.equal(normName("Birkenstock Group B.V. & Co. KG"), "birkenstock");
  assert.equal(normName("Moët Hennessy USA, Inc."), "moet hennessy usa");
  assert.notEqual(normName("Sephora USA"), normName("Sephora Singapore"));
  assert.equal(domainOf("https://www.LVMH.com/en?x=1"), "lvmh.com");
  assert.equal(domainOf("gmail.com", new Set(["gmail.com"])), null);
});

test("detect groups by domain, name and vendor parent, shells first, read-only", () => {
  const snap = snapshot();
  const before = JSON.stringify(snap);
  const report = detectCandidateGroups(snap, policy);
  assert.equal(JSON.stringify(snap), before, "detect must not mutate the snapshot");
  const maison = report.groups.find((g) => g.accountIds.includes("root"))!;
  assert.ok(maison.accountIds.includes("shell") && maison.accountIds.includes("brand"), "domain and vendor-parent joins");
  assert.deepEqual(maison.shellIds, ["shell"]);
  assert.equal(report.groups[0].id, maison.id, "groups with a shell sort first");
  assert.ok(!report.groups.some((g) => g.accountIds.includes("other")));
  assert.ok(!report.groups.some((g) => g.accountIds.includes("shop-us") && g.accountIds.includes("shop-sg") && g.reasons.some((r) => r.startsWith("same name"))));
});

test("research gate: uncited claims and unattested internal notes are rejected", () => {
  const r = research();
  r.entities[0].citations = [];
  assert.throws(() => checkResearch(r), /Brand A: no citation/);
  const r2 = research();
  r2.entities[1].ownerNow = undefined;
  assert.throws(() => checkResearch(r2), /say who owns it now/);
  const r3 = research();
  r3.entities[0].citations = [{ url: "internal:someone", quote: "we know" }];
  assert.throws(() => checkResearch(r3), /needs attestedBy/);
});

test("verbatim gate: verified, quote not found, unreachable, attested", async () => {
  const r = research();
  r.entities[0].citations.push({ url: "https://maison.example/brands", quote: "Maison Group owns Brand A outright" });
  r.entities[1].citations.push({ url: "internal:ops-2026-11-06", quote: "Sold Co stopped billing", attestedBy: "Ops" });
  const v = await verifyResearch(r, { read: reader });
  const result = (prefix: string) => Object.values(v.checks).find((c) => c.quote.startsWith(prefix))?.result;
  assert.equal(result("home to Brand A"), "verified");
  assert.equal(result("Maison Group owns"), "quote_not_found");
  assert.equal(result("Gamma is part"), "unreachable");
  assert.equal(result("Sold Co stopped"), "attested");
  // pages the agent fetched count, so a site that blocks our fetcher can still be verified
  const v2 = await verifyResearch(r, { read: reader, pages: { "https://blocked.example/": "Gamma is part of Maison Group since 2001." } });
  assert.equal(Object.values(v2.checks).find((c) => c.quote.startsWith("Gamma is part"))!.result, "verified");
});

async function proposal() {
  const r = checkResearch(research());
  const verification = await verifyResearch(r, { read: reader });
  return buildHierarchyProposal({ snapshot: snapshot(), research: r, verification, policy, today: "2026-11-06" });
}

test("plan: survivor rules, holds, owner rules and contract flags", async () => {
  const p = await proposal();
  const merges = p.items.filter((i) => i.op === "merge");
  const shellMerge = merges.find((m) => m.op === "merge" && m.loserId === "shell");
  assert.equal(shellMerge?.op === "merge" && shellMerge.survivorId, "root", "the shell loses to the established account");
  const gamma = merges.find((m) => m.op === "merge" && (m.loserId === "dup-old" || m.loserId === "dup-new"));
  assert.ok(gamma && gamma.op === "merge");
  assert.equal(gamma.survivorId, "dup-new", "an active contract wins over age");
  assert.deepEqual(gamma.fill, {}, "the survivor keeps its own values; the duplicate has nothing to fill");
  assert.ok(gamma.warn.some((w) => w.includes("ACTIVE CONTRACT on the survivor")));
  assert.ok(gamma.warn.some((w) => w.includes("Gone Seller is inactive")), "an inactive survivor owner is flagged, not replaced");
  assert.ok(!merges.some((m) => m.op === "merge" && (m.loserId.startsWith("both-") || m.survivorId.startsWith("both-"))), "two active contracts: held");
  assert.ok(p.flags.some((f) => f.includes("more than one duplicate has an active contract")));
  assert.ok(!merges.some((m) => m.op === "merge" && ["couture", "parfums"].includes(m.loserId)), "research-distinct entities are never merged");
  assert.ok(!merges.some((m) => m.op === "merge" && m.loserId.startsWith("shop-")), "country words keep Shop USA and Shop Singapore apart");
});

test("plan: parent moves need a verified citation; facts from unreachable sources are flags", async () => {
  const p = await proposal();
  const moves = p.items.filter((i) => i.op === "set_parent");
  const to = (id: string) => moves.find((m) => m.op === "set_parent" && m.accountId === id);
  assert.equal(to("brand")?.op === "set_parent" && to("brand")!.to, "root");
  assert.equal(to("sold")?.op === "set_parent" && to("sold")!.to, null, "divested: out from under the parent");
  assert.equal(to("parfums")?.op === "set_parent" && to("parfums")!.to, "couture", "an intermediate parent from research");
  assert.equal(to("couture")?.op === "set_parent" && to("couture")!.to, "root");
  assert.ok(!p.items.some((i) => i.op === "set_fields" && i.fields.BillingCountry === "United States"), "unreachable source: no field fix");
  assert.ok(p.flags.some((f) => f.includes("BillingCountry = United States") && f.includes("unreachable")));
  const brandRegion = p.items.find((i) => i.op === "set_fields" && i.accountId === "brand");
  assert.deepEqual(brandRegion?.op === "set_fields" && brandRegion.fields, { Sales_Region__c: "EMEA" });
});

test("patch plan: approval required, CAS before values, merges carry recovery snapshots, no owner writes", async () => {
  const plan = toPatchPlan(await proposal(), "2026-11-06T00:00:00.000Z");
  assert.equal(plan.status, "needs_approval");
  assert.ok(plan.operations.every((o) => o.approvalRequired));
  const merge = plan.operations.find((o) => o.operation === "merge_records")!;
  assert.equal(merge.riskLevel, "high");
  assert.ok(merge.recoverySnapshot?.length);
  const sold = plan.operations.find((o) => o.objectId === "sold")!;
  assert.equal(sold.operation, "clear_field");
  assert.equal(sold.beforeValue, "root", "compare-and-set against today's parent");
  assert.ok(plan.evidence?.some((e) => e.sourceSystem === "web" && e.metadata?.verification === "verified"));
  assert.ok(plan.operations.filter((o) => o.sourceRuleOrPolicy === "hierarchy.parent").every((o) => o.evidenceIds?.length));
  assert.ok(!plan.operations.some((o) => /owner/i.test(o.field ?? "")));
  assert.throws(
    () => assertNoOwnerWrites([{ ...merge, operation: "set_field", field: "ownerId", objectType: "deal" }], policy),
    /deal owners never change/,
  );
});

const sse = (items: unknown[]) =>
  new Response(items.map((item) => `data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  });

test("research agent: ChatGPT tool loop, our own page fetches, verbatim gate on what we fetched", async () => {
  const requests: Array<{ headers: Record<string, string>; body: { input: Array<{ type: string; output?: string }>; store: boolean } }> = [];
  const submit = {
    ultimateParent: { name: "Maison Group SE", citations: [{ url: "https://maison.example/brands", quote: "Maison Group is home to Brand A", note: "" }] },
    entities: [
      { name: "Brand A", status: "owned", accountIds: ["brand"], parent: null, ownerNow: null, citations: [{ url: "https://maison.example/brands", quote: "home to Brand A and Couture House", note: "" }], facts: [] },
    ],
  };
  const turns = [
    sse([{ type: "reasoning", encrypted_content: "x" }, { type: "function_call", name: "fetch_page", call_id: "c1", arguments: JSON.stringify({ url: "https://maison.example/brands" }) }]),
    sse([{ type: "function_call", name: "submit_research", call_id: "c2", arguments: JSON.stringify(submit) }]),
  ];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    requests.push({ headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return turns.shift()!;
  }) as unknown as typeof fetch;
  const snap = snapshot();
  const run = await researchGroup({
    llm: { provider: "chatgpt", apiKey: "token", chatgptAccountId: "acct", model: "test-model" },
    group: "Maison",
    rootId: "root",
    accounts: snap.accounts.filter((a) => ["root", "brand"].includes(a.id)),
    snapshot: snap,
    policy,
    today: "2026-11-06",
    read: reader,
    fetchImpl,
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].headers["chatgpt-account-id"], "acct");
  assert.equal(requests[0].body.store, false);
  const replay = requests[1].body.input;
  assert.ok(replay.some((i) => i.type === "reasoning"), "reasoning is replayed on unstored requests");
  assert.ok(replay.some((i) => i.type === "function_call_output" && i.output?.includes("home to Brand A")), "our fetch result goes back to the model");
  assert.deepEqual(Object.keys(run.pages), ["https://maison.example/brands"]);
  assert.ok(Object.values(run.verification.checks).every((c) => c.result === "verified"));
  assert.equal(run.research.researchedBy, "test-model on ChatGPT (web search, fetched pages), unreviewed");
  await assert.rejects(
    researchGroup({ llm: { provider: "anthropic", apiKey: "k" }, group: "Maison", rootId: "root", accounts: [], snapshot: snap, policy, fetchImpl }),
    /ChatGPT sign-in/,
  );
});

test("policy input: owners are never fillable and approval can't be turned off", () => {
  assert.throws(() => checkPolicyInput({ fillableFields: ["OwnerId"] }), /Owners are never filled/);
  assert.throws(() => checkPolicyInput({ rules: { requireApproval: false } }), /can't be turned off/);
  assert.throws(() => checkPolicyInput([]), /JSON object/);
  assert.equal(checkPolicyInput({ rules: { flagActiveContracts: false } }).rules.neverChangeAccountOwners, true);
});

test("Salesforce snapshot: SELECTs only, policy fields included when the org has them", async () => {
  const sent: string[] = [];
  const query = async (soql: string) => {
    sent.push(soql);
    if (soql.includes("FROM Account")) return [{ attributes: { type: "Account" }, Id: "001A", Name: "Acme", Website: "https://www.acme.com", Website_Domain__c: "acme.com", ParentId: "001P", Tier__c: "Gold" }];
    if (soql.includes("FROM Opportunity")) return [{ Id: "006A", AccountId: "001A", Name: "Renewal", IsWon: true, IsClosed: true, End__c: "2027-01-01" }];
    return [];
  };
  const describe = async (o: "Account" | "Opportunity") => new Set(o === "Account" ? ["Website_Domain__c", "Tier__c"] : ["End__c"]);
  const snap = await readSalesforceSnapshot(query, describe, resolvePolicy({ customerStatus: { field: "Tier__c", rank: ["Gold"] }, ultimateParentField: "Missing__c", activeContract: { endDateField: "End__c" } }));
  assert.ok(sent.every((q) => q.startsWith("SELECT ")));
  const accountQuery = sent.find((q) => q.includes("FROM Account"))!;
  assert.ok(accountQuery.includes("Tier__c") && !accountQuery.includes("Missing__c"), "only fields the org has");
  assert.ok(sent.find((q) => q.includes("FROM Opportunity"))!.includes("End__c"));
  assert.equal(snap.accounts[0].domain, "acme.com");
  assert.equal(snap.accounts[0].parentAccountId, "001P");
  assert.equal((snap.accounts[0].raw as Record<string, unknown>).attributes, undefined);
  assert.equal(snap.deals[0].isWon, true);
});

test("plan: two research claims that put accounts under each other don't both become moves", async () => {
  const r = research();
  r.entities = [
    { name: "Brand A", status: "owned", accountIds: ["brand"], parent: "Couture House", citations: [{ url: "https://maison.example/brands", quote: "home to Brand A and Couture House" }] },
    { name: "Couture House", status: "owned", accountIds: ["couture"], parent: "Brand A", citations: [{ url: "https://maison.example/brands", quote: "home to Brand A and Couture House" }] },
  ];
  const verification = await verifyResearch(checkResearch(r), { read: reader });
  const p = buildHierarchyProposal({ snapshot: snapshot(), research: r, verification, policy, today: "2026-11-06" });
  const moves = p.items.filter((i) => i.op === "set_parent");
  assert.equal(moves.length, 1);
  assert.ok(p.flags.some((f) => f.includes("parent cycle")));
});

test("CLI companion files never overwrite the research file", () => {
  assert.equal(companionPath("r/lvmh.json", "pages"), "r/lvmh.pages.json");
  assert.equal(companionPath("r/lvmh.JSON", "verification"), "r/lvmh.verification.json");
  assert.equal(companionPath("r/lvmh", "pages"), "r/lvmh.pages.json");
});
