import assert from "node:assert/strict";
import test from "node:test";
import { isOurSide, planSuggestions, suggestionReason, teamEntry, teamOf } from "../convex/lib/calls/suggestions.ts";
import { groundedFacts, groundedSuggestionRead, type ConversationFactsContext } from "../convex/lib/conversations/facts.ts";
import { accessOf } from "../convex/lib/access.ts";
import { loadConvex } from "./convexHandlers.ts";

const none = { companyNames: {}, titles: {}, opportunity: null };

test("a meeting suggests the other side's new people with a name, their new company, and a quoted deal only when none is open", () => {
  const attendees = [
    { email: "jamie@brightwave.example", name: "Jamie Fox" },
    { email: "noname@brightwave.example", name: null },
    { email: "sam@acme.example", name: "Sam Lee" },
    { email: "pat@gmail.com", name: "Pat Kim" },
  ];
  const read = {
    companyNames: { "brightwave.example": "Brightwave Labs" },
    titles: { "jamie@brightwave.example": { value: "Head of RevOps", evidence: "I'm Head of RevOps here." } },
    opportunity: { name: "Brightwave - CRM", amount: 4_000_000, evidence: "We have $40,000 budgeted." },
  };
  const base = { callKey: "c1", attendees, knownEmails: new Set(["sam@acme.example"]), knownDomains: new Set(["acme.example"]), hasDeal: false, recent: true, read };
  assert.deepEqual(planSuggestions(base).map((s) => [s.kind, s.key, s.values.name, s.values.title ?? null]), [
    ["account", "brightwave.example", "Brightwave Labs", null],
    ["contact", "jamie@brightwave.example", "Jamie Fox", "Head of RevOps"],
    ["contact", "pat@gmail.com", "Pat Kim", null],
    ["deal", "call:c1", "Brightwave - CRM", null],
  ]);
  // Someone on personal email joins the meeting's one other company; with two to choose from, they wait for research, without one.
  assert.equal(planSuggestions({ ...base, meetingDomains: ["brightwave.example"] }).find((s) => s.key === "pat@gmail.com")?.values.domain, "brightwave.example");
  assert.equal(planSuggestions({ ...base, meetingDomains: ["brightwave.example", "acme.example"] }).find((s) => s.key === "pat@gmail.com")?.values.domain, undefined);
  // An open deal matched, or an old meeting: no deal suggestion; nobody new: nothing at all.
  assert.ok(!planSuggestions({ ...base, hasDeal: true }).some((s) => s.kind === "deal"));
  assert.ok(planSuggestions({ ...base, recent: false }).some((s) => s.kind === "deal")); // an older meeting still suggests a new deal
  assert.deepEqual(planSuggestions({ ...base, attendees: [attendees[2]!], read: none }), []);
});

const context: ConversationFactsContext = {
  source: { kind: "call", id: "call" }, title: "Brightwave intro", day: "2026-10-10", summary: null,
  text: "Jamie Fox: I'm Head of Revenue Ops at Brightwave Labs. We have $40,000 budgeted to replace our CRM and we want to sign before December 15.",
  deal: null, people: [], newPeople: [{ email: "jamie@brightwave.example", name: "Jamie Fox" }], newDomains: ["brightwave.example"], askOpportunity: true,
};

test("the suggestion parts of the answer keep only quoted titles and opportunities, asked-for company names, and stated amounts", () => {
  const read = groundedSuggestionRead({
    companyNames: [{ domain: "brightwave.example", name: "Brightwave Labs" }, { domain: "other.example", name: "Other" }],
    titles: [{ email: "Jamie@brightwave.example", value: "Head of Revenue Ops", evidence: "I'm Head of Revenue Ops at Brightwave Labs." }],
    opportunity: { name: "Brightwave Labs - CRM", amountDollars: 40000, closeDate: "2026-12-15", nextStep: null, evidence: "We have $40,000 budgeted to replace our CRM" },
  }, context);
  assert.deepEqual(read.companyNames, { "brightwave.example": "Brightwave Labs" });
  assert.deepEqual(Object.keys(read.titles), ["jamie@brightwave.example"]);
  assert.deepEqual(read.opportunity, { name: "Brightwave Labs - CRM", evidence: "We have $40,000 budgeted to replace our CRM", amount: 4_000_000, closeDate: "2026-12-15" });
  // A paraphrased buying signal is no opportunity; an amount the quote never states is dropped.
  assert.equal(groundedSuggestionRead({ opportunity: { name: "X", amountDollars: 5, closeDate: null, nextStep: null, evidence: "They have a budget for a new CRM." } }, context).opportunity, null);
  assert.equal(groundedSuggestionRead({ opportunity: { name: "X", amountDollars: 99, closeDate: null, nextStep: null, evidence: "we want to sign before December 15" } }, context).opportunity?.amount, undefined);
});

test("a malformed close date drops only itself, not the rest of the call's proposals (#340)", () => {
  const withDeal = { ...context, deal: { name: "D", stage: null, nextStep: null, closeDate: null } };
  const facts = groundedFacts({ nextStep: { value: "Sign", evidence: "we want to sign before December 15." }, closeDate: { value: "2026-13-01", evidence: "we want to sign before December 15." }, titles: [] }, withDeal);
  assert.deepEqual(facts.map((f) => f.attribute), ["nextStep"]);
});

test("adding a suggestion holds its fields to the role's field rules: a read-only title is not written this way either", async () => {
  const access = accessOf({ userId: "u", role: "rep", rules: [{ object: "contact", fields: [{ apiName: "title", level: "readOnly" }] }] });
  const writes: string[] = [];
  const mod = loadConvex(["callSuggestions.ts"], {
    "records.ts": (real) => ({
      ...real,
      requireCaller: async () => ({ orgId: "org", userId: "u", role: "rep", access }),
      clientFor: () => ({ upsertAccounts: async () => (writes.push("account"), { ids: ["acc_1"] }), upsertContacts: async () => (writes.push("contact"), { ids: ["con_1"] }), listRegister: async () => ({ rows: [] }) }),
    }),
  })["callSuggestions.ts"]!;
  const suggestion = { _id: "s1", orgId: "org", userId: "u", callId: "call", kind: "contact", key: "jamie@b.example", status: "pending", values: { email: "jamie@b.example", name: "Jamie Fox", title: "CFO", domain: "b.example" } };
  const ctx = { runQuery: async () => [suggestion], runMutation: async () => ({ status: "applied" }) };
  await assert.rejects(mod.create!.handler(ctx, { ids: ["s1"] }), /title is read-only/);
  assert.deepEqual(writes, []);
});

test("our team: members, their company domains and listed entries count as our side; each meeting says why it suggested nothing", () => {
  assert.deepEqual(["Fullstackgtm.com", "@acme.io", "ryan@old.example", "not a domain", "x@"].map(teamEntry), ["fullstackgtm.com", "acme.io", "ryan@old.example", null, null]);
  const team = teamOf(["ryan@seller.example.org", "pat@gmail.com"], ["fullstackgtm.com"]);
  assert.deepEqual(["ryan@fullstackgtm.com", "sam@seller.example.org", "pat@gmail.com", "kim@gmail.com", "casey@northwind.example"].map((e) => isOurSide(team, e)), [true, true, true, false, false]);
  assert.deepEqual([
    suggestionReason({ ourMeeting: false, others: 2, planned: 0 }),
    suggestionReason({ ourMeeting: true, others: 0, planned: 0 }),
    suggestionReason({ ourMeeting: true, others: 2, planned: 0 }),
    suggestionReason({ ourMeeting: true, others: 2, planned: 3 }),
  ], ["not_our_meeting", "no_one_else", "all_known", "suggested"]);
});

test("a person on personal email joins the one company their meeting has that the caller sees; with none or two, they are skipped and the rest added", async () => {
  const access = accessOf({ userId: "u", role: "admin" });
  const run = async (picked: Array<Record<string, unknown>>, meetingAccounts: string[], visible: string[], websites?: Array<{ id: string; domain: string }>) => {
    const writes: string[] = [];
    const mod = loadConvex(["callSuggestions.ts"], {
      "records.ts": (real) => ({
        ...real,
        requireCaller: async () => ({ orgId: "org", userId: "u", role: "admin", access }),
        clientFor: () => ({
          mode: "fake",
          upsertAccounts: async (_ws: string, body: { records: Array<{ domain: string }> }) => (writes.push(`account:${body.records[0]!.domain}`), { ids: [`acc_${body.records[0]!.domain}`] }),
          upsertContacts: async (_ws: string, body: { records: Array<{ fullName: string; accountId?: string }> }) => (writes.push(`contact:${body.records[0]!.fullName}:${body.records[0]!.accountId}`), { ids: ["con_1"] }),
          listRegister: async () => ({ rows: [] }),
        }),
        callerClient: () => ({ get: async (_ws: string, id: string) => (visible.includes(id) ? { id } : null), getContact: async () => null }),
      }),
    })["callSuggestions.ts"]!;
    const ctx = {
      runQuery: async (ref: unknown) => (String(ref) === "internal.callSuggestions.pendingOf" ? picked : String(ref) === "internal.callSuggestions.callContext" ? { accountIds: meetingAccounts, contactIds: [], title: "M", startAt: 0, notes: "" } : null),
      runMutation: async () => ({ status: "applied", dealStreamId: null }),
    };
    const r = await mod.create!.handler(ctx, { ids: picked.map((p) => p._id), ...(websites ? { websites } : {}) });
    return JSON.parse(JSON.stringify([r.skipped, writes]));
  };
  const pat = { _id: "s1", orgId: "org", userId: "u", callId: "call", kind: "contact", key: "pat@gmail.com", status: "pending", values: { email: "pat@gmail.com", name: "Pat Kim" } };
  const newCo = { _id: "s2", orgId: "org", userId: "u", callId: "call", kind: "account", key: "b.example", status: "pending", values: { domain: "b.example", name: "B" } };
  assert.deepEqual(await run([pat], ["acc_a"], ["acc_a"]), [[], ["contact:Pat Kim:acc_a"]]); // the one company on the meeting
  assert.deepEqual(await run([pat], ["acc_a"], []), [["Pat Kim"], []]); // the caller cannot see it
  assert.deepEqual(await run([pat, newCo], ["acc_a"], ["acc_a"]), [["Pat Kim"], ["account:b.example"]]); // two to choose from
  // A website the reviewer corrected: the company's named people follow the correction, not research's guess.
  const guessed = { ...newCo, _id: "s3", values: { domain: "guess.example", name: "Example Buyer" } };
  const eric = { _id: "s4", orgId: "org", userId: "u", callId: "call", kind: "contact", key: "named:guess.example:eric", status: "pending", values: { name: "Eric", domain: "guess.example" } };
  const corrected = await run([guessed, eric], [], [], [{ id: "s3", domain: "real.example" }]);
  assert.deepEqual(corrected, [[], ["account:real.example", "contact:Eric:acc_real.example"]]);
});

test("dismissing a bulk selection of 200 takes them in one call, and only the caller's pending ones", async () => {
  const mod = loadConvex(["callSuggestions.ts"], {
    "lib.ts": (real) => ({ ...real, requireUser: async () => ({ _id: "u", orgId: "org" }) }),
  })["callSuggestions.ts"]!;
  const rows = new Map(Array.from({ length: 200 }, (_, i) => [`s${i}`, { _id: `s${i}`, orgId: "org", userId: i === 0 ? "someone" : "u", status: i === 1 ? "created" : "pending" }]));
  const patched: string[] = [];
  const ctx = { db: { get: async (id: string) => rows.get(id) ?? null, patch: async (id: string) => void patched.push(id) } };
  await mod.dismiss!.handler(ctx, { ids: [...rows.keys()] });
  assert.equal(patched.length, 198);
  assert.ok(!patched.includes("s0") && !patched.includes("s1"));
});
