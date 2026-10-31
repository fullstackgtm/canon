import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createClaySearch,
  discoverClayInvestmentProspects,
  normalizeClayPerson,
  runClayPeopleSearchPage,
} from "../engine/src/connectors/clay.ts";
import { builtinAcquirePreset, parseEnrichConfig } from "../engine/src/enrich.ts";
import { clayPeopleFilterRoutes, icpToClayInvestmentCompanyFilters, icpToClayPeopleFilters } from "../engine/src/icp.ts";

const ICP = {
  name: "RevOps",
  firmographics: {
    industries: ["software", "saas"],
    employeeBands: ["51-200", "501-1000"],
    geos: ["us"],
  },
  persona: {
    titleKeywords: ["Revenue Operations", "RevOps"],
    jobLevels: ["vp", "director", "manager"],
  },
};

test("Clay ICP translation uses live-catalog field names and enum spellings", () => {
  assert.deepEqual(icpToClayPeopleFilters(ICP), {
    job_title_keywords: ["Revenue Operations", "RevOps"],
    job_title_seniority_levels_v2: ["vp", "director", "manager"],
    company_sizes: ["51-200", "501-1,000"],
    location_countries_include: ["United States"],
    company_industries_include: ["Software Development"],
  });
});

test("Clay ICP search routes progressively relax provider conjunctions", () => {
  const routes = clayPeopleFilterRoutes(ICP);
  assert.deepEqual(routes.map((route) => route.id), ["exact", "account-first", "persona-first", "title-first", "function-first"]);
  assert.ok("company_industries_include" in routes[0].filters);
  assert.ok(!("job_title_seniority_levels_v2" in routes[1].filters));
  assert.ok(!("company_industries_include" in routes[2].filters));
  assert.deepEqual(Object.keys(routes[3].filters), ["job_title_keywords"]);
  assert.deepEqual(routes[4].filters.job_title_keywords, ["revenue", "operations", "revops"]);
});

test("Clay ICP translation expands regions and omits global as a fake country", () => {
  const northAmerica = icpToClayPeopleFilters({ ...ICP, firmographics: { ...ICP.firmographics, geos: ["north america"] } });
  assert.deepEqual(northAmerica.location_countries_include, ["United States", "Canada"]);
  const global = icpToClayPeopleFilters({ ...ICP, firmographics: { ...ICP.firmographics, geos: ["global"] } });
  assert.ok(!("location_countries_include" in global));
});

test("investment ICP translates into native Clay company filters", () => {
  assert.deepEqual(icpToClayInvestmentCompanyFilters({
    ...ICP, motion: "investment", investment: {
      stages: ["pre-seed", "seed"], fundingAmounts: ["under_1m", "1m_5m"],
      thesisKeywords: ["AI agents", "developer tools"],
    }, firmographics: { ...ICP.firmographics, employeeBands: ["1-10", "11-50"] },
  }), {
    sizes: ["2", "10"], funding_amounts: ["under_1m", "1m_5m"],
    description_keywords: ["AI agents", "developer tools"], industries: ["Software Development"],
  });
});

test("investment discovery searches companies before founders at matched accounts", async () => {
  const creates: Array<Record<string, unknown>> = [];
  let runs = 0;
  const fetchImpl = (async (input, init) => {
    if (String(input).endsWith("/search/filters-mode")) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>; creates.push(body);
      return new Response(JSON.stringify({ search_id: `s${creates.length}` }));
    }
    runs += 1;
    return runs === 1
      ? new Response(JSON.stringify({ data: [{ name: "AgentCo", domain: "agent.co", description: "AI agents", size: "1-10 employees" }], has_more: false }))
      : new Response(JSON.stringify({ data: [{ name: "Ada Founder", latest_experience_title: "Founder", latest_experience_company: "AgentCo", domain: "agent.co" }], has_more: false }));
  }) as typeof fetch;
  const result = await discoverClayInvestmentProspects({ apiKey: "test", companyFilters: { funding_amounts: ["under_1m"] }, titleKeywords: ["Founder"], companyLimit: 10, prospectLimit: 5, fetchImpl });
  assert.equal(result.companiesScanned, 1);
  assert.equal(result.prospects[0].companyDomain, "agent.co");
  assert.deepEqual(creates, [
    { source_type: "companies", filters: { funding_amounts: ["under_1m"] } },
    { source_type: "people", filters: { company_identifier: ["agent.co"], job_title_keywords: ["Founder"] } },
  ]);
});

test("Clay people adapter creates and advances the documented forward-only iterator", async () => {
  const requests: Array<{ url: string; body: unknown; key?: string }> = [];
  const fetchImpl = (async (input, init) => {
    requests.push({
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      key: (init?.headers as Record<string, string> | undefined)?.["clay-api-key"],
    });
    if (String(input).endsWith("/search/filters-mode")) {
      return new Response(JSON.stringify({ search_id: "search_test" }), { status: 200 });
    }
    return new Response(JSON.stringify({
      data: [{
        name: "Ada Lovelace",
        first_name: "Ada",
        last_name: "Lovelace",
        url: "https://www.linkedin.com/in/ada/",
        domain: "https://www.example.com/about",
        latest_experience_title: "VP Revenue Operations",
        latest_experience_company: "Example",
        structured_location: { city: "New York", state: "New York", country: "United States", country_iso: "US" },
      }],
      has_more: false,
    }), { status: 200 });
  }) as typeof fetch;

  const searchId = await createClaySearch({ apiKey: "test", sourceType: "people", filters: { names: ["Ada"] }, fetchImpl });
  const page = await runClayPeopleSearchPage({ apiKey: "test", searchId, limit: 500, fetchImpl });

  assert.equal(searchId, "search_test");
  assert.equal(page.hasMore, false);
  assert.equal(page.prospects[0].linkedin, "https://www.linkedin.com/in/ada");
  assert.equal(page.prospects[0].companyDomain, "example.com");
  assert.equal(page.prospects[0].location?.countryCode, "US");
  assert.deepEqual(requests.map((request) => request.body), [
    { source_type: "people", filters: { names: ["Ada"] } },
    { limit: 100 },
  ]);
  assert.ok(requests.every((request) => request.key === "test"));
});

test("Clay normalization ignores unknown payload fields and keeps no raw record", () => {
  const prospect = normalizeClayPerson({ name: "Grace Hopper", url: "linkedin.com/in/grace", headline: "Computing pioneer",
    job_level: "vp", job_department: "engineering", work_email: "grace@example.com", personal_email: "ignored@example.net", secret_blob: "discard" });
  assert.equal(prospect.fullName, "Grace Hopper");
  assert.equal(prospect.linkedin, "https://linkedin.com/in/grace");
  assert.equal((prospect as unknown as Record<string, unknown>).secret_blob, undefined);
  assert.equal(prospect.headline, "Computing pioneer");
  assert.equal(prospect.jobLevel, "vp");
  assert.equal(prospect.jobDepartment, "engineering");
  assert.equal(prospect.email, "grace@example.com");
});

test("Clay acquire preset is API-backed, LinkedIn-keyed, and incurs no implicit contact spend", () => {
  const preset = builtinAcquirePreset("clay");
  assert.ok(preset);
  const parsed = parseEnrichConfig(JSON.stringify(preset));
  assert.equal(parsed.sources.clay.kind, "api");
  assert.equal(parsed.acquire?.discovery?.clay.provider, "clay");
  assert.equal(parsed.acquire?.discovery?.clay.sourceType, "people");
  assert.equal(parsed.acquire?.create.contact?.matchKey, "linkedin");
  assert.equal(parsed.acquire?.discovery?.clay.contactWaterfall, undefined);
});

test("actual enrich acquire CLI surface drives Clay create -> run and emits an unsaved plan", async () => {
  const { runCli } = await import("../engine/src/cli.ts");
  const home = mkdtempSync(join(tmpdir(), "fsgtm-clay-cli-"));
  const icpPath = join(home, "icp.json");
  writeFileSync(icpPath, JSON.stringify(ICP));
  const previousHome = process.env.FSGTM_HOME;
  const previousKey = process.env.CLAY_API_KEY;
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalError = console.error;
  const requests: string[] = [];
  const logs: string[] = [];
  process.env.FSGTM_HOME = home;
  process.env.CLAY_API_KEY = "test";
  globalThis.fetch = (async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/search/filters-mode")) return new Response(JSON.stringify({ search_id: "search_cli" }), { status: 200 });
    if (url.includes("/search/filters-mode/search_cli/run")) {
      return new Response(JSON.stringify({ data: [{
        name: "Ada Lovelace",
        first_name: "Ada",
        last_name: "Lovelace",
        url: "https://www.linkedin.com/in/ada",
        domain: "example.com",
        latest_experience_title: "VP Revenue Operations",
        latest_experience_company: "Example",
        structured_location: { country: "United States", country_iso: "US" },
      }], has_more: false }), { status: 200 });
    }
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
  console.log = (value?: unknown) => logs.push(String(value ?? ""));
  console.error = () => {};
  try {
    const baseArgs = ["enrich", "acquire", "--source", "clay", "--icp", icpPath, "--demo", "--seed", "7", "--today", "2026-07-11", "--max", "1"];
    await runCli([...baseArgs, "--json"]);
    assert.equal(requests.filter((url) => url.endsWith("/search/filters-mode")).length, 1);
    assert.equal(requests.filter((url) => url.includes("/search/filters-mode/search_cli/run")).length, 1);
    const json = JSON.parse(logs.join("\n"));
    assert.equal(json.plan.operations[0].afterValue.properties.firstname, "Ada");
    assert.deepEqual(json.persistence, {
      runSaved: false,
      planSaved: false,
      planId: null,
      hostedPlanUrl: null,
    });

    logs.length = 0;
    requests.length = 0;
    await runCli(baseArgs);
    const compact = logs.join("\n");
    assert.match(compact, /Lead 1\/1 · \d+% fit/);
    assert.match(compact, /Ada Lovelace/);
    assert.match(compact, /Plan preview/);
    assert.match(compact, /DRY RUN · NOTHING WRITTEN/);
    assert.match(compact, /Details: re-run with --verbose/);
    assert.match(compact, /Apply budget \(not market size\)/);
    assert.match(compact, /Dry runs do not consume this budget/);
    assert.doesNotMatch(compact, /sourceObjectId|"evidence"/);

    logs.length = 0;
    requests.length = 0;
    await runCli([...baseArgs, "--verbose"]);
    const verbose = logs.join("\n");
    assert.match(verbose, /# Acquire leads — clay/);
    assert.match(verbose, /Acquisition/);
    assert.match(verbose, /Ada Lovelace|linkedin\.com\/in\/ada/);

    logs.length = 0;
    requests.length = 0;
    await runCli([...baseArgs, "--save", "--json", "--run-label", "clay-json-save"]);
    const savedJson = JSON.parse(logs.join("\n"));
    assert.equal(savedJson.persistence.runSaved, true);
    assert.equal(savedJson.persistence.planSaved, true);
    assert.equal(savedJson.persistence.planId, savedJson.plan.id);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    globalThis.fetch = originalFetch;
    if (previousHome === undefined) delete process.env.FSGTM_HOME;
    else process.env.FSGTM_HOME = previousHome;
    if (previousKey === undefined) delete process.env.CLAY_API_KEY;
    else process.env.CLAY_API_KEY = previousKey;
    rmSync(home, { recursive: true, force: true });
  }
});

test("Clay acquire retries a relaxed route when the exact ICP returns no people", async () => {
  const { runCli } = await import("../engine/src/cli.ts");
  const home = mkdtempSync(join(tmpdir(), "fsgtm-clay-relax-"));
  const icpPath = join(home, "icp.json");
  writeFileSync(icpPath, JSON.stringify(ICP));
  const previousHome = process.env.FSGTM_HOME;
  const previousKey = process.env.CLAY_API_KEY;
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalError = console.error;
  const createdFilters: Array<Record<string, unknown>> = [];
  const errors: string[] = [];
  process.env.FSGTM_HOME = home;
  process.env.CLAY_API_KEY = "test";
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/search/filters-mode")) {
      const body = JSON.parse(String(init?.body)) as { filters: Record<string, unknown> };
      createdFilters.push(body.filters);
      return new Response(JSON.stringify({ search_id: `search_${createdFilters.length}` }), { status: 200 });
    }
    if (url.includes("search_1/run")) return new Response(JSON.stringify({ data: [], has_more: false }), { status: 200 });
    if (url.includes("search_2/run")) return new Response(JSON.stringify({ data: [{
      name: "Ada Lovelace", first_name: "Ada", last_name: "Lovelace",
      url: "https://www.linkedin.com/in/ada", domain: "example.com",
      latest_experience_title: "VP Revenue Operations", latest_experience_company: "Example",
    }], has_more: false }), { status: 200 });
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
  console.log = () => {};
  console.error = (value?: unknown) => errors.push(String(value ?? ""));
  try {
    await runCli(["enrich", "acquire", "--source", "clay", "--icp", icpPath, "--demo", "--max", "1", "--scan-limit", "10"]);
    assert.equal(createdFilters.length, 2);
    assert.ok("job_title_seniority_levels_v2" in createdFilters[0]);
    assert.ok(!("job_title_seniority_levels_v2" in createdFilters[1]));
    assert.match(errors.join("\n"), /relaxed to account-first/);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    globalThis.fetch = originalFetch;
    if (previousHome === undefined) delete process.env.FSGTM_HOME; else process.env.FSGTM_HOME = previousHome;
    if (previousKey === undefined) delete process.env.CLAY_API_KEY; else process.env.CLAY_API_KEY = previousKey;
    rmSync(home, { recursive: true, force: true });
  }
});
