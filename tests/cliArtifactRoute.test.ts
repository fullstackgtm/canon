import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "../src/app/api/cli/artifact/route.ts";

test("CLI artifact endpoint requires a human-paired token", async () => {
  const response = await POST(new Request("http://localhost/api/cli/artifact", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "icp", key: "icp:acme.com", label: "Acme", document: {} }),
  }));
  assert.equal(response.status, 401);
});

test("CLI artifact endpoint bounds metadata and documents before Convex", async () => {
  const headers = { authorization: "Bearer fsgtm_test-paired-token", "content-type": "application/json" };
  const invalidKind = await POST(new Request("http://localhost/api/cli/artifact", { method: "POST", headers,
    body: JSON.stringify({ kind: "cache", key: "one", label: "one", document: {} }) }));
  assert.equal(invalidKind.status, 400);
  const oversized = await POST(new Request("http://localhost/api/cli/artifact", { method: "POST", headers,
    body: JSON.stringify({ kind: "signal_run", key: "signals:one", label: "one", document: { content: "x".repeat(500_001) } }) }));
  assert.equal(oversized.status, 400);
});
