/**
 * CP17 automation rules, through the Convex functions: the ledger drives runs
 * (convex/automations.ts fanout), each action commits with its step, and a
 * rule acts as its creator. One test per invariant and per action family, on
 * leads: Riley is the admin who builds rules; Avery and Morgan are reps.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const ORG = "organizations:org";
const RILEY = "users:riley";
const AVERY = "users:avery";
const MORGAN = "users:morgan";

let signedIn: Record<string, unknown> | null = null;
/** The OAuth client of an agent calling with the signed-in member's token (/mcp, the canon CLI), or null for the member in person. */
let agentClient: string | null = null;
const M = loadConvex(["automations.ts", "objects.ts"], {
  "lib.ts": (real) => ({
    ...real, getCurrentUser: async () => signedIn, requireUser: async () => { if (!signedIn) throw new Error("Not authenticated"); return signedIn; }, agentClientOf: async () => agentClient,
  }),
});
const automations = M["automations.ts"]!;
const objects = M["objects.ts"]!;

function workspace(riley: Record<string, unknown> = {}) {
  const user = (id: string, name: string, role: string) => ({ _id: id, orgId: ORG, role, isActive: true, name, email: `${name}@acme.test` });
  const db = memoryDb({ users: [{ ...user(RILEY, "Riley", "admin"), ...riley }, user(AVERY, "Avery", "rep"), user(MORGAN, "Morgan", "rep")] });
  const scheduled: Array<{ ref: string; args: Record<string, unknown> }> = [];
  const ctx = { db, scheduler: { runAfter: async (_ms: number, ref: unknown, args: Record<string, unknown>) => void scheduled.push({ ref: String(ref), args }) } };
  return { db, ctx, scheduled };
}

type W = ReturnType<typeof workspace>;
const as = async (w: W, id: string) => (signedIn = await w.db.get(id));
const rule = (w: W, args: Record<string, unknown>) => as(w, RILEY).then(() => automations.propose.handler(w.ctx, { conditions: [], ...args }));
const write = (w: W, values: Record<string, unknown>, streamId?: string) => objects.write.handler(w.ctx, { object: "lead", values, ...(streamId ? { streamId } : {}) });
const fanout = (w: W) => automations.fanout.handler(w.ctx, { orgId: ORG });
const runs = (w: W) => w.db.rows("automationRuns") as Array<Record<string, any>>;
/** Every run still pending, stepped to the end, as the executor does. */
async function drain(w: W) {
  for (const run of runs(w).filter((r) => r.status === "pending" || r.status === "running")) {
    for (let i = 0; i < 5; i++) if ((await automations.step.handler(w.ctx, { runId: run._id })).done) break;
  }
}
const lead = async (w: W, streamId: string) => {
  const row = (w.db.rows("recordRows") as Array<Record<string, any>>).find((r) => r.streamId === streamId)!;
  return row.values as Record<string, unknown>;
};
/** Values from the modules' own realm, as plain data this realm compares. */
const plain = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const entries = (w: W, streamId: string) => (w.db.rows("ledgerEntries") as Array<Record<string, any>>).filter((e) => e.streamId === streamId);

test("round robin: one run per entry however often the fan-out and the steps replay, owners alternate", async () => {
  const w = workspace();
  await rule(w, { name: "New lead round robin", object: "lead", trigger: { kind: "created" }, actions: [{ kind: "assign_owner", owner: { kind: "round_robin", userIds: [AVERY, MORGAN] } }] });
  await as(w, RILEY);
  const a = await write(w, { lastName: "Okafor", company: "Orbit Labs" });
  const b = await write(w, { lastName: "Lindqvist", company: "Fjord AI" });
  await fanout(w);
  await fanout(w);
  assert.equal(runs(w).length, 2);
  await drain(w);
  // A replayed step (the sweep re-sending a run) finds nothing pending and writes nothing.
  for (const run of runs(w)) assert.deepEqual(plain(await automations.step.handler(w.ctx, { runId: run._id })), { done: true });
  await fanout(w);
  assert.equal(runs(w).length, 2);
  // Each in turn, in the order the runs ran (the shards decide which lead went first).
  assert.deepEqual([(await lead(w, a.streamId)).ownerId, (await lead(w, b.streamId)).ownerId].sort(), [AVERY, MORGAN]);
  assert.equal(entries(w, a.streamId).length, 2);
  assert.match(entries(w, a.streamId)[1].source.ref, /^automation:automationRules:\d+:1:user:users:riley$/);
});

test("a rule's own write never starts it again: setting its trigger field runs once", async () => {
  const w = workspace();
  await as(w, RILEY);
  const a = await write(w, { lastName: "Okafor", status: "new" });
  await rule(w, { name: "Status touch", object: "lead", trigger: { kind: "updated", field: "status" }, actions: [{ kind: "set_field", field: "status", value: "working" }] });
  await write(w, { status: "nurturing" }, a.streamId);
  for (let i = 0; i < 3; i++) {
    await fanout(w);
    await drain(w);
  }
  assert.equal(runs(w).length, 1);
  assert.deepEqual(plain(runs(w)[0].change), { field: "status", from: "new", to: "nurturing" });
  assert.equal((await lead(w, a.streamId)).status, "working");
});

test("imports never start a rule, nor CRM history, nor what changed before the rule existed", async () => {
  const w = workspace();
  await as(w, RILEY);
  const before = await write(w, { lastName: "Before" });
  await rule(w, { name: "Any lead change", object: "lead", trigger: { kind: "updated" }, actions: [{ kind: "set_field", field: "leadSource", value: "rule" }] });
  await objects.importBatch.handler(w.ctx, { orgId: ORG, object: "lead", sourceRef: "csv:imp1", actorId: RILEY, records: [{ externalId: "1", values: { lastName: "Imported" } }] });
  await objects.importBatch.handler(w.ctx, { orgId: ORG, object: "lead", sourceRef: "csv:imp1", actorId: RILEY, records: [{ externalId: "1", values: { company: "Later" }, validFrom: 5 }] });
  await fanout(w);
  assert.equal(runs(w).length, 0);
  // The same rule on a person's edit does run, so it is the source that kept it quiet.
  await write(w, { company: "Edited" }, before.streamId);
  await fanout(w);
  assert.equal(runs(w).length, 1);
});

test("a rule acts within its creator's access: a record they cannot see is skipped; a creator who left pauses it", async () => {
  const w = workspace();
  await rule(w, { name: "Tag", object: "lead", trigger: { kind: "created" }, actions: [{ kind: "set_field", field: "leadSource", value: "rule" }] });
  // Riley becomes a rep who sees only their own leads; Avery's lead is outside that.
  await w.db.patch(RILEY, { role: "rep" });
  await w.db.insert("rolePermissions", { orgId: ORG, role: "rep", rules: [{ object: "lead", visibility: "own", unowned: false }] });
  await as(w, AVERY);
  const hidden = await write(w, { lastName: "Hidden", ownerId: AVERY });
  await fanout(w);
  assert.deepEqual(plain(runs(w).map((r) => [r.status, r.reason, r.title])), [["skipped", "Outside the creator's access", ""]]);
  assert.equal((await lead(w, hidden.streamId)).leadSource ?? null, null);
  await w.db.patch(RILEY, { isActive: false });
  await write(w, { lastName: "Later", ownerId: AVERY });
  await fanout(w);
  const saved = (w.db.rows("automationRules") as Array<Record<string, any>>)[0];
  assert.equal(saved.status, "paused");
  assert.equal(runs(w).length, 1);
});

test("access is checked again when an action runs, and rules never set the fields a conversion owns", async () => {
  const w = workspace();
  await assert.rejects(rule(w, { name: "Fake convert", object: "lead", trigger: { kind: "created" }, actions: [{ kind: "set_field", field: "convertedAt", value: 1 }] }));
  await rule(w, { name: "Call", object: "lead", trigger: { kind: "created" }, actions: [{ kind: "create_task", subject: "Call {record}", dueInDays: 1, owner: { kind: "member", userId: MORGAN } }] });
  await as(w, AVERY);
  await write(w, { lastName: "Secret", ownerId: AVERY });
  await fanout(w);
  // After the trigger, Riley becomes a rep who sees only their own leads: the task is never made.
  await w.db.patch(RILEY, { role: "rep" });
  await w.db.insert("rolePermissions", { orgId: ORG, role: "rep", rules: [{ object: "lead", visibility: "own", unowned: false }] });
  await assert.rejects(automations.step.handler(w.ctx, { runId: runs(w)[0]._id }));
  assert.equal((w.db.rows("recordRows") as Array<Record<string, any>>).filter((r) => r.object === "task").length, 0);
});

test("create a task: due in N days for the record's owner, about the record; a failed step stops and Retry resumes it", async () => {
  const w = workspace();
  await rule(w, {
    name: "Follow up", object: "lead", trigger: { kind: "updated", field: "status", to: ["qualified"] },
    actions: [{ kind: "create_task", subject: "Call {record}", dueInDays: 2, owner: { kind: "record_owner" } }],
  });
  await as(w, RILEY);
  const a = await write(w, { lastName: "Okafor", status: "new" });
  await write(w, { status: "qualified" }, a.streamId);
  await fanout(w);
  const [run] = runs(w);
  // No owner yet: the step fails, is recorded, and nothing was written.
  await assert.rejects(automations.step.handler(w.ctx, { runId: run._id }));
  await automations.failStep.handler(w.ctx, { runId: run._id, error: "The record has no owner who is a member" });
  assert.equal(runs(w)[0].status, "failed");
  await write(w, { ownerId: MORGAN }, a.streamId);
  await automations.retryRun.handler(w.ctx, { runId: run._id });
  await drain(w);
  const task = (w.db.rows("recordRows") as Array<Record<string, any>>).find((r) => r.object === "task")!;
  assert.equal(task.values.subject, "Call Okafor");
  assert.equal(task.values.ownerId, MORGAN);
  assert.equal(task.values.dueDate, new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10));
  assert.ok((w.db.rows("associations") as Array<Record<string, any>>).some((e) => e.fromId === task.streamId && e.toId === a.streamId));
  assert.equal(runs(w)[0].status, "done");
});

test("a schedule's next slot is its wall time in the workspace's zone, across DST", () => {
  const { nextSlot } = loadConvex(["lib/automations.ts"])["lib/automations.ts"] as unknown as { nextSlot: (t: unknown, after: number, tz: string) => number };
  const at = (t: unknown, after: string, tz: string) => new Date(nextSlot(t, Date.parse(after), tz)).toISOString();
  const nine = { kind: "schedule", cadence: "daily", minute: 540 };
  assert.equal(at(nine, "2026-10-11T15:00:00Z", "America/Los_Angeles"), "2026-10-11T16:00:00.000Z");
  assert.equal(at(nine, "2026-10-11T16:00:00Z", "America/Los_Angeles"), "2026-10-12T16:00:00.000Z");
  assert.equal(at(nine, "2026-11-01T06:00:00Z", "America/Los_Angeles"), "2026-11-01T17:00:00.000Z");
  assert.equal(at({ kind: "schedule", cadence: "weekly", weekday: 1, minute: 480 }, "2026-10-11T15:00:00Z", "Europe/Berlin"), "2026-10-12T06:00:00.000Z");
});

test("a slot makes one run per (rule, slot, record) however often a page lands, continues page by page, and stops at its cap", async () => {
  const w = workspace();
  await rule(w, { name: "Daily call", object: "lead", trigger: { kind: "schedule", cadence: "daily", minute: 540 }, actions: [{ kind: "create_task", subject: "Call {record}", dueInDays: 0, owner: { kind: "member", userId: MORGAN } }] });
  const saved = () => (w.db.rows("automationRules") as Array<Record<string, any>>)[0];
  assert.ok(saved().nextSlotAt > Date.now());
  await as(w, RILEY);
  const [a, b, c] = [await write(w, { lastName: "A" }), await write(w, { lastName: "B" }), await write(w, { lastName: "C" })];
  // Not due: the sweep starts nothing. Due: it starts the slot once and moves the next one on.
  await automations.sweep.handler(w.ctx, {});
  assert.equal(saved().slotRun, undefined);
  const slot = Date.now() - 1000;
  await w.db.patch(saved()._id, { nextSlotAt: slot });
  await automations.sweep.handler(w.ctx, {});
  await automations.sweep.handler(w.ctx, {});
  assert.equal(saved().slotRun.slot, slot);
  assert.ok(saved().nextSlotAt > Date.now());
  const slotRuns = () => w.scheduled.filter((s) => s.ref === "internal.automations.runSlot").length;
  assert.equal(slotRuns(), 1);
  const page = (from: string | null, ids: string[], next: string | null, at = slot) =>
    automations.slotPage.handler(w.ctx, { ruleId: saved()._id, slot: at, from, rows: ids.map((streamId) => ({ streamId, title: "t" })), next });
  await page(null, [a.streamId, b.streamId], "p2");
  // The same page again (a resent slot) is a duplicate: no run, no second continuation.
  await page(null, [a.streamId, b.streamId], "p2");
  assert.equal(runs(w).length, 2);
  assert.equal(saved().slotRun.cursor, "p2");
  assert.equal(slotRuns(), 2);
  await page("p2", [b.streamId, c.streamId], null);
  assert.equal(runs(w).length, 3);
  assert.equal(saved().slotRun.done, true);
  await drain(w);
  assert.equal((w.db.rows("recordRows") as Array<Record<string, any>>).filter((r) => r.object === "task").length, 3);
  // The cap: a slot at 499 runs makes one more and ends, saying the rest wait for the next slot.
  const slot2 = slot + 86_400_000;
  await w.db.patch(saved()._id, { slotRun: { slot: slot2, cursor: null, count: 499, done: false, leaseUntil: Date.now() + 60_000 } });
  await page(null, [a.streamId, b.streamId], "more", slot2);
  assert.equal(runs(w).filter((r) => r.slot === slot2).length, 1);
  assert.equal(saved().slotRun.done, true);
  assert.match(saved().slotRun.note, /500/);
  assert.equal(slotRuns(), 2);
});

test("round robin over a weighted routing rule gives each member their weight in turns", async () => {
  const w = workspace();
  const routingRuleId = await w.db.insert("routingRules", {
    orgId: ORG, name: "Weighted", method: "weighted", assignees: [{ userId: AVERY, weight: 2 }, { userId: MORGAN, weight: 1 }], isActive: true, createdAt: 0, updatedAt: 0,
  });
  await rule(w, { name: "Route", object: "lead", trigger: { kind: "created" }, actions: [{ kind: "assign_owner", owner: { kind: "routing_rule", routingRuleId } }] });
  await as(w, RILEY);
  const made = [];
  for (const name of ["A", "B", "C", "D", "E", "F"]) made.push(await write(w, { lastName: name }));
  await fanout(w);
  await drain(w);
  const owners = await Promise.all(made.map(async (m) => (await lead(w, m.streamId)).ownerId));
  assert.deepEqual([owners.filter((o) => o === AVERY).length, owners.filter((o) => o === MORGAN).length], [4, 2]);
});

// ───────────────────────────── Versions: an agent proposes, a person approves ─────────────────────────────

const TAG = { name: "Tag", object: "lead", trigger: { kind: "created" }, conditions: [], actions: [{ kind: "set_field", field: "leadSource", value: "rule" }] };
const asAgent = async (w: W, id: string) => {
  await as(w, id);
  agentClient = "claude";
};
const inPerson = async (w: W, id: string) => {
  await as(w, id);
  agentClient = null;
};
const versions = (w: W) => w.db.rows("automationVersions") as Array<Record<string, any>>;
const rules = (w: W) => w.db.rows("automationRules") as Array<Record<string, any>>;
/** A second admin, Quinn, who approves what Riley's agent writes. */
const withQuinn = async (w: W) => w.db.insert("users", { orgId: ORG, role: "admin", isActive: true, name: "Quinn", email: "quinn@acme.test" });

test("an agent's proposal waits and does nothing; every decision refuses an agent, even on an admin's token", async () => {
  const w = workspace();
  await asAgent(w, RILEY);
  const proposed = await automations.propose.handler(w.ctx, { ...TAG, note: "Mark leads the rule saw" });
  assert.equal(proposed.status, "proposed");
  assert.match(proposed.sentence, /^When a lead is created: set .+ to rule\.$/);
  assert.deepEqual([rules(w).length, versions(w).map((v) => [v.status, v.author.agent, v.ruleId ?? null])], [0, [["proposed", "claude", null]]]);
  await inPerson(w, RILEY);
  const ruleId = (await automations.approve.handler(w.ctx, { versionId: proposed.versionId })).ruleId;
  // Every public write in convex/automations.ts but propose (stores a proposal), preview and replay (read) is a decision.
  const source = readFileSync(new URL("../convex/automations.ts", import.meta.url), "utf8");
  const writes = [...source.matchAll(/^export const (\w+) = (?:mutation|action)\(/gm)].map((m) => m[1]).filter((n) => !["propose", "preview", "replay"].includes(n));
  assert.deepEqual(writes.sort(), ["approve", "reject", "remove", "retryRun", "setStatus"]);
  await asAgent(w, RILEY);
  const again = await automations.propose.handler(w.ctx, { ...TAG, ruleId, name: "Tag again" });
  const args: Record<string, Record<string, unknown>> = { approve: { versionId: again.versionId }, reject: { versionId: again.versionId }, remove: { id: ruleId }, retryRun: { runId: "automationRuns:1" }, setStatus: { id: ruleId, status: "paused" } };
  for (const name of writes) await assert.rejects(automations[name].handler(w.ctx, args[name]), /only a person/, `${name} refuses an agent`);
  assert.deepEqual([rules(w)[0].status, rules(w)[0].name, versions(w).map((v) => v.status)], ["active", "Tag", ["approved", "proposed"]]);
  agentClient = null;
});

test("approving a proposal written against a version no longer in force is refused", async () => {
  const w = workspace();
  await inPerson(w, RILEY);
  const { ruleId } = await automations.propose.handler(w.ctx, TAG);
  await asAgent(w, RILEY);
  const stale = await automations.propose.handler(w.ctx, { ...TAG, ruleId, name: "Agent's tag" });
  await inPerson(w, RILEY);
  await automations.propose.handler(w.ctx, { ...TAG, ruleId, name: "Riley's tag" });
  await assert.rejects(automations.approve.handler(w.ctx, { versionId: stale.versionId }), /changed since this was proposed/);
  assert.deepEqual([rules(w)[0].name, rules(w)[0].version, versions(w).map((v) => [v.version, v.parent, v.status])], ["Riley's tag", 3, [[1, null, "superseded"], [2, 1, "proposed"], [3, 1, "approved"]]]);
});

test("the admin who approves an agent's rule is who it acts as, with that admin's access, not its author's; a rep can't approve", async () => {
  const w = workspace();
  const quinn = await withQuinn(w);
  await asAgent(w, RILEY);
  const proposed = await automations.propose.handler(w.ctx, { ...TAG, note: "Tag every new lead" });
  await inPerson(w, AVERY);
  await assert.rejects(automations.approve.handler(w.ctx, { versionId: proposed.versionId }));
  await inPerson(w, quinn);
  await automations.approve.handler(w.ctx, { versionId: proposed.versionId });
  assert.deepEqual([rules(w)[0].createdBy, rules(w)[0].actsAs], [RILEY, quinn]);
  await as(w, RILEY);
  const seen = await write(w, { lastName: "Okafor" });
  await fanout(w);
  await drain(w);
  assert.match(entries(w, seen.streamId).at(-1)!.source.ref, new RegExp(`^automation:.+:1:user:${quinn}$`));
  // Quinn becomes a rep who sees only their own leads: Avery's lead is outside the rule's access, though Riley, who wrote it, is an admin.
  await w.db.patch(quinn, { role: "rep" });
  await w.db.insert("rolePermissions", { orgId: ORG, role: "rep", rules: [{ object: "lead", visibility: "own", unowned: false }] });
  await as(w, AVERY);
  await write(w, { lastName: "Hidden", ownerId: AVERY });
  await fanout(w);
  assert.deepEqual(plain(runs(w).map((r) => [r.status, r.reason ?? null])), [["done", null], ["skipped", "Outside the creator's access"]]);
});

// ───────────────────────────── Replay: what a rule would have done ─────────────────────────────

/** An action's context over the workspace: its runQuery and runMutation call this module's handlers by their path. */
const actionCtx = (w: W) => {
  const call = (ref: unknown, args: Record<string, unknown>) => automations[String(ref).split(".").pop()!].handler(w.ctx, args);
  return { ...w.ctx, runQuery: call, runMutation: call };
};
/** runReplay is a plain function the module exports, not a registered handler. */
const runReplay = automations.runReplay as unknown as (ctx: unknown, job: Record<string, unknown>, foldBudget?: number) => Promise<Record<string, any>>;
const QUALIFIED = { object: "lead", trigger: { kind: "updated", field: "status", to: ["qualified"] }, conditions: [{ field: "company", op: "eq", value: "Orbit Labs" }] };

test("a replay of past changes finds the runs the fan-out then makes from the same entries, and skips the same ones", async () => {
  const w = workspace();
  await inPerson(w, RILEY);
  const { ruleId } = await automations.propose.handler(w.ctx, { ...QUALIFIED, name: "Qualified Orbit", actions: [{ kind: "set_field", field: "leadSource", value: "rule" }] });
  const a = await write(w, { lastName: "Okafor", company: "Orbit Labs", status: "new" });
  const b = await write(w, { lastName: "Lindqvist", company: "Fjord AI", status: "new" });
  const c = await write(w, { lastName: "Moreau", company: "Orbit Labs", status: "new" });
  await write(w, { status: "qualified" }, a.streamId);
  await write(w, { status: "qualified" }, b.streamId);
  await write(w, { status: "working" }, c.streamId);
  const replay = await runReplay(actionCtx(w), { orgId: ORG, userId: RILEY, userName: "Riley", ruleId, ...QUALIFIED });
  await fanout(w);
  assert.deepEqual(plain({ wouldRun: replay.runs.map((r: { streamId: string }) => r.streamId), skipped: replay.skipped, partial: replay.partial }), { wouldRun: [a.streamId], skipped: [{ reason: "Conditions not met", count: 1 }], partial: false });
  const made = plain(runs(w).map((r) => [r.streamId, r.status, r.reason ?? null])).sort((x: string[], y: string[]) => x[1].localeCompare(y[1]));
  assert.deepEqual(made, [[a.streamId, "pending", null], [b.streamId, "skipped", "Conditions not met"]]);
  assert.equal(w.db.rows("automationVersions").length, 1, "a replay writes nothing");
});

test("a replay that stops at its read limit says it is partial", async () => {
  const w = workspace();
  await inPerson(w, RILEY);
  for (const name of ["A", "B", "C"]) await write(w, { lastName: name, company: "Orbit Labs", status: "new" }).then((x) => write(w, { status: "qualified" }, x.streamId));
  const replay = await runReplay(actionCtx(w), { orgId: ORG, userId: RILEY, userName: "Riley", ...QUALIFIED }, 1);
  assert.deepEqual([replay.partial, replay.wouldRun < 3, replay.through !== null], [true, true, true]);
});

test("an agent's proposal is replayed as the member whose token it used, and never names a record they can't see", async () => {
  const w = workspace();
  await asAgent(w, RILEY);
  const proposed = await automations.propose.handler(w.ctx, { ...QUALIFIED, name: "Qualified Orbit", actions: [{ kind: "set_field", field: "leadSource", value: "rule" }] });
  agentClient = null;
  assert.ok(w.scheduled.some((s) => s.ref.endsWith("replayVersion")), "the proposal's replay is queued");
  const mine = await write(w, { lastName: "Mine", company: "Orbit Labs", status: "new", ownerId: RILEY });
  await as(w, AVERY);
  const hidden = await write(w, { lastName: "Hidden", company: "Orbit Labs", status: "new", ownerId: AVERY });
  await write(w, { status: "qualified" }, hidden.streamId);
  await as(w, RILEY);
  await write(w, { status: "qualified" }, mine.streamId);
  // Riley becomes a rep who sees only their own leads.
  await w.db.patch(RILEY, { role: "rep" });
  await w.db.insert("rolePermissions", { orgId: ORG, role: "rep", rules: [{ object: "lead", visibility: "own", unowned: false }] });
  await automations.replayVersion.handler(actionCtx(w), { versionId: proposed.versionId });
  const kept = plain(versions(w)[0].replay);
  assert.deepEqual([kept.wouldRun, kept.runs.map((r: { streamId: string; title: string }) => [r.streamId, r.title]), kept.skipped], [1, [[mine.streamId, "Mine"]], [{ reason: "A record Riley can't see", count: 1 }]]);
  assert.ok(!JSON.stringify(kept).includes(hidden.streamId) && !JSON.stringify(kept).includes("Hidden"));
});

test("a run started under one version does its actions as the admin who approved that version, not a later approver", async () => {
  const w = workspace();
  const quinn = await withQuinn(w);
  await inPerson(w, RILEY);
  const { ruleId } = await automations.propose.handler(w.ctx, TAG);
  const a = await write(w, { lastName: "Okafor" });
  await fanout(w);
  await asAgent(w, RILEY);
  const next = await automations.propose.handler(w.ctx, { ...TAG, ruleId, actions: [{ kind: "set_field", field: "leadSource", value: "quinn" }] });
  await inPerson(w, quinn);
  await automations.approve.handler(w.ctx, { versionId: next.versionId });
  await drain(w);
  assert.equal((await lead(w, a.streamId)).leadSource, "rule");
  assert.match(entries(w, a.streamId).at(-1)!.source.ref, /:1:user:users:riley$/);
});
