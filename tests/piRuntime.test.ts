import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openRuntime, context } from "../services/pi-runtime/src/runtime.ts";

const [major, minor] = process.versions.node.split(".").map(Number);
const nodeSupportsPi = major > 22 || (major === 22 && minor >= 19);

test("Pi runs a fake model for every step, persists its outputs and deduplicates admission on reopen", { skip: !nodeSupportsPi && "Pi Node adapter declares Node >=22.19" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "canon-pi-"));
  try {
    const file = join(directory, "run.sqlite");
    const first = await openRuntime(await openNodeSqliteStorage(file), async () => { throw new Error("Unexpected vendor call"); }, () => {});
    const input = { runId: "pi-probe-unit", mode: "probe" as const, delayMs: 0 };
    const id = await first.start(input);
    const result = await first.wait(id);
    assert.deepEqual(result.state.outcome, { status: "completed", result: 8 });
    const before = await first.snapshot();
    assert.deepEqual(before.progress?.outputs.map((output) => output.split("@")[0]), Array.from({ length: 8 }, (_, i) => `checkpoint-${i}`));
    assert.equal(before.progress?.overheadMs.length, 8);
    await first.harness.close(context);
    const reopened = await openRuntime(await openNodeSqliteStorage(file), async () => { throw new Error("Unexpected vendor call"); }, () => {});
    assert.equal(await reopened.start(input), id);
    assert.deepEqual((await reopened.snapshot()).progress, before.progress);
    assert.deepEqual((await reopened.wait(id)).state.outcome, { status: "completed", result: 8 });
    await reopened.harness.close(context);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Pi owns bounded record tasks, replays a Canon landing and rejects invented evidence", async () => {
  const finishes: Array<{ stepId: string; finding: { status: string }; ms: number }> = [];
  let landed = false;
  const runtime = await openRuntime(new MemoryStorage(), async (operation, data) => {
    if (operation === "next") return { kind: "record", record: { stepId: "s1", spec: { kind: "qa", label: "Product", question: "What does Acme sell?", answerType: "text" }, subject: { name: "Acme", domain: "acme.example" } } };
    if (operation === "status") return landed ? { completed: 1, finished: true } : null;
    if (operation === "effect") {
      if (data.operation === "read") return JSON.stringify({ url: "https://acme.example/", text: "Acme sells a forecasting service for manufacturers.", links: [] });
      if (data.operation === "model") return JSON.stringify({ action: "answer", answer: "Payroll", quote: "Acme sells payroll software.", sourceUrl: "https://acme.example/", confidence: 1 });
      throw new Error("Unexpected search");
    }
    if (operation === "finish") { finishes.push(data as typeof finishes[number]); landed = true; return { completed: 1, finished: true }; }
    throw new Error(`Unexpected callback ${operation}`);
  }, () => {});
  try {
    const id = await runtime.start({ runId: "r1", mode: "research", delayMs: 0 });
    assert.deepEqual((await runtime.wait(id)).state.outcome, { status: "completed", result: 1 });
    assert.equal(finishes.length, 1);
    assert.equal(finishes[0].finding.status, "no_evidence");
    assert.deepEqual(Object.keys(finishes[0]).sort(), ["finding", "ms", "stepId"]);
    assert.equal((await runtime.snapshot()).progress?.completed, 1);
  } finally { await runtime.harness.close(context); }
});

test("a failed Pi task projects failure to Canon rather than leaving its run live", async () => {
  let failures = 0;
  const runtime = await openRuntime(new MemoryStorage(), async (operation) => {
    if (operation === "fail") { failures++; return null; }
    throw new Error("Canon refused this fixture callback");
  }, () => {});
  try {
    const id = await runtime.start({ runId: "failed-fixture", mode: "research", delayMs: 0 });
    assert.notEqual((await runtime.wait(id)).state.outcome.status, "completed");
    assert.equal(failures, 1);
  } finally { await runtime.harness.close(context); }
});
