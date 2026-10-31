import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { storeCredential } from "../engine/src/credentials.ts";
import {
  readHostedAcquireCheckpoint,
  writeHostedAcquireCheckpoint,
} from "../engine/src/hostedAcquireCheckpoint.ts";

const checkpoint = {
  queryFingerprint: "sha256:list-a-and-icp",
  offset: 200,
  exhausted: false,
};

function isolated(run: (requests: Request[]) => Promise<void>) {
  return async () => {
    const previous = process.env.FSGTM_HOME;
    const home = mkdtempSync(join(tmpdir(), "fsgtm-checkpoint-sync-"));
    process.env.FSGTM_HOME = home;
    const requests: Request[] = [];
    try {
      await run(requests);
    } finally {
      if (previous === undefined) delete process.env.FSGTM_HOME;
      else process.env.FSGTM_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  };
}

test("hosted checkpoint sync is inert when the active profile is unpaired", isolated(async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    throw new Error("must not call");
  };
  assert.deepEqual(await readHostedAcquireCheckpoint("linkedin:list-a", { fetchImpl }), { status: "unpaired" });
  assert.deepEqual(await writeHostedAcquireCheckpoint("linkedin:list-a", checkpoint, null, { fetchImpl }), { status: "unpaired" });
  assert.equal(called, false);
}));

test("paired checkpoint reads authenticate and validate the hosted record", isolated(async (requests) => {
  storeCredential("broker", {
    kind: "broker",
    accessToken: "pair-secret",
    baseUrl: "https://team.example.test/",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push(new Request(input, init));
    return Response.json({ checkpoint, version: 7, updatedAt: 1_752_148_800_000 });
  };
  const result = await readHostedAcquireCheckpoint("linkedin:list-a", { fetchImpl });
  assert.equal(result.status, "found");
  assert.equal(requests[0]?.url, "https://team.example.test/api/cli/acquisition-checkpoint?key=linkedin%3Alist-a");
  assert.equal(requests[0]?.headers.get("authorization"), "Bearer pair-secret");
}));

test("writes use compare-and-swap and surface a stale-writer conflict", isolated(async (requests) => {
  storeCredential("broker", {
    kind: "broker",
    accessToken: "pair-secret",
    baseUrl: "https://team.example.test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const current = {
    checkpoint: { ...checkpoint, offset: 300 },
    version: 8,
    updatedAt: 1_752_148_860_000,
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push(new Request(input, init));
    return Response.json({ current }, { status: 409 });
  };
  const result = await writeHostedAcquireCheckpoint("linkedin:list-a", checkpoint, 7, { fetchImpl });
  assert.deepEqual(result, { status: "conflict", current });
  assert.equal(requests[0]?.method, "POST");
  assert.deepEqual(await requests[0]!.json(), {
    key: "linkedin:list-a",
    checkpoint,
    expectedVersion: 7,
  });
}));

test("creating a hosted checkpoint asserts version zero instead of using an unconditional write", isolated(async (requests) => {
  storeCredential("broker", {
    kind: "broker",
    accessToken: "pair-secret",
    baseUrl: "https://team.example.test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const saved = { checkpoint, version: 1, updatedAt: 1_752_148_800_000 };
  const result = await writeHostedAcquireCheckpoint("linkedin:list-a", checkpoint, null, {
    fetchImpl: async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json(saved);
    },
  });
  assert.deepEqual(result, { status: "saved", record: saved });
  assert.equal((await requests[0]!.json()).expectedVersion, 0);
}));

test("checkpoint transport fails closed on invalid records, keys, and insecure stored broker URLs", isolated(async () => {
  storeCredential("broker", {
    kind: "broker",
    accessToken: "pair-secret",
    baseUrl: "http://hosted.example.test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  assert.deepEqual(await readHostedAcquireCheckpoint("pipe0:query"), { status: "unpaired" });
  await assert.rejects(() => readHostedAcquireCheckpoint("../other-tenant"), /URL-safe/);

  // Local development remains supported, but malformed server data is never
  // accepted as a continuation cursor.
  storeCredential("broker", {
    kind: "broker",
    accessToken: "pair-secret",
    baseUrl: "http://localhost:3000",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const result = await readHostedAcquireCheckpoint("pipe0:query", {
    fetchImpl: async () => Response.json({ checkpoint: { offset: -1 }, version: "x" }),
  });
  assert.deepEqual(result, { status: "unavailable", reason: "hosted checkpoint response was invalid" });
}));
