import assert from "node:assert/strict";
import test from "node:test";
import { GET, POST } from "../src/app/api/cli/patch-plan/route.ts";

test("CLI plan endpoint requires paired authentication", async () => {
  assert.equal((await GET(new Request("http://localhost/api/cli/patch-plan?externalPlanId=p"))).status, 401);
  assert.equal((await POST(new Request("http://localhost/api/cli/patch-plan", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }))).status, 401);
});

test("CLI plan endpoint rejects oversized, malformed, and unsafe lifecycle payloads before Convex", async () => {
  const headers = { authorization: "Bearer fsgtm_test", "content-type": "application/json" };
  const oversized = await POST(new Request("http://localhost/api/cli/patch-plan", { method: "POST", headers: { ...headers, "content-length": "800000" }, body: "{}" }));
  assert.equal(oversized.status, 413);
  const malformed = await POST(new Request("http://localhost/api/cli/patch-plan", { method: "POST", headers, body: JSON.stringify({ externalPlanId: "p", documentSha256: "bad" }) }));
  assert.equal(malformed.status, 400);
  const lifecycle = await POST(new Request("http://localhost/api/cli/patch-plan", { method: "POST", headers, body: JSON.stringify({ action: "lifecycle", externalPlanId: "p", documentSha256: "a".repeat(64), status: "applied", approvedOperationIds: ["x".repeat(201)] }) }));
  assert.equal(lifecycle.status, 400);
});
