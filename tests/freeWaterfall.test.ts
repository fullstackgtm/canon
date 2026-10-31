import assert from "node:assert/strict";
import test from "node:test";
import type { Icp } from "../engine/src/icp.ts";
import { identifyCompanies } from "../convex/lib/crustdata.ts";
import { companyNameFor } from "../convex/lib/companyenrich.ts";
import { cacheAnswer, NAME_MISS_TTL_MS } from "../convex/lib/nameCache.ts";
import { findWorkEmailViaGetleads } from "../convex/lib/emailFinder.ts";
import { FIRST_PAUSE_MS, MAX_PAUSE_MS, nextPause, nextSlot, RATE_LIMIT_PAUSE_MS } from "../convex/lib/pacing.ts";
import { batchKey, peopleToRecords } from "../convex/lib/peopleSources.ts";
import { atLeastVersion, createMemoryRecordStore, FAKE_CONTRACT_VERSION, recordClient } from "../convex/lib/recordClient.ts";
import { CONTRACT_VERSION } from "../services/record-service/src/contract.ts";
import { employeesFrom, icpTitles, icpToQuickEnrich, quickEnrichPage, quickEnrichPeople, splitQuickEnrich } from "../convex/lib/quickenrich.ts";
import { tregCall, TregRefusal } from "../convex/lib/treg.ts";
import { phasesOf } from "../convex/lib/jobPhases.ts";

const icp: Icp = {
  name: "stub",
  firmographics: { industries: ["SaaS", "IT services"], employeeBands: ["51-200", "201-500"], geos: ["us", "uk"] },
  persona: { jobLevels: ["vp", "head"], departments: ["sales", "revenue operations"], titleKeywords: ["CRO"] },
};

test("the ICP becomes a QuickEnrich query with its exact lookup values", () => {
  const q = icpToQuickEnrich(icp);
  assert.deepEqual(q.industry_linkedin?.include, ["Software Development", "IT Services and IT Consulting"]);
  assert.deepEqual(q.number_of_employees?.include, ["20 - 99", "100 - 249", "250 - 499", "500 - 999"], "every range that overlaps 51-500");
  assert.deepEqual(q.country_code?.include, ["US", "GB"]);
  assert.deepEqual(icpTitles(icp), ["CRO", "VP Sales", "VP Revenue", "Vice President Sales", "Vice President Revenue", "Head of Sales", "Head of Revenue"]);
  // A keyword without a level of its own narrows the levels instead of matching every title.
  assert.deepEqual(icpTitles({ ...icp, persona: { jobLevels: ["vp"], titleKeywords: ["Compensation", "VP Finance"] } }), ["VP Finance", "VP Compensation", "Vice President Compensation"]);
  assert.deepEqual(icpTitles({ ...icp, persona: { jobLevels: ["cxo"], titleKeywords: ["CISO", "CHRO", "CLO"] } }), ["CISO", "CHRO", "CLO"]);
});

test("QuickEnrich rows become people; placeholders and rows without a domain are dropped", () => {
  const people = quickEnrichPeople([
    { first_name: "Ada", last_name: "One", title: "VP Sales", employee_linkedin: "http://linkedin.com/in/ada", company_url: "acme.com", company_name: "Acme Inc", industry: "Software Development", employee_count: "100 - 249", country_code: "US" },
    { first_name: "No", last_name: "Domain", company_url: "N/A" },
    { first_name: "Bo", last_name: "Two", company_url: "beta.io", company_name: "N/A", employee_count: ">10000", country_code: "ZZ" },
  ], (iso) => (iso === "US" ? "united states" : undefined));
  assert.deepEqual(people, [
    { fullName: "Ada One", title: "VP Sales", linkedinUrl: "https://linkedin.com/in/ada", company: { domain: "acme.com", name: "Acme Inc", industry: "software development", employees: 100, country: "united states" } },
    { fullName: "Bo Two", company: { domain: "beta.io", employees: 10001 } },
  ]);
  assert.equal(employeesFrom("< 5"), 1);
  assert.deepEqual(["250 - 499", "500 - 999", "1000 - 4999", "5000 - 9999"].map(employeesFrom), [250, 501, 1001, 5001], "each range lands in the ICP band it covers");
  assert.equal(employeesFrom("Not Available".replace(/.*/, "")), undefined);
});

test("QuickEnrich pages by cursor until has_more is false, always at $0", async () => {
  const seen: RequestInit[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    seen.push(init);
    const body = JSON.parse(String(init.body));
    const last = body.cursor === "c2";
    return Response.json(
      { data: [{ first_name: "A", last_name: body.cursor ?? "p1", company_url: "a.com" }], meta: { has_more: !last, next_cursor: last ? null : body.cursor ? "c2" : "c1", total: 3 } },
      { headers: { "X-Treg-Cost-Micro": "0" } },
    );
  }) as unknown as typeof fetch;
  const first = await quickEnrichPage({ token: "t", query: icpToQuickEnrich(icp), meta: { customer: "o" }, countryName: () => undefined, fetchImpl });
  assert.equal(first.next, "c1");
  const last = await quickEnrichPage({ token: "t", query: {}, cursor: "c2", meta: { customer: "o" }, countryName: () => undefined, fetchImpl });
  assert.equal(last.next, null);
  assert.equal((seen[0].headers as Record<string, string>)["X-Treg-Route-Max-Cost"], "0");
  assert.equal(JSON.parse(String(seen[0].body)).per_page, 100);
});

test("people from several sources: one account per domain, a real name beats a guessed one", () => {
  const r = peopleToRecords([
    { fullName: "Ada One", company: { domain: "acme.com" } },
    { fullName: "Bo Two", linkedinUrl: "https://linkedin.com/in/bo", company: { domain: "www.acme.com", name: "Acme Inc" } },
    { fullName: "Cy Three", company: { domain: "beta.io" } },
  ]);
  assert.deepEqual(r.accounts.map((a) => [a.domain, a.name]), [["acme.com", "Acme Inc"], ["beta.io", "Beta"]]);
  assert.deepEqual(r.derivedNames, ["beta.io"], "only names guessed from the domain need a lookup");
  assert.equal(r.contacts.length, 3);
  assert.equal(r.contacts[1].linkedinUrl, "https://linkedin.com/in/bo");
});

test("Crustdata identify keeps confident matches, keyed by normalized domain", async () => {
  const fetchImpl = (async () => Response.json([
    { matched_on: "thetradedesk.com", matches: [{ confidence_score: 1, company_data: { basic_info: { name: "The Trade Desk", professional_network_url: "https://www.linkedin.com/company/the-trade-desk" } } }] },
    { matched_on: "weak.com", matches: [{ confidence_score: 0.3, company_data: { basic_info: { name: "Weak" } } }] },
    { matched_on: "none.com", matches: [] },
  ], { headers: { "X-Treg-Cost-Micro": "0" } })) as unknown as typeof fetch;
  const names = await identifyCompanies({ token: "t", domains: ["thetradedesk.com", "weak.com", "none.com"], meta: { customer: "o" }, fetchImpl });
  assert.deepEqual([...names], [["thetradedesk.com", { name: "The Trade Desk", linkedinUrl: "https://www.linkedin.com/company/the-trade-desk" }]]);
});

test("capacity refusals and rate limits are temporary and say when to retry", async () => {
  const now = Date.now();
  const capacity = (async () => new Response(JSON.stringify({ detail: { error: "provider_capacity", message: "out", resets_at: new Date(now + 3_600_000).toISOString() } }), {
    status: 503, headers: { "X-Treg-Error": "1" },
  })) as unknown as typeof fetch;
  await assert.rejects(tregCall({ token: "t", endpoint: "x.y", meta: { customer: "o" }, free: true, fetchImpl: capacity }), (err: unknown) => {
    assert.ok(err instanceof TregRefusal && err.temporary && err.code === "provider_capacity");
    assert.ok(Math.abs(err.retryAt! - (now + 3_600_000)) < 1000);
    return true;
  });
  const limited = (async () => new Response("slow down", { status: 429, headers: { "Retry-After": "30" } })) as unknown as typeof fetch;
  await assert.rejects(tregCall({ token: "t", endpoint: "x.y", meta: { customer: "o" }, free: true, fetchImpl: limited }), (err: unknown) =>
    err instanceof TregRefusal && err.temporary && err.code === "rate_limited" && err.retryAt! >= now + 29_000);
  const overflow = (async () => new Response(JSON.stringify({ detail: { error: "route_max_cost", message: "would reserve ~$0.005" } }), {
    status: 402, headers: { "X-Treg-Error": "1" },
  })) as unknown as typeof fetch;
  await assert.rejects(tregCall({ token: "t", endpoint: "x.y", meta: { customer: "o" }, free: true, fetchImpl: overflow }), (err: unknown) =>
    err instanceof TregRefusal && err.temporary && err.retryAt === null);
  const blocked = (async () => new Response(JSON.stringify({ detail: { error: "tag_blocked" } }), { status: 403, headers: { "X-Treg-Error": "1" } })) as unknown as typeof fetch;
  await assert.rejects(tregCall({ token: "t", endpoint: "x.y", meta: { customer: "o" }, free: true, fetchImpl: blocked }), (err: unknown) =>
    err instanceof TregRefusal && !err.temporary);
  const budget = (async () => new Response(JSON.stringify({ detail: { error: "tag_budget_unavailable", message: "retry shortly" } }), { status: 429, headers: { "X-Treg-Error": "1" } })) as unknown as typeof fetch;
  await assert.rejects(tregCall({ token: "t", endpoint: "x.y", meta: { customer: "o" }, free: true, fetchImpl: budget }), (err: unknown) =>
    err instanceof TregRefusal && err.temporary && err.brief, "an unchecked budget is a short wait, not an empty allowance");
});

test("pauses: a named reset wins, guesses double per episode, refusals inside a pause share it", () => {
  const now = 1_000_000;
  const first = nextPause(null, now);
  assert.deepEqual(first, { pausedUntil: now + FIRST_PAUSE_MS, strikes: 1, changed: true });
  const same = nextPause(first, now + 1000);
  assert.equal(same.changed, false, "a concurrent refusal joins the running pause");
  assert.equal(same.strikes, 1);
  const extended = nextPause(first, now + 1000, first.pausedUntil + 60_000);
  assert.deepEqual(extended, { pausedUntil: first.pausedUntil + 60_000, strikes: 1, changed: true }, "a later named reset extends the pause for everyone");
  const second = nextPause(first, first.pausedUntil + 1);
  assert.equal(second.pausedUntil - (first.pausedUntil + 1), 2 * FIRST_PAUSE_MS);
  assert.equal(nextPause({ pausedUntil: 0, strikes: 10 }, now).pausedUntil, now + MAX_PAUSE_MS, "never more than 6 h");
  assert.equal(nextPause(null, now, now + 42_000).pausedUntil, now + 42_000, "the provider's own reset");
  assert.equal(nextPause(null, now, now + 10 * MAX_PAUSE_MS).pausedUntil, now + MAX_PAUSE_MS);
  const stale = nextPause({ pausedUntil: now, strikes: 8 }, now + MAX_PAUSE_MS + 1);
  assert.equal(stale.strikes, 1, "strikes from a long-over episode are forgotten");
});

test("a rate limit pauses for its window, not the allowance guess; call slots space calls under the limit", async () => {
  const now = 1_000_000;
  assert.deepEqual(nextPause(null, now, undefined, true), { pausedUntil: now + RATE_LIMIT_PAUSE_MS, strikes: 0, changed: true });
  assert.equal(nextPause({ pausedUntil: 0, strikes: 3 }, now, undefined, true).strikes, 3, "no strike for a rate limit");
  const a = nextSlot(undefined, now, 25);
  const b = nextSlot(a.next, now, 25);
  assert.equal(a.at, now);
  assert.equal(b.at - a.at, 2400, "25 a minute");
  assert.equal(nextSlot(now - 99_999, now, 25).at, now, "an old slot does not schedule into the past");
  const limited = (async () => new Response("{}", { status: 429, headers: { "X-RateLimit-Reset": "43" } })) as unknown as typeof fetch;
  await assert.rejects(tregCall({ token: "t", endpoint: "x.y", meta: { customer: "o" }, free: true, fetchImpl: limited }), (err: unknown) =>
    err instanceof TregRefusal && Math.abs(err.retryAt! - Date.now() - 43_000) < 2_000);
});

test("a big QuickEnrich query splits into disjoint slices: countries, then sizes, then industries; titles never", () => {
  const q = icpToQuickEnrich(icp);
  const byCountry = splitQuickEnrich(q)!;
  assert.deepEqual(byCountry.map((s) => s.country_code?.include), [["US"], ["GB"]]);
  const bySize = splitQuickEnrich(byCountry[0])!;
  assert.equal(bySize.length, 4);
  const byIndustry = splitQuickEnrich(bySize[0])!;
  assert.deepEqual(byIndustry.map((s) => s.industry_linkedin?.include), [["Software Development"], ["IT Services and IT Consulting"]]);
  assert.equal(splitQuickEnrich(byIndustry[0]), null, "titles stay together");
  assert.deepEqual(byIndustry[0].title, q.title);
});

test("CompanyEnrich gives a name only for an exact domain match", async () => {
  const seen: string[] = [];
  const fetchImpl = (async (url: string) => {
    seen.push(url);
    return Response.json([{ domain: "bloomerang.com", name: "Bloomerang" }, { domain: "thetradedesk.com", name: "The Trade Desk" }], { headers: { "X-Treg-Cost-Micro": "0" } });
  }) as unknown as typeof fetch;
  assert.equal(await companyNameFor({ token: "t", domain: "www.TheTradeDesk.com", meta: { customer: "o" }, fetchImpl }), "The Trade Desk");
  assert.match(seen[0], /companyenrich\.companies\.autocomplete\?query=thetradedesk\.com$/);
  assert.equal(await companyNameFor({ token: "t", domain: "bloomerang.co", meta: { customer: "o" }, fetchImpl }), null, "a near miss is not a match");
});

test("getleadsio person lookup: name + domain -> email at $0; a one-word name is not looked up", async () => {
  const seen: RequestInit[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    seen.push(init);
    return Response.json({ ok: true, results: [{ success: true, email: "Alex.Rivera@northstar.example" }] }, { headers: { "X-Treg-Cost-Micro": "0", "X-Treg-Call-Id": "c9" } });
  }) as unknown as typeof fetch;
  const r = await findWorkEmailViaGetleads({ token: "t", fullName: "Alex van Rivera", domain: "northstar.example", meta: { customer: "o" }, fetchImpl });
  assert.deepEqual(r, { email: "alex.rivera@northstar.example", status: "found", provider: "treg:getleadsio", costMicro: 0, callId: "c9" });
  assert.deepEqual(JSON.parse(String(seen[0].body)), { items: [{ first_name: "Alex", last_name: "van Rivera", email_domain: "northstar.example" }] });
  assert.equal((seen[0].headers as Record<string, string>)["X-Treg-Route-Max-Cost"], "0");
  assert.equal((await findWorkEmailViaGetleads({ token: "t", fullName: "Cher", domain: "x.com", meta: { customer: "o" }, fetchImpl })).status, "not_found");
  assert.equal(seen.length, 1);
});

test("reserving several call slots at once spaces them at the provider's rate", () => {
  const r = nextSlot(undefined, 1_000, 100, 4);
  assert.deepEqual(r, { at: 1_000, next: 1_000 + 4 * 600, intervalMs: 600 });
});

test("the name cache uses names, skips recent misses, and retries old ones", () => {
  const now = 10 * NAME_MISS_TTL_MS;
  assert.deepEqual(cacheAnswer({ domain: "a.com", name: "A Inc", updatedAt: 0 }, now), { domain: "a.com", name: "A Inc" }, "names never expire");
  assert.deepEqual(cacheAnswer({ domain: "b.com", updatedAt: now - 1000 }, now), { domain: "b.com", miss: true });
  assert.equal(cacheAnswer({ domain: "c.com", updatedAt: now - NAME_MISS_TTL_MS - 1 }, now), null, "an old miss is looked up again");
  assert.equal(cacheAnswer(null, now), null);
});

test("QuickEnrich reads ICP geographies the way the other TAM paths do: codes, names and regions", () => {
  const q = (geos: string[]) => icpToQuickEnrich({ ...icp, firmographics: { ...icp.firmographics, geos } }).country_code?.include;
  assert.deepEqual(q(["United States"]), ["US"]);
  assert.deepEqual(q(["north america"]), ["US", "CA"]);
  assert.deepEqual(q(["uk", "gb"]), ["GB"]);
  assert.equal(q(["atlantis"]), undefined, "nothing recognised: no country filter rather than a wrong one");
});

test("upsert keys come from content: equal batches share one, different batches never do", () => {
  const a = [{ domain: "a.com", name: "A" }];
  assert.equal(batchKey("job1", "a", a), batchKey("job1", "a", [{ domain: "a.com", name: "A" }]));
  assert.notEqual(batchKey("job1", "a", a), batchKey("job1", "a", [{ domain: "b.com", name: "B" }]));
  assert.notEqual(batchKey("job1", "a", a), batchKey("job1", "c", a), "accounts and contacts never share a key");
});

test("a generic treg 503 is an outage to retry, not a refusal", async () => {
  const outage = (async () => new Response(JSON.stringify({ detail: "upstream unavailable" }), { status: 503, headers: { "X-Treg-Error": "1" } })) as unknown as typeof fetch;
  await assert.rejects(tregCall({ token: "t", endpoint: "x.y", meta: { customer: "o" }, free: true, fetchImpl: outage }), (err: unknown) =>
    err instanceof Error && !(err instanceof TregRefusal));
});

test("population waits for record service 1.5.0: versions compare numerically; unreadable is not ready", async () => {
  assert.equal(atLeastVersion("1.5.0", "1.5.0"), true);
  assert.equal(atLeastVersion("1.10.0", "1.5.0"), true);
  assert.equal(atLeastVersion("1.4.9", "1.5.0"), false);
  assert.equal(atLeastVersion(null, "1.5.0"), false);
  const healthz = (version: string) => (async () => Response.json({ ok: true, version })) as unknown as typeof fetch;
  const client = (v: string) => recordClient({ env: { RECORD_SERVICE_URL: "http://rs", RECORD_SERVICE_TOKEN: "t" }, fetchImpl: healthz(v) });
  assert.equal(await client("1.5.0+abc1234").contractVersion(), "1.5.0");
  assert.equal(await client("dev").contractVersion(), null);
  assert.equal(await recordClient({ env: {} }).contractVersion(), FAKE_CONTRACT_VERSION);
  assert.equal(atLeastVersion(CONTRACT_VERSION, FAKE_CONTRACT_VERSION), true, "the fake cannot advertise an unreleased service contract");
});

test("the fake honors fill-only contact upserts, as the 1.5.0 contract it claims requires", async () => {
  const client = recordClient({ env: {}, store: createMemoryRecordStore() });
  await client.provision("ws");
  await client.upsertAccounts("ws", { records: [{ domain: "acme.com", name: "Acme" }], source: "crm", idempotencyKey: "a" });
  await client.upsertContacts("ws", { records: [{ accountDomain: "acme.com", fullName: "Ada One", title: "Curated" }], source: "crm", idempotencyKey: "c1" });
  await client.upsertContacts("ws", { records: [{ accountDomain: "acme.com", fullName: "Ada One", title: "Scraped", linkedinUrl: "https://linkedin.com/in/ada" }], source: "leadsforge", idempotencyKey: "c2", fill: "missing" });
  const [ada] = (await client.listContacts("ws", {})).rows;
  assert.deepEqual([ada.title, ada.linkedinUrl], ["Curated", "https://linkedin.com/in/ada"], "the curated title stays; the empty LinkedIn field fills");
});

test("a population shows one bar per provider: calls done of known, people, and a provider's wait", () => {
  const now = Date.UTC(2026, 9, 9, 12, 0);
  const c = { done_leadsforge: 1, pending_leadsforge: 2, people_leadsforge: 987, wait_leadsforge: now + 3_600_000, done_quickenrich: 502, pending_quickenrich: 0, people_quickenrich: 49_085, namesQueued: 40, names: 10, namesWorker: 1 };
  const [lf, qe, names] = phasesOf(c, now);
  assert.deepEqual(lf, { key: "leadsforge", label: "Leadsforge people search", status: "pending", done: 1, total: 3, count: 987, note: "Paused by leadsforge until 13:00 UTC" });
  assert.equal(qe.status, "completed");
  assert.equal(phasesOf({ done_quickenrich: 3, pending_quickenrich: 4, expect_quickenrich: 40 }, now)[0].total, 43, "a QuickEnrich search's total counts its pages still to come, not just the next one");
  assert.deepEqual([names.status, names.done, names.total], ["processing", 10, 40]);
  assert.ok(phasesOf(c, now, "completed").every((p) => p.status === "completed"), "a finished job settles every bar");
  assert.deepEqual(phasesOf({ people: 5, tasks: 3, pending: 2 }, now)[0], { key: "find", label: "Find accounts and buyers in your market", status: "processing", count: 5, done: 3, total: 5 }, "a job from before per-provider counters gets one bar for all its calls");
  assert.equal(phasesOf({ done_leadsforge: 2, failed_leadsforge: 2, pending_leadsforge: 0 }, now, "failed")[0].status, "failed", "a provider whose calls all failed doesn't read as done");
  assert.equal(phasesOf({ ...c, "wait_name_lookup": now + 60_000 }, now)[2].status, "pending", "the names bar shows the name worker's wait");
  assert.equal(phasesOf({ done_leadsforge: 3, skipped_leadsforge: 2, pending_leadsforge: 0 }, now)[0].note, "Free allowance used up: 2 skipped", "skipped searches say why");
  assert.equal(phasesOf({ done_leadsforge: 3, pending_leadsforge: 4, stoppedByUser: 1 }, now, "completed")[0].note, "Stopped: 4 not run", "a stopped job says what never ran");
  assert.equal(new TregRefusal(402, "route_max_cost", "would charge", null).noFreeAllowance, true, "a free call that would now charge, with no reset, is not worth waiting for");
  assert.equal(new TregRefusal(402, "route_max_cost", "would charge", null, now + 60_000).noFreeAllowance, false, "a named reset is still waited for");
});

test("a call that could bill is refused before it is sent unless the deployment allows paid calls", async () => {
  let sent = 0;
  const ok = (async () => { sent++; return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
  const call = (extra: object) => tregCall({ token: "t", endpoint: "x.y", meta: { customer: "o" }, fetchImpl: ok, ...extra });
  delete process.env.TREG_PAID_CALLS;
  await assert.rejects(call({ maxCostUsd: 0.25 }), (err: unknown) => err instanceof TregRefusal && err.code === "paid_calls_off");
  await assert.rejects(call({}), (err: unknown) => err instanceof TregRefusal && err.code === "paid_calls_off", "no ceiling means treg's $1 default");
  assert.equal(sent, 0, "nothing reached treg");
  await call({ free: true });
  await call({ maxCostUsd: 0 });
  process.env.TREG_PAID_CALLS = "on";
  await call({ maxCostUsd: 0.25 });
  delete process.env.TREG_PAID_CALLS;
  assert.equal(sent, 3);
});
