import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { POST as registerAgent } from "../src/app/api/agents/register/route.ts";
import { startConvexStub, type ConvexCall } from "./fixtures/convexStub.ts";

delete process.env.NEXT_PUBLIC_SITE_URL;

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

function registerRequest(body: unknown, ip: string) {
  return new Request("http://localhost/api/agents/register", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": ip,
    },
    body: JSON.stringify(body),
  });
}

test("POST /api/agents/register mints a scoped fsgtm_agent_ token", async () => {
  const expiresAt = Date.now() + 90 * 24 * 60 * 60 * 1000;
  const stub = await startConvexStub(() => ({
    value: { expiresAt, scopes: ["read:evals"] },
  }));
  process.env.NEXT_PUBLIC_CONVEX_URL = stub.url;
  try {
    const response = await registerAgent(
      registerRequest(
        { name: "eval-bot", operator_contact: "Ops@Example.com", platform: "openai" },
        "203.0.113.7",
      ),
    );
    assert.equal(response.status, 201);
    const body = await response.json();

    assert.match(body.token, /^fsgtm_agent_[0-9a-f]{64}$/);
    assert.equal(body.token_type, "Bearer");
    assert.equal(body.expires_at, new Date(expiresAt).toISOString());
    assert.deepEqual(body.scopes, ["read:evals"]);
    assert.equal(body.revocation.contact, "ryan@fullstackgtm.com");
    assert.match(body.revocation.instructions, /revoke/i);
    assert.match(body.docs_url, /\/auth\.md$/);
    assert.match(body.endpoints.leaderboard, /\/api\/public\/leaderboard$/);

    // auth.md claim ceremony: a one-time claim token plus where to take it —
    // and the security line, stated where agents will read it.
    assert.match(body.claim_token, /^fsgtm_claim_[0-9a-f]{64}$/);
    assert.match(body.claim_endpoint, /\/api\/agents\/claim$/);
    assert.match(body.claim_instructions, /does NOT change the token's scopes/);

    // Convex saw a hash of the token — never the token — and a salted hash
    // of the IP — never the IP. Same idiom for the claim token.
    const call = stub.calls.find((c: ConvexCall) => c.path === "agentAuth:register");
    assert.ok(call, "register mutation was called");
    assert.equal(call.args.tokenHash, sha256(body.token));
    assert.equal(call.args.claimTokenHash, sha256(body.claim_token));
    assert.match(String(call.args.registrationIpHash), /^[0-9a-f]{64}$/);
    assert.notEqual(call.args.registrationIpHash, sha256("203.0.113.7"));
    assert.ok(!JSON.stringify(call.args).includes("203.0.113.7"));
    assert.ok(!JSON.stringify(call.args).includes(body.token));
    assert.ok(!JSON.stringify(call.args).includes(body.claim_token));
  } finally {
    await stub.close();
  }
});

test('registration accepts the auth.md identity type "anonymous" explicitly', async () => {
  const expiresAt = Date.now() + 90 * 24 * 60 * 60 * 1000;
  const stub = await startConvexStub(() => ({
    value: { expiresAt, scopes: ["read:evals"] },
  }));
  process.env.NEXT_PUBLIC_CONVEX_URL = stub.url;
  try {
    const response = await registerAgent(
      registerRequest(
        {
          type: "anonymous",
          name: "eval-bot",
          operator_contact: "ops@example.com",
        },
        "203.0.113.20",
      ),
    );
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.match(body.token, /^fsgtm_agent_[0-9a-f]{64}$/);
    assert.match(body.claim_token, /^fsgtm_claim_[0-9a-f]{64}$/);
  } finally {
    await stub.close();
  }
});

test("unsupported identity types get a teaching 400 without touching Convex", async () => {
  const stub = await startConvexStub(() => ({ value: null }));
  process.env.NEXT_PUBLIC_CONVEX_URL = stub.url;
  try {
    const response = await registerAgent(
      registerRequest(
        {
          type: "identity_assertion",
          name: "eval-bot",
          operator_contact: "ops@example.com",
        },
        "203.0.113.21",
      ),
    );
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error, "invalid_request");
    assert.match(body.message, /identity_assertion/);
    assert.match(body.message, /anonymous/);
    assert.deepEqual(body.identity_types_supported, ["anonymous"]);
    assert.equal(stub.calls.length, 0);
  } finally {
    await stub.close();
  }
});

test("registration validates name and operator_contact before touching Convex", async () => {
  const stub = await startConvexStub(() => ({ value: null }));
  process.env.NEXT_PUBLIC_CONVEX_URL = stub.url;
  try {
    const missingName = await registerAgent(
      registerRequest({ operator_contact: "ops@example.com" }, "203.0.113.8"),
    );
    assert.equal(missingName.status, 400);
    assert.equal((await missingName.json()).error, "invalid_request");

    const missingContact = await registerAgent(
      registerRequest({ name: "eval-bot" }, "203.0.113.9"),
    );
    assert.equal(missingContact.status, 400);
    assert.match((await missingContact.json()).message, /operator_contact/);

    assert.equal(stub.calls.length, 0);
  } finally {
    await stub.close();
  }
});

test("registration maps Convex rate limits to 429 with retry guidance", async () => {
  const stub = await startConvexStub(() => ({
    errorMessage: "rate limited",
    errorData: {
      code: "rate_limited",
      message: "This address has registered 5 agents in the last 24 hours.",
      retryAfterSeconds: 1200,
    },
  }));
  process.env.NEXT_PUBLIC_CONVEX_URL = stub.url;
  try {
    const response = await registerAgent(
      registerRequest(
        { name: "eval-bot", operator_contact: "ops@example.com" },
        "203.0.113.10",
      ),
    );
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "1200");
    const body = await response.json();
    assert.equal(body.error, "rate_limited");
    assert.equal(body.retry_after_seconds, 1200);
    assert.match(body.message, /24 hours/);
  } finally {
    await stub.close();
  }
});

test("registration maps Convex-side validation to 400", async () => {
  const stub = await startConvexStub(() => ({
    errorMessage: "invalid",
    errorData: {
      code: "invalid_request",
      message: "operator_contact must be a reachable email address",
    },
  }));
  process.env.NEXT_PUBLIC_CONVEX_URL = stub.url;
  try {
    const response = await registerAgent(
      registerRequest(
        { name: "eval-bot", operator_contact: "not-an-email" },
        "203.0.113.11",
      ),
    );
    assert.equal(response.status, 400);
    assert.match((await response.json()).message, /email/);
  } finally {
    await stub.close();
  }
});
