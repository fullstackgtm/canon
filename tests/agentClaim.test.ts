import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { POST as claimAgent } from "../src/app/api/agents/claim/route.ts";
import { GET as gtmSummary } from "../src/app/api/gtm/summary/route.ts";
import { startConvexStub, type ConvexCall } from "./fixtures/convexStub.ts";

/**
 * The auth.md claim ceremony: a signed-in user binds an anonymous agent
 * registration to their account with the claim_token from registration.
 *
 * The tests below pin BOTH halves of the design:
 * - the ceremony itself (happy path, idempotency, 409 on someone else's
 *   claim, 404 on unknown tokens, 401 unauthenticated);
 * - the SECURITY LINE — claiming is an ownership binding, never an access
 *   upgrade. An agent token is rejected on org-scoped routes before and
 *   after claiming, and the claim route itself refuses agent tokens (only a
 *   user credential can claim).
 */

delete process.env.NEXT_PUBLIC_SITE_URL;

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const CLAIM_TOKEN = `fsgtm_claim_${"cd".repeat(32)}`;
const AGENT_TOKEN = `fsgtm_agent_${"ab".repeat(32)}`;

function claimRequest(body: unknown, token = "eyJhbGciOi.clerk.jwt") {
  return new Request("http://localhost/api/agents/claim", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "x-forwarded-for": "203.0.113.30",
    },
    body: JSON.stringify(body),
  });
}

test("POST /api/agents/claim binds a registration to the signed-in user", async () => {
  const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const claimedAt = Date.now();
  const stub = await startConvexStub(() => ({
    value: {
      name: "eval-bot",
      scopes: ["read:evals"],
      expiresAt,
      claimedAt,
      alreadyClaimed: false,
    },
  }));
  process.env.NEXT_PUBLIC_CONVEX_URL = stub.url;
  try {
    const response = await claimAgent(claimRequest({ claim_token: CLAIM_TOKEN }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.claimed, true);
    assert.equal(body.already_claimed, false);
    assert.equal(body.agent.name, "eval-bot");
    // Scopes come back UNCHANGED — claiming never widens them — and the
    // response says so explicitly.
    assert.deepEqual(body.agent.scopes, ["read:evals"]);
    assert.match(body.note, /cannot access organization data/);
    assert.equal(body.claimed_at, new Date(claimedAt).toISOString());

    // Convex saw a hash of the claim token, never the token itself.
    const call = stub.calls.find((c: ConvexCall) => c.path === "agentAuth:claim");
    assert.ok(call, "claim mutation was called");
    assert.equal(call.args.claimTokenHash, sha256(CLAIM_TOKEN));
    assert.ok(!JSON.stringify(call.args).includes(CLAIM_TOKEN));
  } finally {
    await stub.close();
  }
});

test("re-claiming by the same user is idempotent", async () => {
  const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const stub = await startConvexStub(() => ({
    value: {
      name: "eval-bot",
      scopes: ["read:evals"],
      expiresAt,
      claimedAt: Date.now() - 1000,
      alreadyClaimed: true,
    },
  }));
  process.env.NEXT_PUBLIC_CONVEX_URL = stub.url;
  try {
    const response = await claimAgent(claimRequest({ claim_token: CLAIM_TOKEN }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.claimed, true);
    assert.equal(body.already_claimed, true);
  } finally {
    await stub.close();
  }
});

test("a registration claimed by another user is a 409", async () => {
  const stub = await startConvexStub(() => ({
    errorMessage: "conflict",
    errorData: {
      code: "conflict",
      message: "This agent registration has already been claimed by another user",
    },
  }));
  process.env.NEXT_PUBLIC_CONVEX_URL = stub.url;
  try {
    const response = await claimAgent(claimRequest({ claim_token: CLAIM_TOKEN }));
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.error, "conflict");
    assert.match(body.message, /another user/);
  } finally {
    await stub.close();
  }
});

test("unknown, revoked, or expired claim tokens are a 404", async () => {
  const stub = await startConvexStub(() => ({
    errorMessage: "not found",
    errorData: {
      code: "not_found",
      message: "Unknown, revoked, or expired claim token",
    },
  }));
  process.env.NEXT_PUBLIC_CONVEX_URL = stub.url;
  try {
    const response = await claimAgent(claimRequest({ claim_token: CLAIM_TOKEN }));
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, "not_found");
  } finally {
    await stub.close();
  }
});

test("claiming without a signed-in user is a 401", async () => {
  const stub = await startConvexStub(() => ({
    errorMessage: "not authenticated",
    errorData: {
      code: "not_authenticated",
      message: "Claiming an agent registration requires a signed-in user",
    },
  }));
  process.env.NEXT_PUBLIC_CONVEX_URL = stub.url;
  try {
    const response = await claimAgent(claimRequest({ claim_token: CLAIM_TOKEN }));
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.error, "unauthorized");
    assert.match(body.sign_in, /\/sign-in$/);
  } finally {
    await stub.close();
  }
});

test("a missing claim_token is a teaching 400 without touching Convex", async () => {
  const stub = await startConvexStub(() => ({ value: null }));
  process.env.NEXT_PUBLIC_CONVEX_URL = stub.url;
  try {
    const response = await claimAgent(claimRequest({}));
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error, "invalid_request");
    assert.match(body.message, /claim_token/);
    assert.match(body.message, /api\/agents\/register/);
    assert.equal(stub.calls.length, 0);
  } finally {
    await stub.close();
  }
});

test("agents cannot claim themselves: agent tokens get the teaching 403", async () => {
  // The ceremony's whole point is that a USER authenticates. An agent
  // presenting its own fsgtm_agent_ bearer token is rejected before Convex
  // is ever consulted.
  const stub = await startConvexStub(() => ({ value: null }));
  process.env.NEXT_PUBLIC_CONVEX_URL = stub.url;
  try {
    const response = await claimAgent(
      claimRequest({ claim_token: CLAIM_TOKEN }, AGENT_TOKEN),
    );
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.error, "insufficient_scope");
    assert.equal(stub.calls.length, 0);
  } finally {
    await stub.close();
  }
});

test("SECURITY LINE: a claimed agent token is still 403 on org-scoped routes", async () => {
  // Claiming binds ownership (claimedByUserId/claimedByOrgId/claimedAt) and
  // nothing else: the bearer token itself is unchanged, keeps its fixed
  // read-only scopes, and org data access still requires the human-approved
  // pairing/device flow. Rejection is by construction (token tier), so the
  // SAME token that was just claimed is rejected exactly like an unclaimed
  // one — no Convex lookup, no claim-status carve-out.
  const stub = await startConvexStub(() => ({
    value: {
      name: "eval-bot",
      scopes: ["read:evals"],
      expiresAt: Date.now() + 1000000,
      claimedAt: Date.now(),
      alreadyClaimed: false,
    },
  }));
  process.env.NEXT_PUBLIC_CONVEX_URL = stub.url;
  try {
    // The registration behind AGENT_TOKEN gets claimed by a signed-in user...
    const claimResponse = await claimAgent(
      claimRequest({ claim_token: CLAIM_TOKEN }),
    );
    assert.equal(claimResponse.status, 200);

    // ...and the agent token still cannot touch an org-scoped route.
    const convexCallsBefore = stub.calls.length;
    const orgResponse = await gtmSummary(
      new Request("http://localhost/api/gtm/summary", {
        headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
      }),
    );
    assert.equal(orgResponse.status, 403);
    const body = await orgResponse.json();
    assert.equal(body.error, "insufficient_scope");
    assert.match(body.message, /human-approved pairing/i);
    assert.equal(
      stub.calls.length,
      convexCallsBefore,
      "org routes must reject agent tokens without consulting Convex",
    );
  } finally {
    await stub.close();
  }
});
