import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  buildStartingPlan,
  unknownTeamShape,
  type OnboardingAnswers,
} from "../convex/lib/startingPlan.ts";
import { researchTeamShape } from "../convex/lib/teamShape.ts";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const company = {
  name: "Acme",
  summary: "Scheduling for clinics",
  evidence: [{ url: "https://acme.example/", quote: "Scheduling for clinics" }],
};

test("starting plans keep unknowns, combine archetypes, cap modules and use shipped ids", () => {
  const team = unknownTeamShape();
  team.motion = { value: "self-serve", evidence: company.evidence };
  team.hiring = { value: { sales: 2, cs: 3 }, evidence: company.evidence };
  const fixtures: Array<[OnboardingAnswers, string[], string[]]> = [
    [
      { crm: "none", sellers: "0-2" },
      ["Z0", "G4"],
      ["icps", "work", "customer-success", "sequences", "dialer"],
    ],
    [
      { crm: "hubspot", sellers: "3-10" },
      ["B1", "G4"],
      ["icps", "work", "customer-success", "sequences", "dialer"],
    ],
    [
      { crm: "salesforce", sellers: "11-49" },
      ["S2", "G4"],
      ["icps", "work", "customer-success", "reports", "forecast"],
    ],
    [
      { crm: "salesforce", sellers: "50+" },
      ["S2", "M3", "G4"],
      ["icps", "work", "customer-success", "reports", "forecast"],
    ],
  ];
  for (const [answers, archetypes, slugs] of fixtures) {
    const plan = buildStartingPlan({
      team,
      answers,
      company,
      segmentId: "seg-a",
    });
    assert.deepEqual(plan.archetypes, archetypes);
    assert.deepEqual(
      plan.modules.map((m) => m.id),
      slugs.map((s) => `@canon/${s}`),
    );
    assert.ok(plan.modules.length <= 6);
    assert.equal(plan.tasks.length, 3);
    assert.equal(plan.landing, "/dashboard/accounts?segment=seg-a");
    for (const m of plan.modules) {
      assert.equal(
        JSON.parse(
          readFileSync(
            `modules/examples/${m.id.split("/")[1]}/module.json`,
            "utf8",
          ),
        ).id,
        m.id,
      );
      assert.ok(m.evidence.length > 0);
    }
  }
  const unknown = buildStartingPlan({ company });
  assert.deepEqual(unknown.archetypes, []);
  assert.deepEqual(unknown.questions, ["crm", "sellers"]);
});

test("team signals use public pricing and each ATS API, with quotes; missing stays unknown", async () => {
  for (const [board, api, payload] of [
    [
      "https://boards.greenhouse.io/acme",
      "https://boards-api.greenhouse.io/v1/boards/acme/jobs",
      {
        jobs: [
          { title: "Account Executive" },
          { title: "Customer Success Manager" },
        ],
      },
    ],
    [
      "https://jobs.lever.co/acme",
      "https://api.lever.co/v0/postings/acme?mode=json",
      [{ text: "Account Executive" }, { text: "Customer Success Manager" }],
    ],
    [
      "https://jobs.ashbyhq.com/acme",
      "https://api.ashbyhq.com/posting-api/job-board/acme",
      {
        jobs: [
          { title: "Account Executive" },
          { title: "Customer Success Manager" },
          { title: "Sales Manager", isListed: false },
        ],
      },
    ],
  ] as const) {
    const pages: Record<string, string> = {
      "https://acme.example/": `<script src="https://js.hs-scripts.com/123.js"></script><a href="/pricing">Pricing</a><a href="/careers">Careers</a>`,
      "https://acme.example/pricing": "<p>Free plan</p><p>Book a demo</p>",
      "https://acme.example/careers": `<a href="${board}">Open roles</a>`,
      [api]: JSON.stringify(payload),
    };
    const fetched: string[] = [];
    const team = await researchTeamShape({
      domain: "acme.example",
      homepage: Promise.resolve({
        text: pages["https://acme.example/"],
        finalUrl: "https://acme.example/",
      }),
      fetchPage: async (url) => {
        fetched.push(url);
        return pages[url] ? { text: pages[url], finalUrl: url } : null;
      },
    });
    assert.equal(team.crm.value, "hubspot");
    assert.equal(team.motion.value, "hybrid");
    assert.deepEqual(team.hiring.value, { sales: 1, cs: 1 });
    assert.equal(team.sizeBand.value, null);
    assert.equal(team.hiring.evidence[1].quote, "Account Executive");
    assert.match(team.hiring.evidence[0].quote, /^2 public open job postings/);
    assert.ok(fetched.every((url) => url in pages));
  }
  const unknown = await researchTeamShape({
    domain: "acme.example",
    homepage: Promise.resolve({
      text: "<p>Hello</p>",
      finalUrl: "https://acme.example/",
    }),
    fetchPage: async (url) => ({ text: "<p>Hello</p>", finalUrl: url }),
  });
  assert.deepEqual(unknown, unknownTeamShape());
});

test("session edits survive findings, cached visitors do not inherit answers, and claim applies the plan without confirmation", async () => {
  const user = { _id: "u", orgId: "org" };
  const loaded = loadConvex(["researchSessions.ts", "onboarding.ts"], {
    "moduleDefaults.ts": (r) => ({ ...r, applyStartingPlan: async () => {} }),
    "recipes.ts": (r) => ({ ...r, mayDecide: () => true, requireDecider: async () => user }),
    "lib.ts": (r) => ({
      ...r,
      requireUser: async () => user,
      getCurrentUser: async () => user,
      agentClientOf: async () => null,
    }),
  });
  const fn = loaded["researchSessions.ts"];
  const db = memoryDb({
    organizations: [{ _id: "org", createdAt: Date.now() + 60_000 }],
    researchSessions: [
      {
        _id: "s",
        token: "token",
        domain: "acme.example",
        status: "deriving",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        events: [],
      },
    ],
  });
  const scheduled: unknown[][] = [];
  const ctx = {
    db,
    auth: { getUserIdentity: async () => ({ email: "invited@acme.example", emailVerified: true }) },
    scheduler: {
      runAfter: async (...args: unknown[]) => {
        scheduled.push(args);
      },
    },
  };
  await fn.patchFromPipeline.handler(ctx, { sessionId: "s", event: { kind: "team", text: "No public team signals" } });
  await fn.updateOnboarding.handler(ctx, {
    token: "token",
    summary: "Our edited offer",
    crm: "none",
    sellers: "0-2",
  });
  await fn.patchFromPipeline.handler(ctx, {
    sessionId: "s",
    status: "building_tam",
    icp: { name: "ICP" },
    companyFinding: company,
    event: { kind: "company", text: "Read the website" },
  });
  let session = await fn.get.handler(ctx, { token: "token" });
  assert.equal(session.companySummaryEdit, "Our edited offer");
  assert.deepEqual(Array.from(session.startingPlan.archetypes), ["Z0"]);
  await assert.rejects(fn.claim.handler(ctx, { token: "token" }));
  await fn.patchFromPipeline.handler(ctx, { sessionId: "s", status: "sampling_contacts", tam: [{ domain: "buyer.example", name: "Buyer" }], tamTotal: 1 });
  assert.equal(String(scheduled[0]?.[1]), "internal.recordActions.prepareSession", "prepare the full TAM before ready or claim");
  await fn.patchFromPipeline.handler(ctx, {
    sessionId: "s",
    status: "ready",
    icpSource: "llm",
    segments: [{ id: "seg-a", name: "Clinics", count: 1 }],
    event: { kind: "ready", text: "Ready" },
  });
  await fn.patchFromPipeline.handler(ctx, {
    sessionId: "s",
    status: "deriving",
    event: { kind: "retry", text: "Late write" },
  });
  session = await fn.get.handler(ctx, { token: "token" });
  assert.equal(session.status, "ready");
  assert.deepEqual(
    Array.from(session.events, (e: { kind: string }) => e.kind),
    ["team", "company", "ready"],
  );
  assert.deepEqual(Array.from(session.completedCards), ["team", "offer", "buyers", "market", "plan"]);
  assert.ok(!Object.hasOwn(session, "tam"));
  assert.ok(!Object.hasOwn(session, "preparedAccounts"));
  await fn.recordFeedback.handler(ctx, { token: "token", step: "offer", vote: "down" });
  await fn.recordFeedback.handler(ctx, { token: "token", step: "offer", vote: "up" });
  assert.deepEqual(Array.from((await fn.get.handler(ctx, { token: "token" })).feedback, (entry: { step: string; vote: string }) => [entry.step, entry.vote]), [["offer", "up"]]);
  const cached = await fn.start.handler(ctx, { domain: "acme.example" });
  const copy = await fn.get.handler(ctx, { token: cached.token });
  assert.deepEqual(JSON.parse(JSON.stringify(copy.onboardingAnswers)), {});
  assert.equal(copy.companySummaryEdit, null);
  assert.deepEqual(Array.from(copy.feedback), []);
  assert.equal(copy.planConfirmedAt, null);
  await assert.rejects(fn.claim.handler(ctx, { token: "token" }));
  await db.patch("s", { invitedEmail: "invited@acme.example" });
  const claimed = await fn.claim.handler(ctx, { token: "token" });
  assert.equal(claimed.redirect, "/dashboard/accounts?segment=seg-a");
  assert.deepEqual(
    JSON.parse(JSON.stringify((await db.get("org"))?.startingPlan)),
    JSON.parse(JSON.stringify(session.startingPlan)),
  );
  assert.equal(
    (await fn.claim.handler(ctx, { token: "token" })).alreadyClaimed,
    true,
  );
  assert.equal(scheduled.filter((call) => String(call[1]) === "internal.recordActions.prepareSession").length, 2, "cached research prepares its own import before claim");
  const legacyId = await db.insert("researchSessions", { token: "legacy-running", domain: "acme.example", status: "building_tam", claimedByOrgId: "org", importStatus: "pending", createdAt: Date.now(), updatedAt: Date.now() });
  await fn.patchFromPipeline.handler(ctx, { sessionId: legacyId, status: "ready" });
  await fn.patchFromPipeline.handler(ctx, { sessionId: legacyId, status: "ready" });
  assert.equal(scheduled.filter((call) => String(call[1]) === "internal.recordActions.importSession").length, 2, "an earlier running claim imports once when research becomes ready");
  await db.patch("org", {
    createdAt: 0,
    startingPlan: undefined,
    onboardingCompletedAt: 1,
  });
  const copyRow = db.rows("researchSessions").find((row) => row.token === cached.token)!;
  await db.patch(copyRow._id, { invitedEmail: "invited@acme.example" });
  await fn.claim.handler(ctx, { token: cached.token });
  assert.equal((await db.get("org"))?.startingPlan, undefined);
  await db.patch("org", { startingPlan: session.startingPlan });
  assert.equal(
    (await loaded["onboarding.ts"].getStartingPlan.handler(ctx, {})).tasks
      .length,
    3,
  );
  await loaded["onboarding.ts"].completePlanTask.handler(ctx, {
    stepId: "triage_tam",
  });
  await loaded["onboarding.ts"].completePlanTask.handler(ctx, {
    stepId: "triage_tam",
  });
  assert.equal((await db.query("orgOnboardingSteps").collect()).length, 1);
  await assert.rejects(
    loaded["onboarding.ts"].completePlanTask.handler(ctx, {
      stepId: "not-a-plan-task",
    }),
  );
  await assert.rejects(
    fn.updateOnboarding.handler(ctx, { token: "token", crm: "salesforce" }),
  );
  const expiredId = await db.insert("researchSessions", { token: "expired", domain: "expired.example", status: "ready", createdAt: 0, updatedAt: 0 });
  assert.equal(await fn.get.handler(ctx, { token: "expired" }), null);
  await assert.rejects(fn.recordFeedback.handler(ctx, { token: "expired", step: "offer", vote: "down" }));
  await assert.rejects(fn.claim.handler(ctx, { token: "expired" }));
  await db.patch(expiredId, { claimedByOrgId: "org" });
  assert.equal((await fn.get.handler(ctx, { token: "expired" })).claimed, true);
  await db.patch("s", { claimedByOrgId: "other-org" });
  await assert.rejects(fn.recordFeedback.handler(ctx, { token: "token", step: "offer", vote: "down" }));
  await assert.rejects(fn.start.handler(ctx, { domain: "linear.app", example: true }));
  const real = await db.get("s");
  await db.insert("researchSessions", { ...real, _id: "example", domain: "linear.app", token: "real-example", cachedFromToken: undefined });
  assert.deepEqual(Array.from(await fn.examples.handler(ctx, {}), (entry: { domain: string }) => entry.domain), ["linear.app"]);
  const example = await fn.start.handler(ctx, { domain: "linear.app", example: true });
  const replay = await fn.get.handler(ctx, { token: example.token });
  assert.equal(example.cached, true);
  assert.deepEqual(Array.from(replay.feedback), []);
  assert.equal(replay.companySummaryEdit, null);
  assert.equal(replay.claimed, false);
  assert.equal(replay.events.at(-1).text, "Ready");
  assert.ok(!Object.hasOwn(replay, "contactsSampled"));

});
