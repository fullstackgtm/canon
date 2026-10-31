import assert from "node:assert/strict";
import test from "node:test";
import { GET, POST } from "../src/app/api/cli/acquisition-checkpoint/route.ts";

test("acquisition checkpoint endpoint requires a paired CLI token", async () => {
  const getResponse = await GET(
    new Request("http://localhost/api/cli/acquisition-checkpoint?key=linkedin%3Alist"),
  );
  assert.equal(getResponse.status, 401);

  const postResponse = await POST(
    new Request("http://localhost/api/cli/acquisition-checkpoint", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "linkedin:list", checkpoint: {} }),
    }),
  );
  assert.equal(postResponse.status, 401);
});

test("acquisition checkpoint endpoint validates bounded keys and checkpoint shapes", async () => {
  const headers = {
    authorization: "Bearer fsgtm_test-paired-token",
    "content-type": "application/json",
  };
  const missingKey = await GET(
    new Request("http://localhost/api/cli/acquisition-checkpoint", { headers }),
  );
  assert.equal(missingKey.status, 400);

  const oversizedCheckpoint = await POST(
    new Request("http://localhost/api/cli/acquisition-checkpoint", {
      method: "POST",
      headers,
      body: JSON.stringify({
        key: "linkedin:list",
        checkpoint: { cursor: "x".repeat(17_000) },
        expectedVersion: 0,
      }),
    }),
  );
  assert.equal(oversizedCheckpoint.status, 400);

  const invalidVersion = await POST(
    new Request("http://localhost/api/cli/acquisition-checkpoint", {
      method: "POST",
      headers,
      body: JSON.stringify({ key: "linkedin:list", checkpoint: {}, expectedVersion: -1 }),
    }),
  );
  assert.equal(invalidVersion.status, 400);
});
