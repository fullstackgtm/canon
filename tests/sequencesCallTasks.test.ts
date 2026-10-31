import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { calls } from "../modules/examples/sequences/server.ts";
import type { CallContext, ReadDoc } from "../modules/kernel/calls.ts";
import { parseModuleManifest } from "../modules/kernel/manifest.ts";

const at = Date.parse("2026-10-20T17:00:00Z");
const ctx = (args: Record<string, unknown>): CallContext => ({ now: at + 100, caller: { userId: "system", role: "system" }, args });
const doc = (key: string, data: Record<string, unknown>, createdAt = at - 10): ReadDoc => ({ key, data, version: 2, owner: "rep1", parentKey: null, createdAt, updatedAt: createdAt });
const task = doc("seq|con_a|0", { sequence: "seq", contact: "con_a", stepIndex: 0, kind: "call", state: "open", dueDay: "2026-10-20" });
const enrollment = doc("seq|con_a", { sequence: "seq", contact: "con_a", stepIndex: 0, state: "active" });
const args = { keys: ["job"], rep: "rep1", contact: "con_a", activity: "canon_activity", result: `${at}~${at + 1}~no_answer` };

test("call activity creates and outcome edits use Canon identity and call time, never ledger time for matching", async () => {
  const activity = { kind: "call", ownerId: "rep1", personId: "con_a", direction: "outbound", at, outcome: "no_answer" };
  const out = await calls.onCalls(ctx({ changes: [
    { id: "canon_activity", at: at + 1, before: null, after: activity },
    { id: "canon_activity", at: at + 2, before: activity, after: { ...activity, outcome: "connected" } },
    { id: "inbound", at, before: null, after: { ...activity, direction: "inbound" } },
    { id: "not_call", at, before: null, after: { ...activity, kind: "note" } },
    { id: "no_outcome", at, before: null, after: { ...activity, outcome: null } },
    { id: "ambiguous", at, before: null, after: { ...activity, personId: null }, targets: { people: ["con_a", "con_b"] } },
  ] }), {});
  assert.deepEqual(out.intents, [
    { op: "dirty", job: "callLogged", key: `rep1|con_a|canon_activity|${at}~${at + 1}~no_answer` },
    { op: "dirty", job: "callLogged", key: `rep1|con_a|canon_activity|${at}~${at + 2}~connected` },
  ]);
});

test("one logged attempt completes one current call task; old, unrelated and ambiguous tasks stay open", async () => {
  const run = (tasks: ReadDoc[], enrollments = [enrollment]) => calls.completeCall(ctx(args), { tasks, enrollments, logged: [] });
  const intents = (await run([task])).byKey!.job;
  assert.equal(intents.length, 2);
  assert.deepEqual(intents[1], { op: "transition", machine: "task", name: "callLogged", key: task.key });
  for (const candidate of [
    { ...task, createdAt: at + 1 }, { ...task, owner: "rep2" },
    { ...task, data: { ...task.data, contact: "con_b" } },
    { ...task, data: { ...task.data, kind: "task" } },
  ]) assert.deepEqual((await run([candidate])).byKey!.job, []);
  // A schedule-local tomorrow or future snooze affects the queue, not an actual early call on the current task.
  assert.equal((await run([{ ...task, data: { ...task.data, dueDay: "2026-10-21" } }])).byKey!.job.length, 2);
  assert.equal((await run([task], [{ ...enrollment, data: { ...enrollment.data, state: "paused" } }])).byKey!.job.length, 2);
  assert.deepEqual((await run([task, { ...task, key: "ambiguous" }])).byKey!.job, []);
  assert.deepEqual((await run([task], [{ ...enrollment, data: { ...enrollment.data, state: "finished" } }])).byKey!.job, []);
});

test("outcome corrections update the same completed task and cannot consume a later step or regress on stale delivery", async () => {
  const logged = { ...task, data: { ...task.data, state: "done", callActivity: "canon_activity", callObservedAt: at + 1 } };
  const next = { ...task, key: "seq|con_a|1", createdAt: at + 2 };
  const reads = { tasks: [next], logged: [logged], enrollments: [enrollment] };
  const out = await calls.completeCall(ctx({ ...args, result: `${at}~${at + 2}~connected` }), reads);
  assert.deepEqual(out.byKey!.job, [{ op: "patch", collection: "tasks", key: task.key,
    data: { callActivity: "canon_activity", callAt: at, callOutcome: "connected", callObservedAt: at + 2 },
    expect: [{ collection: "tasks", key: task.key, version: 2 }] }]);
  assert.deepEqual((await calls.completeCall(ctx(args), reads)).byKey!.job, []);
  assert.deepEqual((await calls.completeCall(ctx(args), { ...reads, logged: [{ ...logged, owner: "rep2" }] })).byKey!.job, []);
});

test("a call completed while the sequence is paused waits for launch before enrollment progression", async () => {
  const completed = { ...task, data: { ...task.data, state: "done", doneAt: at } };
  const sequence = doc("seq", { status: "paused" });
  const reads = { sequence, steps: [doc("step", { position: 0, kind: "call", delayDays: 0 })], schedule: null,
    enrollments: [enrollment], tasks: [completed] };
  const advanceCtx = ctx({ keys: ["seq|con_a"] });
  assert.deepEqual((await calls.advance(advanceCtx, reads)).byKey!["seq|con_a"], []);
  const active = { ...sequence, data: { ...sequence.data, status: "active" } };
  assert.equal((await calls.launchSequence(ctx({ keys: ["seq"] }), { sequence: active, pending: [], idle: [enrollment] })).byKey!.seq.length, 1);
  const progressed = (await calls.advance(advanceCtx, { ...reads, sequence: active })).byKey!["seq|con_a"];
  assert.ok(progressed.some((i) => i.op === "transition" && i.machine === "enrollment" && i.name === "complete"));
});

test("the published call queue pins the caller and due-day range; call completion is a system transition", () => {
  const parsed = parseModuleManifest(JSON.parse(readFileSync("modules/examples/sequences/module.json", "utf8")));
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.errors.join("\n"));
  const m = parsed.manifest;
  assert.deepEqual(m.provides!["callTasks.v1"], { view: "tasks.callsDue", fields: ["contact", "contactName", "dueDay", "sequence"] });
  const view = m.views["tasks.callsDue"];
  assert.equal(view.kind, "list");
  if (view.kind !== "list") throw new Error("Expected list");
  assert.deepEqual(view.eq, [{ caller: "userId" }, "call", "open"]);
  assert.deepEqual(view.range, { lte: { now: "date" } });
  assert.equal(m.machines!.task.transitions.callLogged.system, true);
});
