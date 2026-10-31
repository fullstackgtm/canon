import assert from "node:assert/strict";
import test from "node:test";
import { classifyPerson, findCompanyPeople, signedReviewReplies, type PeoplePorts } from "../convex/lib/tam/companyPeople.ts";
import { findVerifiedWorkEmail, guessAndVerifyEmail, type EmailPattern, type VerifiedEmail } from "../convex/lib/emailFinder.ts";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const context = { companyType: "Paving contractor", whatYouSell: "Estimating software", buyerTitles: ["Project director"], departments: ["Estimating", "Operations", "Engineering"] };
const person = (fullName: string, title?: string) => ({ fullName, ...(title ? { title } : {}), url: "https://paving.example/team" });
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

test("titles classify by words and buying department before model fallback, keeping its reasoning", async () => {
  const results = [];
  for (const title of ["Owner", "Co-founder", "President", "CEO", "General Manager", "Senior Estimator", "Project Director", "Operations Team Lead", "Lead Backend Engineer", "Account manager", "Homeowner liaison"]) {
    results.push((await classifyPerson(person("Ada Brown", title), context)).role);
  }
  assert.deepEqual(results, ["decision_maker", "decision_maker", "decision_maker", "decision_maker", "decision_maker", "decision_maker", "decision_maker", "champion", "champion", "other", "other"]);
  const modeled = await classifyPerson({ ...person("Ada Brown", "Commercial strategist"), headline: "Runs bids" }, context, async (prompt) => {
    assert.match(prompt, /Paving contractor/); assert.match(prompt, /Estimating software/); assert.match(prompt, /Commercial strategist, Runs bids/);
    return { role: "champion", reasoning: "They influence bid preparation." };
  });
  assert.deepEqual(modeled, { role: "champion", reasoning: "They influence bid preparation." });
});

function ports(overrides: Partial<PeoplePorts> = {}): PeoplePorts {
  return { paid: false, address: "1 Main St", context, find: async () => [], suppressed: async () => false, existing: () => false,
    email: async () => ({ email: null, emailStatus: "invalid" }), keep: async (p) => p.fullName, ...overrides };
}
test("ordered sources run before keep-one fallback; paid steps skip visibly at zero provider spend", async () => {
  const calls: string[] = [];
  const result = await findCompanyPeople(ports({ find: async (source) => { calls.push(source); return source === "linkedin_any" ? [person("Sam Brown", "Craftsperson"), person("Bea White", "Assistant")] : []; } }));
  assert.deepEqual(calls, ["linkedin_titles", "linkedin_any", "website_staff"]);
  assert.deepEqual(result.people.map((p) => [p.fullName, p.role, p.source, p.emailStatus, p.sendable]), [["Sam Brown", "other", "linkedin_any", "not_checked", false]]);
  assert.equal(result.credits, 1);
  assert.equal(result.notes.length, 3);
  const upgraded = await findCompanyPeople(ports({ find: async (source) => source === "linkedin_any" ? [person("Sam Brown")] : source === "website_staff" ? [person("Sam Brown", "Owner")] : [] }));
  assert.deepEqual(upgraded.people.map((p) => [p.fullName, p.role, p.source]), [["Sam Brown", "decision_maker", "website_staff"]]);
});
test("suppressed names, existing contacts and rejected writes are free; only qualified kept people and valid emails charge", async () => {
  const calls: string[] = [];
  const result = await findCompanyPeople(ports({ paid: true,
    find: async (source) => { calls.push(source); return source === "website_staff" ? [person("Suppressed Name", "Owner"), person("Existing Person", "President"), person("Jane Brown", "CEO"), person("Bea White", "Operations Lead"), person("Rejected Person", "Estimator"), person("Other Person", "Assistant")] : []; },
    suppressed: async (name) => name === "Suppressed Name", existing: (p) => p.fullName === "Existing Person",
    email: async (p) => p.fullName === "Jane Brown" ? { email: "jane@paving.example", emailStatus: "valid" } : { email: null, emailStatus: "catch_all" },
    keep: async (p) => p.fullName === "Rejected Person" ? null : p.fullName,
  }));
  assert.deepEqual(calls, ["linkedin_titles", "linkedin_any", "website_staff", "review_replies"]);
  assert.deepEqual(result.people.map((p) => [p.fullName, p.role, p.sendable]), [["Jane Brown", "decision_maker", true], ["Bea White", "champion", false]]);
  assert.equal(result.credits, 7);
  assert.deepEqual(result.sourceCounts, { linkedin_titles: 0, linkedin_any: 0, website_staff: 2, review_replies: 0, exa_owner: 0 });
  const owner = await findCompanyPeople(ports({ paid: true, find: async (source) => source === "exa_owner" ? [person("Owner Person", "Owner")] : [] }));
  assert.deepEqual(owner.people.map((p) => [p.fullName, p.source]), [["Owner Person", "exa_owner"]]);
  let erased = false;
  const erasedDuringLookup = await findCompanyPeople(ports({ paid: true, find: async (source) => source === "website_staff" ? [person("Erased Person", "Owner")] : [], suppressed: async () => erased,
    email: async () => { erased = true; return { email: "erased@paving.example", emailStatus: "valid" }; }, keep: async () => { throw new Error("Suppressed person reached writer"); },
  }));
  assert.deepEqual([erasedDuringLookup.people, erasedDuringLookup.credits], [[], 0]);
});
test("review replies require a signed full name and preserve the owner's quote", () => {
  assert.deepEqual(signedReviewReplies([{ text: "We appreciate it!\nJane Brown", url: "https://maps.google.com/review" }, { text: "Thank you for visiting", url: "https://maps.google.com/review" }, { text: "Thanks!\nJane", url: "https://maps.google.com/review" }]), [{ fullName: "Jane Brown", title: "Owner", url: "https://maps.google.com/review", quote: "We appreciate it!\nJane Brown" }]);
});
test("email waterfall learns a verified domain pattern and uses it first for the next person; catch-all is never sendable", async () => {
  let knownPattern: EmailPattern | undefined;
  const seen: string[] = [];
  const verify = async (email: string): Promise<VerifiedEmail> => { seen.push(email); return { email: email.split("@")[0] === "abrown" ? email : null, emailStatus: email.startsWith("a") && email.split("@")[0] === "abrown" ? "valid" : "invalid", provider: "treg:millionverifier" }; };
  const first = await guessAndVerifyEmail({ fullName: "Ada Brown", domain: "paving.example", verify, find: async () => { throw new Error("Finder must be last"); }, learn: async (p) => { knownPattern = p; } });
  assert.equal(first.email, "abrown@paving.example"); assert.equal(knownPattern, "flast");
  seen.length = 0;
  const second = await guessAndVerifyEmail({ fullName: "Amy Brown", domain: "paving.example", knownPattern, verify, find: async () => null, learn: async () => {} });
  assert.deepEqual([second.email, seen], ["abrown@paving.example", ["abrown@paving.example"]]);
  const catchAll = await guessAndVerifyEmail({ fullName: "Sam Brown", domain: "paving.example", verify: async () => ({ email: null, emailStatus: "catch_all", provider: "treg:bounceban" }), find: async () => null, learn: async () => {} });
  assert.deepEqual(catchAll, { email: null, emailStatus: "catch_all", provider: "treg:millionverifier" });
});

test("shared email HTTP path stays offline with paid calls off, upgrades a catch-all only after verification, and marks Hunter hits paid", async () => {
  const oldPaid = process.env.TREG_PAID_CALLS;
  const calls: string[] = [], patterns: string[] = [];
  const opts = { token: "fixture", fullName: "Jane Brown", domain: "paving.example", meta: { customer: "org" }, learn: async (p: EmailPattern) => { patterns.push(p); }, allowFreeFinder: async () => false, allowPaidFinder: async () => false, receipt: async () => {}, fetchImpl: (async (url: string | URL | Request) => {
    const endpoint = String(url).split("/call/")[1].split("?")[0]; calls.push(endpoint);
    return new Response(JSON.stringify(endpoint === "millionverifier.people.email.verify" ? { result: "catch_all" } : { status: "success", result: "deliverable", is_accept_all: false }), { status: 200 });
  }) as typeof fetch };
  try {
    delete process.env.TREG_PAID_CALLS;
    assert.deepEqual(await findVerifiedWorkEmail(opts), { email: null, emailStatus: "not_checked", provider: "treg:millionverifier" });
    assert.deepEqual(calls, []);
    process.env.TREG_PAID_CALLS = "on";
    const result = await findVerifiedWorkEmail(opts);
    assert.deepEqual(result, { email: "jane.brown@paving.example", emailStatus: "valid", provider: "treg:bounceban" });
    assert.deepEqual(calls, ["millionverifier.people.email.verify", "bounceban.people.email.verify"]);
    assert.deepEqual(patterns, ["first.last"]);
    const hunter = await findVerifiedWorkEmail({ ...opts, allowPaidFinder: async () => true, fetchImpl: (async (url: string | URL | Request) => {
      const u = new URL(String(url)), endpoint = u.pathname.split("/call/")[1];
      if (endpoint === "hunter.people.email.find") return new Response(JSON.stringify({ data: { email: "jb@paving.example" } }), { status: 200 });
      return new Response(JSON.stringify({ result: u.searchParams.get("email") === "jb@paving.example" ? "ok" : "invalid" }), { status: 200 });
    }) as typeof fetch });
    assert.deepEqual(hunter, { email: "jb@paving.example", emailStatus: "valid", provider: "treg:hunter", paid: true }, "a Hunter hit counts against the monthly allowance");
  } finally { if (oldPaid === undefined) delete process.env.TREG_PAID_CALLS; else process.env.TREG_PAID_CALLS = oldPaid; }
});

const handlers = loadConvex(["companyPeople.ts"], {
  "lib.ts": (real) => ({ ...real, getCurrentUser: async () => ({ _id: "user", orgId: "org", role: "admin" }) }),
  "permissions.ts": (real) => ({ ...real, roleIn: async () => "admin", accessFor: async () => ({ role: "admin", userId: "user", teamOwners: [], rules: {} }) }),
  "lib/icpsInterface.ts": (real) => ({ ...real, readIcps: async () => [] }),
})["companyPeople.ts"];
test("a job hold charges only saved contacts and found emails, releases unused credits, and is idempotent", async () => {
  const oldPaid = process.env.TREG_PAID_CALLS;
  process.env.TREG_PAID_CALLS = "on";
  try {
    const db = memoryDb({ organizations: [{ _id: "org", creditUnit: "credits", creditBalanceMicro: 0 }], users: [{ _id: "user", orgId: "org", role: "admin" }] });
    const ctx = { db, scheduler: { runAfter: async () => null } };
    const runId = await handlers.begin.handler(ctx, { accountId: "account", domain: "paving.example" });
    assert.equal(await handlers.begin.handler(ctx, { accountId: "account", domain: "paving.example" }), runId);
    assert.equal(db.rows("creditLedger")[0].amountMicro, -30000000);
    await handlers.claim.handler(ctx, { runId });
    const base = { ...person("Ada Brown", "Owner"), role: "decision_maker", reasoning: "Title matches owner.", source: "website_staff", email: "ada@paving.example", emailStatus: "valid", sendable: true, contactId: "contact" };
    await handlers.saved.handler(ctx, { runId, person: base });
    await handlers.saved.handler(ctx, { runId, person: base });
    await handlers.saved.handler(ctx, { runId, person: { ...base, fullName: "Bea White", contactId: "second", email: null, emailStatus: "invalid", sendable: false } });
    await handlers.finish.handler(ctx, { runId, failed: false, notes: [] });
    await handlers.finish.handler(ctx, { runId, failed: true, notes: [] });
    const run = await db.get(runId);
    assert.deepEqual(plain({ status: run!.status, spentCredits: run!.spentCredits, sourceCounts: run!.sourceCounts }), { status: "done", spentCredits: 7, sourceCounts: { website_staff: 2 } });
    assert.equal(db.rows("creditLedger").reduce((sum, r) => sum + Number(r.amountMicro), 0), -7000000);
    assert.equal((await db.get("org"))!.freeCreditsUsedMicro, 7000000);
    const failedRun = await handlers.begin.handler(ctx, { accountId: "account", domain: "paving.example" });
    await handlers.finish.handler(ctx, { runId: failedRun, failed: true, notes: ["Timeout"] });
    assert.equal((await db.get(failedRun))!.status, "failed");
    assert.equal(db.rows("creditLedger").reduce((sum, r) => sum + Number(r.amountMicro), 0), -7000000);
  } finally { if (oldPaid === undefined) delete process.env.TREG_PAID_CALLS; else process.env.TREG_PAID_CALLS = oldPaid; }
});
