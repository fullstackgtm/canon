import assert from "node:assert/strict";
import test from "node:test";
import { loadConvex, memoryDb } from "./convexHandlers.ts";
import { buyerTargets, verifyBrief } from "../convex/lib/onboardingBrief.ts";

const sources = [
  {
    url: "https://vendor.example/",
    text: "Scheduling software for distributed software sales teams.",
  },
];
const citations = [{ source: 0, quote: sources[0].text }];
const targets = buyerTargets(
  { name: "Software", persona: { titleKeywords: ["Revenue Operations"] } },
  [{ id: "seg-computer-software-smb", name: "Software · SMB" }],
  [
    {
      name: "Example",
      domain: "example.test",
      industry: "computer software",
      employees: 100,
    },
  ],
);
const response = {
  positioning: [
    { kind: "claim", text: "Scheduling for sales teams", citations },
    {
      kind: "recommendation",
      text: "Lead with distributed team coordination",
      citations,
    },
  ],
  drafts: [
    {
      target: 0,
      pain: "Does coordinating calendars slow your team?",
      subject: "Team scheduling",
      body: "Does coordinating a distributed software sales team's calendars cause friction? Could we compare approaches?",
      positioningIndex: 1,
      citations,
    },
  ],
};
test("brief publication verifies quotes and binds drafts to real persona/account targets without email addresses", () => {
  const brief = verifyBrief(response, sources, targets);
  assert.equal(brief.drafts[0].persona, "Revenue Operations");
  assert.equal(brief.drafts[0].account.domain, "example.test");
  assert.deepEqual(brief.positioning[0].evidence, [
    { url: sources[0].url, quote: sources[0].text },
  ]);
  for (const bad of [
    {
      ...response,
      positioning: [
        {
          ...response.positioning[0],
          citations: [
            {
              source: 0,
              quote: "This was invented and never appeared on the site.",
            },
          ],
        },
        response.positioning[1],
      ],
    },
    { ...response, drafts: [{ ...response.drafts[0], target: 4 }] },
    {
      ...response,
      drafts: [
        {
          ...response.drafts[0],
          body: "Please contact a real person at real@example.test for the scheduling project.",
        },
      ],
    },
    { ...response, drafts: [] },
  ])
    assert.throws(() => verifyBrief(bad, sources, targets));
});

test("waitlist validates, rate limits, retains research privately, and only a verified invited identity can claim", async () => {
  const user = { _id: "u", orgId: "org" };
  let identity: { email: string; emailVerified: boolean } | null = {
    email: "founder@vendor.example",
    emailVerified: true,
  };
  const fn = loadConvex(["researchSessions.ts"], {
    "moduleDefaults.ts": (real) => ({
      ...real,
      applyStartingPlan: async () => {},
    }),
    "lib.ts": (real) => ({
      ...real,
      requireUser: async () => user,
      getCurrentUser: async () => user,
      agentClientOf: async () => null,
    }),
  })["researchSessions.ts"];
  const db = memoryDb({
    organizations: [{ _id: "org", createdAt: 0 }],
    researchSessions: [
      {
        _id: "s",
        token: "t",
        domain: "vendor.example",
        status: "ready",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
  });
  const scheduled: unknown[][] = [];
  const ctx = {
    db,
    auth: { getUserIdentity: async () => identity },
    scheduler: {
      runAfter: async (...args: unknown[]) => {
        scheduled.push(args);
      },
    },
  };
  for (const email of [
    "bad",
    "person@gmail.com",
    "x".repeat(255) + "@vendor.example",
  ])
    await assert.rejects(fn.joinWaitlist.handler(ctx, { token: "t", email }));
  await assert.rejects(
    fn.joinWaitlist.handler(ctx, {
      token: "t",
      email: "founder@vendor.example",
      website: "bot",
    }),
  );
  await assert.rejects(fn.claim.handler(ctx, { token: "t" }));
  assert.equal(await fn.claimAccess.handler(ctx, { token: "t" }), false);
  await fn.joinWaitlist.handler(ctx, {
    token: "t",
    email: "FOUNDER@vendor.example",
    role: "Founder",
    teamSize: "5",
  });
  await fn.joinWaitlist.handler(ctx, {
    token: "t",
    email: "founder@vendor.example",
  });
  assert.equal(db.rows("researchWaitlist").length, 1);
  assert.equal(db.rows("researchWaitlist")[0].email, "founder@vendor.example");
  await db.patch("s", { createdAt: 0 });
  const publicSession = await fn.get.handler(ctx, { token: "t" });
  assert.equal(publicSession.waitlisted, true);
  assert.ok(!JSON.stringify(publicSession).includes("founder@vendor.example"));
  assert.deepEqual(
    scheduled.map((call) => ({ ...(call[2] as object) })),
    [{ email: "founder@vendor.example", domain: "vendor.example", role: "Founder", teamSize: "5" }],
    "waitlisting only posts the new signup to Slack once; no imports or contact lookups",
  );
  await fn.inviteWaitlister.handler(ctx, { sessionId: "s" });
  for (const wrong of [
    null,
    { email: "other@vendor.example", emailVerified: true },
    { email: "founder@vendor.example", emailVerified: false },
  ]) {
    identity = wrong;
    assert.equal(await fn.claimAccess.handler(ctx, { token: "t" }), false);
    await assert.rejects(fn.claim.handler(ctx, { token: "t" }));
  }
  identity = { email: "founder@vendor.example", emailVerified: true };
  assert.equal(await fn.claimAccess.handler(ctx, { token: "t" }), true);
  await fn.joinWaitlist.handler(ctx, {
    token: "t",
    email: "founder@vendor.example",
  });
  await assert.rejects(
    fn.joinWaitlist.handler(ctx, {
      token: "t",
      email: "founder@vendor.example",
    }),
  );
  await fn.claim.handler(ctx, { token: "t" });
  assert.equal((await db.get("s"))?.preparationKey, "s-claim");
  assert.ok(Number((await db.get("s"))?.preparationExpiresAt) > Date.now());
  assert.equal(scheduled.length, 2);
  assert.equal(String(scheduled[1][1]), "internal.recordActions.importSession");
  assert.equal(
    (await fn.claim.handler(ctx, { token: "t" })).alreadyClaimed,
    true,
  );
  user.orgId = "other-org";
  await assert.rejects(fn.claim.handler(ctx, { token: "t" }));
  for (const briefStatus of ["pending", "ready", "unavailable"]) {
    const sourceId = await db.insert("researchSessions", {
      token: `source-${briefStatus}`,
      domain: `${briefStatus}.example`,
      status: "ready",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      briefStatus,
      ...(briefStatus === "ready"
        ? { brief: verifyBrief(response, sources, targets) }
        : {}),
    });
    const scheduledBefore: number = scheduled.length;
    const cached = await fn.start.handler(ctx, {
      domain: `${briefStatus}.example`,
    });
    let copy = await fn.get.handler(ctx, { token: cached.token });
    assert.equal(copy.briefStatus, briefStatus);
    assert.equal(copy.invited, false);
    assert.equal(copy.waitlisted, false);
    assert.equal(
      scheduled.length,
      scheduledBefore + 1,
      "cached briefs never start a duplicate model call",
    );
    if (briefStatus === "pending") {
      await db.patch(sourceId, {
        briefStatus: "ready",
        brief: verifyBrief(response, sources, targets),
      });
      copy = await fn.get.handler(ctx, { token: cached.token });
      assert.equal(copy.briefStatus, "ready");
      assert.equal(copy.brief.drafts[0].persona, "Revenue Operations");
    }
  }
});

test("waitlist Slack text cannot ping the channel", async () => {
  const { waitlistSlackText } = await import("../convex/lib/waitlistSlackText.ts");
  const text = waitlistSlackText({ email: "a@vendor.example", domain: "vendor.example", role: "<!channel>" });
  assert.ok(!text.includes("<!channel>") && text.includes("&lt;!channel&gt;"));
});
