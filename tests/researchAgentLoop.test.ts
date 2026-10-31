import assert from "node:assert/strict";
import test from "node:test";
import {
  agentSlug,
  brandName,
  checkSpec,
  coerceAnswer,
  extractLinks,
  judge,
  locateQuote,
  pageAllowances,
  pageFromHtml,
  researchCompany as loop,
  saveBatches,
  SAVED_PAGE_CHARS,
  stepPrompt,
  stepSchema,
  type AgentSpec,
  type FetchedPage,
  type PageFetcher,
} from "../convex/lib/research/agentLoop.ts";
import { ACCOUNT_MS, RESEARCH_CONCURRENCY, RESEARCH_PAGE, RUN_CAP } from "../convex/lib/research/agentLoop.ts";
import { cadenceMs, estimateRun } from "../convex/lib/research/runPlan.ts";
import { isKnownAttribute } from "../convex/lib/canon/attributes.ts";
import { evidenceText } from "../convex/lib/research/agentLoop.ts";
import { makeWebSearch, serpRows } from "../convex/lib/research/webSearch.ts";

const legacyResearchCompany: typeof loop = (spec, company, deps) => loop(spec, company, { ...deps, legacyFactualLlm: true });

const classify: AgentSpec = {
  label: "Sells to government",
  kind: "classify",
  question: "Who does this company mainly sell to?",
  options: [{ key: "government", label: "Government" }, { key: "commercial", label: "Commercial" }],
};
const qa: AgentSpec = { label: "Insurance carrier", kind: "qa", question: "Which insurance carriers does this clinic accept?", answerType: "text" };

const site: Record<string, string> = {
  "https://clinic.example/": `<html><body><h1>Sunrise Clinic</h1><p>Family care in Austin since 1998, for every age.</p>
    <a href="/insurance">Insurance</a> <a href="https://clinic.example/about#team">About</a>
    <a href="https://other.example/">Partner</a> <a href="/logo.png">logo</a> <a href="mailto:hi@clinic.example">mail</a></body></html>`,
  "https://clinic.example/insurance": `<p>We accept Aetna, Cigna and Blue Cross Blue Shield plans.</p>`,
};
const fetchPage: PageFetcher = async (url) => (site[url] ? pageFromHtml(site[url], url) : null);

test("extractLinks keeps same-site pages only, absolute and without fragments", () => {
  const links = extractLinks(site["https://clinic.example/"], "https://clinic.example/").map((l) => l.href);
  assert.deepEqual(links, ["https://clinic.example/insurance", "https://clinic.example/about"]);
});

test("locateQuote matches word for word, forgiving whitespace, case and typographic quotes", () => {
  const pages: FetchedPage[] = [pageFromHtml("<p>We’re   the leading payroll platform for clinics.</p>", "https://a.example/")];
  assert.ok(locateQuote("we're the leading payroll platform", pages));
  assert.equal(locateQuote("the leading HR platform for clinics", pages), null);
  assert.equal(locateQuote("payroll", pages), null, "too short to prove anything");
});

test("judge refuses an answer whose quote is not in a page read", () => {
  const pages = [pageFromHtml(site["https://clinic.example/insurance"], "https://clinic.example/insurance")];
  const ok = judge(qa, { action: "answer", answer: "Aetna, Cigna, BCBS", quote: "We accept Aetna, Cigna and Blue Cross Blue Shield plans.", sourceUrl: "https://clinic.example/insurance" }, pages);
  assert.equal(ok.status, "answered");
  const made = judge(qa, { action: "answer", answer: "Aetna", quote: "We proudly accept Aetna.", sourceUrl: "https://clinic.example/insurance" }, pages);
  assert.equal(made.status, "no_evidence");
  const none = judge(qa, { action: "answer", answer: "Aetna" }, pages);
  assert.equal(none.status, "no_evidence");
});

test("judge checks classify answers against the options", () => {
  const pages = [pageFromHtml("<p>Trusted by 40 federal agencies and state governments.</p>", "https://g.example/")];
  assert.equal(judge(classify, { answer: "retail", quote: "Trusted by 40 federal agencies" }, pages).status, "unknown");
  assert.equal(judge(classify, { answer: "unknown" }, pages).status, "unknown");
  const f = judge(classify, { answer: "government", quote: "Trusted by 40 federal agencies", confidence: 3 }, pages);
  assert.equal(f.status, "answered");
  assert.equal(f.status === "answered" && f.confidence, 1, "confidence is clamped");
});

test("coerceAnswer turns answers into the field's type", () => {
  assert.equal(coerceAnswer({ ...qa, answerType: "number" }, "$1,200"), 1200);
  assert.equal(coerceAnswer({ ...qa, answerType: "number" }, "lots"), null);
  assert.equal(coerceAnswer({ ...qa, answerType: "boolean" }, "Yes"), true);
  assert.equal(coerceAnswer(qa, null), "unknown");
});

test("researchCompany follows a link the model picks, then answers from it", async () => {
  const prompts: string[] = [];
  const steps = [
    { action: "read", urls: ["https://clinic.example/insurance", "https://evil.example/"] },
    { action: "answer", answer: "Aetna, Cigna, Blue Cross Blue Shield", quote: "We accept Aetna, Cigna and Blue Cross Blue Shield plans.", sourceUrl: "https://clinic.example/insurance", confidence: 0.9 },
  ];
  const out = await legacyResearchCompany(qa, { name: "Sunrise Clinic", domain: "clinic.example" }, {
    fetchPage,
    call: async (prompt) => { prompts.push(prompt); return steps.shift(); },
  });
  assert.equal(out.calls, 2);
  assert.deepEqual(out.pages.map((p) => p.url), ["https://clinic.example/", "https://clinic.example/insurance"], "links not offered are never fetched");
  assert.equal(out.finding.status, "answered");
  assert.equal(out.finding.status === "answered" && out.finding.sourceUrl, "https://clinic.example/insurance");
  assert.match(prompts[0], /https:\/\/clinic\.example\/insurance/);
  assert.match(prompts[1], /We accept Aetna/);
});

test("researchCompany traces each read, failed read and model choice in order", async () => {
  const steps: unknown[] = [];
  const replies = [
    { action: "read", urls: ["https://clinic.example/insurance", "https://clinic.example/about"] },
    { action: "answer", answer: "Aetna", quote: "We accept Aetna, Cigna and Blue Cross Blue Shield plans.", sourceUrl: "https://clinic.example/insurance" },
  ];
  await legacyResearchCompany(qa, { name: "Sunrise Clinic", domain: "clinic.example" }, { fetchPage, call: async () => replies.shift(), onStep: (s) => steps.push(s) });
  assert.deepEqual(steps, [
    { kind: "read", url: "https://clinic.example/", ok: true },
    { kind: "model", action: "read" },
    { kind: "read", url: "https://clinic.example/insurance", ok: true },
    { kind: "read", url: "https://clinic.example/about", ok: false },
    { kind: "model", action: "answer" },
  ]);
});

test("researchCompany stops reading after MAX_READS rounds and must answer", async () => {
  const schemas: object[] = [];
  const out = await legacyResearchCompany(qa, { name: "Sunrise Clinic", domain: "clinic.example" }, {
    fetchPage,
    maxReads: 1,
    call: async (_p, _t, schema) => { schemas.push(schema); return { action: "read", urls: ["https://clinic.example/about"] }; },
  });
  assert.equal(out.calls, 2);
  const last = schemas[1] as { properties: { action: { enum: string[] } } };
  assert.deepEqual(last.properties.action.enum, ["answer"]);
  assert.equal(out.finding.status, "unknown");
});

test("researchCompany reports an unreadable site without calling the model", async () => {
  let calls = 0;
  const out = await legacyResearchCompany(qa, { name: "Gone", domain: "gone.example" }, { fetchPage, call: async () => { calls++; return {}; } });
  assert.equal(calls, 0);
  assert.equal(out.finding.status, "no_evidence");
});

test("stepSchema offers only the options (plus unknown) for classify fields", () => {
  const s = stepSchema(classify, false) as { properties: { answer: { enum: string[] }; urls?: unknown } };
  assert.deepEqual(s.properties.answer.enum, ["government", "commercial", "unknown"]);
  assert.equal(s.properties.urls, undefined);
});

test("checkSpec validates fields and agentSlug yields ledger attributes", () => {
  assert.throws(() => checkSpec({ ...classify, options: [{ key: "a", label: "A" }] }), /2 to 12 options/);
  assert.throws(() => checkSpec({ ...classify, options: [{ key: "Unknown", label: "?" }, { key: "x", label: "X" }] }), /reserved/);
  assert.equal(checkSpec({ ...classify, options: [{ key: "Gov Agencies", label: "Gov" }, { key: "b", label: "B" }] }).options![0].key, "gov-agencies");
  const slug = agentSlug("2024 Insurance carrier(s)!", new Set());
  assert.equal(slug, "f_2024_insurance_carrier_s");
  assert.equal(agentSlug("Insurance", new Set(["insurance"])), "insurance_2");
  assert.ok(isKnownAttribute("account", `custom.${slug}`));
});

test("pageAllowances shares the prompt budget, so long first pages can't crowd out later reads", () => {
  // Three full pages used to take all 24k; the fourth (the one the model asked for) got nothing.
  assert.deepEqual(pageAllowances([8000, 8000, 8000, 5000]), [6333, 6333, 6334, 5000]);
  // Short pages keep their full text and hand the rest to longer ones.
  assert.deepEqual(pageAllowances([500, 20_000, 20_000]), [500, 8000, 8000]);
  assert.ok(pageAllowances(Array(7).fill(9000)).every((n) => n >= 3000));
  assert.ok(pageAllowances(Array(7).fill(9000)).reduce((a, b) => a + b, 0) <= 24_000);
});

test("stepPrompt includes text from a page read after three long ones", () => {
  const long = (u: string): FetchedPage => ({ url: u, text: "x".repeat(9000), links: [] });
  const pages = [long("https://a.example/"), long("https://a.example/1"), long("https://a.example/2"),
    { url: "https://a.example/insurance", text: "We accept Aetna plans.", links: [] }];
  assert.match(stepPrompt(qa, { name: "A", domain: "a.example" }, pages, [], false), /We accept Aetna plans\./);
});

test("saveBatches trims pages to what is kept and bounds each mutation's payload", () => {
  const big = (i: number): FetchedPage => ({ url: `https://a.example/${i}`, text: "y".repeat(3_000_000), links: [] });
  const batches = saveBatches(Array.from({ length: 12 }, (_, i) => big(i)));
  assert.ok(batches.flat().every((p) => p.text.length === SAVED_PAGE_CHARS));
  assert.equal(batches.flat().length, 12);
  assert.ok(batches.every((b) => b.reduce((n, p) => n + p.text.length, 0) <= 1_000_000));
  assert.deepEqual(saveBatches([]), []);
});

test("coerceAnswer never turns a blank number answer into zero", () => {
  const num: AgentSpec = { ...qa, answerType: "number" };
  assert.equal(coerceAnswer(num, ""), "unknown");
  assert.equal(coerceAnswer(num, "  "), "unknown");
  assert.equal(coerceAnswer(num, "$1,200"), 1200);
  assert.equal(coerceAnswer(num, 0), 0);
  assert.equal(coerceAnswer(num, "lots"), null);
});

test("researchCompany stops at the next step once its signal is aborted", async () => {
  const controller = new AbortController();
  let calls = 0;
  const call = async () => { calls++; controller.abort(); return { action: "read", urls: ["https://clinic.example/insurance"] }; };
  await assert.rejects(legacyResearchCompany(qa, { name: "Sunrise", domain: "clinic.example" }, { fetchPage, call, signal: controller.signal }), /deadline/);
  assert.equal(calls, 1);
});

test("run estimate: capped at one run, ceilings from the loop limits, Jev billed only with auto-accept", () => {
  const on = estimateRun({ inScope: 5000, autoAccept: true });
  assert.equal(on.records, RUN_CAP);
  assert.equal(on.modelCallsMax, RUN_CAP * 5, "three rounds plus two web searches per record");
  assert.equal(on.secondsMax, (RUN_CAP / RESEARCH_PAGE) * Math.ceil(RESEARCH_PAGE / RESEARCH_CONCURRENCY) * (ACCOUNT_MS / 1000));
  assert.ok(on.jevUsdMax > 0 && on.jevUsdMax < 0.01);
  const off = estimateRun({ inScope: 3, autoAccept: false });
  assert.deepEqual([off.records, off.jevCallsMax, off.jevUsdMax], [3, 0, 0]);
  assert.equal(cadenceMs("weekly") * 30, cadenceMs("monthly") * 7);
});

test("a contact answer needs a quote that names the person, unless it comes from their own profile page", async () => {
  const persona: AgentSpec = { ...qa, entityType: "contact", label: "Persona", question: "What is this person's role in a purchase?" };
  const profile = pageFromHtml("<p>Runs the billing team and signs off on vendors.</p>", "https://profiles.example/jane");
  const home = pageFromHtml("<p>We accept Aetna. Jane Doe leads the billing team.</p>", "https://clinic.example/");
  const subject = { name: "Sunrise Clinic", domain: "clinic.example", person: { name: "Jane Doe", title: "Billing lead" } };
  const ask = (quote: string, seedPages: FetchedPage[] = []) =>
    legacyResearchCompany(persona, subject, { fetchPage, homepage: home, seedPages, call: async () => ({ action: "answer", answer: "buyer", quote, sourceUrl: "x", confidence: 0.9 }) });

  assert.equal((await ask("We accept Aetna.")).finding.status, "no_evidence", "a line about the company says nothing about the person");
  assert.equal((await ask("Jane Doe leads the billing team.")).finding.status, "answered");
  const short = { ...subject, person: { name: "Amy Li" } };
  const billing = pageFromHtml("<p>Our billing team approves vendors.</p>", "https://clinic.example/");
  const found = await legacyResearchCompany(persona, short, { fetchPage, homepage: billing, call: async () => ({ action: "answer", answer: "buyer", quote: "Our billing team approves vendors.", sourceUrl: "x" }) });
  assert.equal(found.finding.status, "no_evidence", "a short surname is matched as a word, not inside another word");
  const own = await ask("Runs the billing team and signs off on vendors.", [profile]);
  assert.equal(own.finding.status, "answered", "their own profile page is about them");
  assert.deepEqual(own.pages.map((p) => p.url), ["https://clinic.example/", "https://profiles.example/jane"]);
  assert.match(stepPrompt(persona, subject, [home], [], false), /Person: Jane Doe, Billing lead, at Sunrise Clinic/);
});

test("a person is searched for first; a page about them may be quoted without their name, a bare name or a namesake page may not", async () => {
  const persona: AgentSpec = { ...qa, entityType: "contact", label: "Persona", question: "What is this person's role in a purchase?" };
  const subject = { name: "Sunrise Clinic", domain: "clinic.example", person: { name: "Jane Doe" } };
  const leader = pageFromHtml("<h1>Jane A. Doe</h1><p>Chief Financial Officer. She approves every vendor contract.</p>", "https://clinic.example/leader/jane-doe/");
  const snippet: FetchedPage = { url: "https://www.linkedin.com/in/janedoe", text: "Jane Doe - CFO - Sunrise Clinic | LinkedIn Signs off on all purchasing.", links: [], snippet: true };
  const queries: string[] = [];
  const search = async (q: string) => { queries.push(q); return { pages: [leader, snippet], links: [], calls: 1 }; };
  const ask = (quote: string) => legacyResearchCompany(persona, subject, { fetchPage, search, homepage: null, call: async () => ({ action: "answer", answer: "buyer", quote, sourceUrl: "x" }) });

  const r = await ask("She approves every vendor contract.");
  assert.equal(r.finding.status, "answered", "the page's URL carries her name, so it is about her");
  assert.deepEqual(queries, ['"Jane Doe" clinic.example']);
  assert.equal(r.calls, 2, "the search's model call counts");
  assert.equal((await ask("Jane A. Doe")).finding.status, "no_evidence", "naming her proves nothing");
  const title: FetchedPage = { url: "https://www.linkedin.com/in/jd", text: "Jane Doe - CFO | LinkedIn", links: [], snippet: true };
  const short = await legacyResearchCompany(persona, subject, { fetchPage, search: async () => ({ pages: [title], links: [], calls: 1 }), homepage: null, call: async () => ({ action: "answer", answer: "buyer", quote: "Jane Doe - CFO" }) });
  assert.equal(short.finding.status, "answered", "a short title beside the name is evidence");
  const fromSnippet = await ask("Signs off on all purchasing.");
  assert.equal(fromSnippet.finding.status, "answered", "a search snippet counts like a page");
  assert.match(evidenceText(fromSnippet.finding as { quote: string; sourceUrl: string; snippet?: boolean }), /linkedin\.com\/in\/janedoe \(search result\)$/);
});

test("an account whose site can't be read is searched for instead of given up on", async () => {
  const queries: string[] = [];
  const press = pageFromHtml("<p>Sunrise Clinic accepts Aetna and Cigna.</p>", "https://news.example/sunrise");
  const r = await legacyResearchCompany(qa, { name: "Sunrise Clinic", domain: "clinic.example" }, {
    fetchPage: async () => null, homepage: null,
    search: async (q) => { queries.push(q); return { pages: [press], links: [], calls: 1 }; },
    call: async () => ({ action: "answer", answer: "Aetna, Cigna", quote: "accepts Aetna and Cigna", sourceUrl: press.url }),
  });
  assert.deepEqual([r.finding.status, queries], ["answered", ['"Sunrise Clinic" clinic.example']]);
});

test("web search: ChatGPT's readable results are read and Google is not called; with none readable, Google's snippets are", async () => {
  let google = 0;
  const pages: Record<string, string> = { "https://news.example/a": "<p>Jane Doe joins as CFO.</p>" };
  const fetchPage: PageFetcher = async (u) => (pages[u] ? pageFromHtml(pages[u], u) : null);
  // treg's own envelope, as it answers.
  const googleRows = async () => { google++; return serpRows({ output: { results: [{ title: "Jane Doe - CFO", link: "https://www.linkedin.com/in/jane", snippet: "CFO at Sunrise." }, { url: "https://x.example/", description: "" }] } }); };
  const read = await makeWebSearch({ fetchPage, google: googleRows, chatgpt: async () => [{ url: "https://www.linkedin.com/in/jane", title: "" }, { url: "https://news.example/a", title: "News" }] })("q");
  assert.deepEqual([read.pages.map((p) => p.url), google, read.calls], [["https://news.example/a"], 0, 1], "LinkedIn is never fetched");
  const fallback = await makeWebSearch({ fetchPage, google: googleRows, chatgpt: async () => [{ url: "https://www.linkedin.com/in/jane", title: "" }] })("q");
  assert.deepEqual(fallback.pages, [{ url: "https://www.linkedin.com/in/jane", text: "Jane Doe - CFO CFO at Sunrise.", links: [], snippet: true }]);
  assert.deepEqual(fallback.links.map((l) => l.href), ["https://x.example/"]);
  // A readable Google result is read in full rather than kept as its snippet.
  const fullRead = await makeWebSearch({ fetchPage, google: async () => serpRows({ output: { results: [{ title: "News", link: "https://news.example/a", snippet: "Jane Doe joins" }] } }) })("q");
  assert.deepEqual(fullRead.pages.map((p) => [p.url, p.text, !!p.snippet]), [["https://news.example/a", "Jane Doe joins as CFO.", false]]);
});

test("brandName drops legal suffixes, as searches should name a company", () => {
  assert.deepEqual(["Example Buyer Software, LLC", "Acme Inc.", "Globex Corporation", "Initech"].map(brandName), ["Example Buyer Software", "Acme", "Globex", "Initech"]);
});

test("judge accepts a judgment only from verbatim quotes, one placing the person at this company", () => {
  const goal: AgentSpec = { entityType: "contact", label: "Goal", kind: "qa", question: "What is this person trying to achieve?", answerType: "text", judgment: true };
  const pages = [
    pageFromHtml("<p>Sam Mercer - VP, Revenue Operations at Example Buyer Software, LLC</p>", "https://neuron.example/eric"),
    pageFromHtml("<p>This role owns the systems, processes, and analytics that connect Sales and Finance.</p>", "https://jobs.example/vp-revops"),
    pageFromHtml("<p>Sam Mercer is a photographer in Dublin.</p>", "https://social.example/eric"),
  ];
  const person = { name: "Sam Mercer", ownPages: [] };
  const company = { name: "Example Buyer Software, LLC", domain: "caisoft.com" };
  const posting = { quote: "This role owns the systems, processes, and analytics", sourceUrl: "https://jobs.example/vp-revops" };
  const ok = judge(goal, { answer: "Likely to unify revenue systems.", evidence: [{ quote: "Sam Mercer - VP, Revenue Operations at Example Buyer Software", sourceUrl: "https://neuron.example/eric" }, posting] }, pages, person, company);
  assert.deepEqual([ok.status, ok.status === "answered" && ok.inferred, ok.status === "answered" && ok.sourceUrl], ["answered", true, "https://jobs.example/vp-revops"]);
  assert.match(ok.status === "answered" ? evidenceText(ok) : "", /\(https:\/\/neuron\.example\/eric\)\n"This role owns/, "each quote keeps its own page");
  const namesake = judge(goal, { answer: "Likely to unify revenue systems.", evidence: [{ quote: "Sam Mercer is a photographer in Dublin.", sourceUrl: "https://social.example/eric" }, posting] }, pages, person, company);
  assert.equal(namesake.status, "no_evidence");
});

test("a judgment quote with a slipped word is stored as the page's own passage", () => {
  const goal: AgentSpec = { entityType: "contact", label: "Systems", kind: "qa", question: "Which systems?", answerType: "text", judgment: true };
  const pages = [
    pageFromHtml("<p>Sam Mercer - VP, Revenue Operations at Example Buyer Software</p>", "https://neuron.example/eric"),
    pageFromHtml("<p>Proficiency in Salesforce, Gong, and NetSuite, along with a proven track record of deploying AI tools, is required.</p>", "https://jobs.example/vp"),
  ];
  const f = judge(goal, { answer: "Likely Salesforce, Gong and NetSuite.", evidence: [
    { quote: "Sam Mercer - VP, Revenue Operations at Example Buyer Software", sourceUrl: "https://neuron.example/eric" },
    { quote: "Proficiency in Salesforce, Gong, and NetSuite, with a proven track record of deploying AI tools, is required.", sourceUrl: "https://jobs.example/vp" },
  ] }, pages, { name: "Sam Mercer", ownPages: [] }, { name: "Example Buyer Software, LLC", domain: "caisoft.com" });
  assert.equal(f.status === "answered" && f.quote.endsWith("Proficiency in Salesforce, Gong, and NetSuite, along with a proven track record of deploying AI tools, is required."), true);
});
