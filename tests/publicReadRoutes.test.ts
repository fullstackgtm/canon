import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { GET as getLeaderboard } from "../src/app/api/public/leaderboard/route.ts";
import { startConvexStub, type ConvexCall } from "./fixtures/convexStub.ts";

delete process.env.NEXT_PUBLIC_SITE_URL;

const AGENT_TOKEN = `fsgtm_agent_${"cd".repeat(32)}`;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

let ipCounter = 0;
function get(url: string, token?: string) {
  ipCounter += 1;
  return new Request(url, {
    method: "GET",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "x-forwarded-for": `198.51.100.${ipCounter % 250}`,
    },
  });
}

function validatingStub(scopes: string[] | null) {
  return startConvexStub((call: ConvexCall) => {
    if (call.path === "agentAuth:validate") {
      return {
        value: scopes
          ? { name: "eval-bot", scopes, expiresAt: Date.now() + 1000 }
          : null,
      };
    }
    return { errorMessage: `unexpected call ${call.path}` };
  });
}

test("public reads 401 without a token, teaching how to register", async () => {
  const stub = await validatingStub(null);
  process.env.NEXT_PUBLIC_CONVEX_URL = stub.url;
  try {
    const response = await getLeaderboard(get("http://localhost/api/public/leaderboard"));
    assert.equal(response.status, 401);
    const wwwAuth = response.headers.get("www-authenticate") ?? "";
    assert.match(wwwAuth, /^Bearer /);
    assert.match(wwwAuth, /register_uri="[^"]+\/api\/agents\/register"/);
    assert.match(wwwAuth, /resource_metadata=/);
    const body = await response.json();
    assert.ok(body.register_uri.endsWith("/api/agents/register"));
    assert.match(body.message, /operator_contact/);
    assert.equal(stub.calls.length, 0);
  } finally {
    await stub.close();
  }
});

test("non-agent bearer credentials are not accepted on the public tier", async () => {
  const stub = await validatingStub(["read:evals"]);
  process.env.NEXT_PUBLIC_CONVEX_URL = stub.url;
  try {
    const response = await getLeaderboard(
      get("http://localhost/api/public/leaderboard", "fsgtm_org_broker_token"),
    );
    assert.equal(response.status, 401);
    assert.equal(stub.calls.length, 0);
  } finally {
    await stub.close();
  }
});

test("revoked/expired/unknown agent tokens get 401", async () => {
  const stub = await validatingStub(null);
  process.env.NEXT_PUBLIC_CONVEX_URL = stub.url;
  try {
    const response = await getLeaderboard(
      get("http://localhost/api/public/leaderboard", AGENT_TOKEN),
    );
    assert.equal(response.status, 401);
    assert.match((await response.json()).message, /expired, or revoked/);
    assert.equal(stub.calls[0]?.args.tokenHash, sha256(AGENT_TOKEN));
  } finally {
    await stub.close();
  }
});

test("leaderboard serves the committed CRM-Ops Bench artifact to read:evals", async () => {
  const stub = await validatingStub(["read:evals"]);
  process.env.NEXT_PUBLIC_CONVEX_URL = stub.url;
  try {
    const response = await getLeaderboard(
      get("http://localhost/api/public/leaderboard", AGENT_TOKEN),
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.benchmark, "CRM-Ops Bench");
    assert.match(body.generatedFrom.commit, /^[0-9a-f]{40}$/);
    assert.equal(body.generatedFrom.totalRuns, 1904);
    assert.equal(body.models.length, 10);
    // Spot-check real numbers straight from runs.jsonl (see RESULTS.md).
    const fable = body.models.find(
      (entry: { model: string }) => entry.model === "anthropic/claude-fable-5",
    );
    assert.equal(fable.arms.raw.cup, 95.6);
    assert.equal(fable.arms.raw.violations, 3);
    assert.equal(fable.arms.fullstackgtm.cup, 100);
    assert.equal(fable.arms.fullstackgtm.violations, 0);
    // Opus 4.8 ran no Informed arm — the artifact must not invent one.
    const opus = body.models.find(
      (entry: { model: string }) => entry.model === "anthropic/claude-opus-4-8",
    );
    assert.equal(opus.arms.informed, undefined);
  } finally {
    await stub.close();
  }
});

test("scope checks are default-deny: a token without read:evals cannot read evals", async () => {
  // e.g. a legacy registration minted when read:health still existed
  const stub = await validatingStub(["read:health"]);
  process.env.NEXT_PUBLIC_CONVEX_URL = stub.url;
  try {
    const response = await getLeaderboard(
      get("http://localhost/api/public/leaderboard", AGENT_TOKEN),
    );
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.error, "insufficient_scope");
    assert.match(
      response.headers.get("www-authenticate") ?? "",
      /scope="read:evals"/,
    );
  } finally {
    await stub.close();
  }
});
