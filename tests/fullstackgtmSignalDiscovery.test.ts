import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverSignalsWithExa,
  exaQueryForHypothesis,
  parseJobIdentity,
  triggerHypothesesForIcp,
} from "../engine/src/signalDiscovery.ts";
import type { Icp } from "../engine/src/icp.ts";
import { signalsCommand } from "../engine/src/cli/signals.ts";
import { createFileSignalStore } from "../engine/src/signals.ts";

const ICP: Icp = {
  name: "Commission operations",
  firmographics: {},
  persona: { titleKeywords: ["VP Sales", "Revenue Operations"] },
  signals: { triggerHypotheses: [{
    id: "commission-breakage",
    label: "sales compensation operations are becoming difficult to manage",
    positiveEvidence: ["commission disputes", "incentive compensation"],
    activeProjects: ["automate commission calculations"],
    buyerFunctions: ["revenue operations"],
    negativeEvidence: ["insurance commission"],
    preferredSources: ["job"],
  }] },
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("behavioral hypotheses fall back to legacy intent topics", () => {
  const hypotheses = triggerHypothesesForIcp({ ...ICP, signals: { intentTopics: ["territory planning", "quota management"] } });
  assert.equal(hypotheses.length, 1);
  assert.deepEqual(hypotheses[0].positiveEvidence, ["territory planning", "quota management"]);
  assert.match(exaQueryForHypothesis(hypotheses[0]), /territory planning/);
});

test("job identity parser handles canonical ATS result titles", () => {
  assert.deepEqual(parseJobIdentity("Job Application for Senior Sales Compensation Analyst at Acme"), {
    jobTitle: "Senior Sales Compensation Analyst", companyName: "Acme",
  });
  assert.deepEqual(parseJobIdentity("Acme — Director of Revenue Operations | Greenhouse"), {
    companyName: "Acme", jobTitle: "Director of Revenue Operations",
  });
});

test("Exa discovery evidence-gates ATS results, resolves official domains, and emits read-only signals", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchFixture = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    if (body.category === "company") {
      return response({ costDollars: { total: 0.004 }, results: [
        { title: "Acme | Automated payroll", url: "https://www.acme.example/" },
        { title: "Acme jobs", url: "https://boards.greenhouse.io/acme" },
      ] });
    }
    return response({ costDollars: { total: 0.006 }, results: [
      {
        title: "Job Application for Senior Sales Compensation Analyst at Acme",
        url: "https://job-boards.greenhouse.io/acme/jobs/123",
        publishedDate: "2026-07-01T00:00:00.000Z",
        highlights: ["Own incentive compensation operations and automate commission calculations for our global sales team."],
      },
      {
        title: "Job Application for Insurance Agent at OtherCo",
        url: "https://job-boards.greenhouse.io/other/jobs/456",
        highlights: ["Earn insurance commission while helping customers."],
      },
    ] });
  }) as typeof fetch;

  const result = await discoverSignalsWithExa({
    icp: ICP, apiKey: "test-key", since: new Date("2026-06-01T00:00:00.000Z"),
    maxAccounts: 10, maxResults: 20, maxSearches: 3, maxUsd: 0.25,
    now: new Date("2026-07-13T12:00:00.000Z"), fetch: fetchFixture,
  });

  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0].includeDomains, [
    "job-boards.greenhouse.io", "boards.greenhouse.io", "jobs.lever.co",
    "jobs.ashbyhq.com", "jobs.smartrecruiters.com", "apply.workable.com",
  ]);
  assert.equal(bodies[1].category, "company");
  assert.equal(result.summary.readOnly, true);
  assert.equal(result.summary.matchedEvidence, 1);
  assert.equal(result.summary.resolvedAccounts, 1);
  assert.equal(result.summary.costUsd, 0.01);
  assert.equal(result.signals.length, 1);
  assert.equal(result.signals[0].accountDomain, "acme.example");
  assert.equal(result.signals[0].source, "exa");
  assert.equal(result.signals[0].hypothesisId, "commission-breakage");
  assert.match(result.signals[0].quote, /automate commission calculations/);
  assert.equal(result.signals[0].publishedAt, "2026-07-01T00:00:00.000Z");
});

test("Exa discovery returns actionable credential errors without provider bodies", async () => {
  const fetchFixture = (async () => response({ error: "secret echo must not surface" }, 401)) as typeof fetch;
  await assert.rejects(
    discoverSignalsWithExa({ icp: ICP, apiKey: "bad", since: new Date(), maxAccounts: 1, maxResults: 1,
      maxSearches: 1, maxUsd: 0.1, fetch: fetchFixture }),
    /fullstackgtm login exa/,
  );
});

test("signals discover CLI emits structured JSON and --save persists only a signal run", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fsgtm-discover-"));
  const priorCwd = process.cwd();
  const priorHome = process.env.FSGTM_HOME;
  const priorKey = process.env.EXA_API_KEY;
  const priorFetch = globalThis.fetch;
  const priorLog = console.log;
  const priorError = console.error;
  const stdout: string[] = [];
  const stderr: string[] = [];
  try {
    writeFileSync(join(directory, "icp.json"), JSON.stringify(ICP));
    process.chdir(directory);
    process.env.FSGTM_HOME = join(directory, "home");
    process.env.EXA_API_KEY = "test-key";
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return body.category === "company"
        ? response({ costDollars: { total: 0.003 }, results: [{ title: "Acme", url: "https://acme.example" }] })
        : response({ costDollars: { total: 0.005 }, results: [{
          title: "Job Application for Sales Compensation Lead at Acme",
          url: "https://boards.greenhouse.io/acme/jobs/1",
          highlights: ["Automate commission calculations and own incentive compensation with revenue operations."],
        }] });
    }) as typeof fetch;
    console.log = (...args: unknown[]) => stdout.push(args.join(" "));
    console.error = (...args: unknown[]) => stderr.push(args.join(" "));
    await signalsCommand(["discover", "--json", "--save", "--label", "cli-test", "--max-searches", "2"]);
    const output = JSON.parse(stdout.join("\n")) as Record<string, unknown>;
    assert.equal(output.readOnly, true);
    assert.equal(output.freshSignals, 1);
    assert.match(stderr.join("\n"), /NO plan emitted/);
    const run = await createFileSignalStore().getRun("cli-test");
    assert.equal(run?.signals.length, 1);
    assert.deepEqual(run?.buckets, ["job"]);
  } finally {
    process.chdir(priorCwd);
    if (priorHome === undefined) delete process.env.FSGTM_HOME; else process.env.FSGTM_HOME = priorHome;
    if (priorKey === undefined) delete process.env.EXA_API_KEY; else process.env.EXA_API_KEY = priorKey;
    globalThis.fetch = priorFetch;
    console.log = priorLog;
    console.error = priorError;
    rmSync(directory, { recursive: true, force: true });
  }
});
