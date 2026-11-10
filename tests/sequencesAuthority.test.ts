import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { MutationCtx } from "../convex/_generated/server";
import type { Id } from "../convex/_generated/dataModel";
import type { Sq1LifecycleCommand } from "../convex/lib/sequences/lifecycle";
import { defaultSlots } from "../modules/kernel/upgrade.ts";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const manifest = JSON.parse(readFileSync("modules/examples/sequences/module.json", "utf8"));
const rep = { _id: "rep", orgId: "org", role: "rep", name: "Ria", email: "ria@example.test", isActive: true };
const admin = { ...rep, _id: "admin", role: "admin" };
let caller: typeof rep | null = rep;
let agent: string | null = null;
const loaded = loadConvex(["modules.ts", "moduleActivityPublications.ts", "lib/sequences/lifecycle.ts"], {
  "lib.ts": (real) => ({ ...real, getCurrentUser: async () => caller, requireUser: async () => caller, agentClientOf: async () => agent }),
});
const modules = loaded["modules.ts"];
const lifecycle = loaded["lib/sequences/lifecycle.ts"] as unknown as Pick<typeof import("../convex/lib/sequences/lifecycle"), "sq1HumanContext" | "applySq1Lifecycle" | "prepareSq1EmailRequest">;
function dataOf(row: Record<string, unknown> | undefined): Record<string, unknown> {
  assert.ok(row && row.data !== null && typeof row.data === "object" && !Array.isArray(row.data));
  return row.data as Record<string, unknown>;
}

async function fixture(kind = "auto_email") {
  caller = rep; agent = null;
  const db = memoryDb({
    organizations: [{ _id: "org" }], users: [rep, admin],
    modulePackages: [{ _id: "pkg", orgId: "org", moduleId: manifest.id, slug: "sequences", manifest: JSON.stringify(manifest), manifestHash: "fixture", version: manifest.version,
      source: { kind: "github-public", owner: "o", repo: "r", ref: "main", sha: "a".repeat(40) }, status: "installed", epoch: 1, slots: defaultSlots(manifest) }],
    recipeEnablements: [{ _id: "enabled", orgId: "org", point: "module", recipeId: manifest.id, contributionKey: "nav", enabled: true }],
    emailAccounts: [{ _id: "mailbox", orgId: "org", userId: "rep", address: "ria@example.test", status: "ok", unipileAccountId: "provider", connectedAt: 1, provider: "gmail" }],
  });
  const ordinary: Array<{ ref: string; delay: number; args: Record<string, unknown> }> = [], publications: typeof ordinary = [];
  const scheduler = { runAfter: async (delay: number, ref: unknown, args: Record<string, unknown>) => {
    if (String(ref) === "internal.moduleJobs.run") { assert.equal(delay, 0); assert.deepEqual(JSON.parse(JSON.stringify(args)), { orgId: "org", moduleId: manifest.id }); ordinary.push({ ref: String(ref), delay, args }); return "scheduled"; }
    assert.equal(String(ref), "internal.moduleActivityPublications.run", "Unexpected sequence fixture work");
    assert.ok(delay >= 0); publications.push({ ref: String(ref), delay, args }); return "scheduled";
  } };
  const ctx = () => ({ db: new Proxy(db, { get: (target, key) => { const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value; } }), auth: { getUserIdentity: async () => null }, scheduler }) as unknown as MutationCtx;
  async function transaction<T>(body: (context: MutationCtx) => Promise<T>) {
    const cp = db.checkpoint(), queues = structuredClone({ ordinary, publications });
    try { return await body(ctx()); }
    catch (error) { db.rollback(cp); ordinary.splice(0, ordinary.length, ...queues.ordinary); publications.splice(0, publications.length, ...queues.publications); throw error; }
  }
  const publisher = (ref: unknown) => {
    const [visibility, file, name] = String(ref).split(".");
    assert.equal(visibility, "internal"); assert.equal(file, "moduleActivityPublications");
    const handler = loaded[`${file}.ts`][name]; assert.ok(handler, `Unknown publisher ${String(ref)}`); return handler;
  };
  const action = { scheduler, runQuery: (ref: unknown, args: Record<string, unknown>) => publisher(ref).handler(ctx(), args), runMutation: (ref: unknown, args: Record<string, unknown>) => transaction((context) => publisher(ref).handler(context, args)) };
  async function settlePublications() {
    const seen = new Set<string>();
    while (publications.some((task) => task.delay === 0)) {
      const position = JSON.stringify([publications, db.rows("moduleActivityHeads"), db.rows("moduleActivityPublications")]);
      assert.ok(seen.size < 100 && !seen.has(position), "Publication must progress"); seen.add(position);
      const [task] = publications.splice(publications.findIndex((item) => item.delay === 0), 1);
      await publisher(task.ref).handler(action, task.args);
    }
    assert.equal(db.rows("moduleActivityPublications").some((row) => row.state === "failed"), false, "Publication failure retains its retry");
    assert.equal(db.rows("moduleActivityHeads").some((row) => row.pending), false, "Independent requests require completed publication");
  }
  const op = async (name: string, data: Record<string, unknown>) => { const result = await transaction((context) => modules.op.handler(context, { module: "sequences", op: name, ...data })); await settlePublications(); return result; };
  const sequence = await op("sequences.create", { data: { name: "Canonical", senders: [{ channel: "email", sender: "mailbox" }] } });
  const step = await op("steps.create", { parentKey: sequence.key, data: { kind, delayDays: 0, ...(kind === "auto_email" ? { variants: [{ id: "A", weight: 100, subject: "Hello", body: "Canonical text" }] } : {}) } });
  const run = async (command: Sq1LifecycleCommand, admitted: string[] = []) => {
    const result = await transaction(async (c) => lifecycle.applySq1Lifecycle(c, await lifecycle.sq1HumanContext(c, admitted), command));
    await settlePublications(); return result;
  };
  return { db, ctx, op, sequence: sequence.key as string, step: step.key as string, run, settlePublications };
}

test("canonical launch consent locks actual plan identities across public module writes and invalidates atomically on trusted edits", async () => {
  const h = await fixture();
  const approved = await h.run({ kind: "approveLaunch", sequenceKey: h.sequence, expectedProjectionVersion: 1, totalRequestCap: 10 });
  const launchId = approved.id as Id<"sequenceLaunches">;
  const launch = h.db.rows("sequenceLaunches")[0];
  assert.equal(launch.authorizationEpoch, 1);
  assert.equal(launch.reservedRequests, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(launch.approvedSenderRefs)), ["mailbox"]);
  assert.equal(h.db.rows("outboxRequests").length, 0);
  assert.equal(h.db.rows("outboundMessages").length, 0);
  assert.equal(h.db.rows("mailboxSendGrants").length, 0, "launch consent confers no mailbox grant");
  await assert.rejects(h.op("steps.update", { key: h.step, expect: 1, data: { delayDays: 1 } }), /canonical sequence lifecycle/);
  await assert.rejects(h.op("steps.delete", { key: h.step, expect: 1 }), /canonical sequence lifecycle/);
  await assert.rejects(h.op("steps.create", { parentKey: h.sequence, data: { kind: "call", delayDays: 0 } }), /bound sequence/);
  await assert.rejects(modules.transition.handler(h.ctx(), { module: "sequences", machine: "sequence", name: "pause", key: h.sequence, expect: 2 }), /canonical sequence lifecycle/);
  const changed = await h.run({ kind: "editPlanSource", launchId, expectedLaunchRevision: 1, collection: "steps", key: h.step, expectedProjectionVersion: 1, patch: { delayDays: 1 } });
  assert.equal(changed.revision, 2);
  assert.equal(h.db.rows("sequenceLaunches")[0].authorizationEpoch, 2);
  assert.equal(h.db.rows("sequenceLaunches")[0].state, "paused");
  assert.equal(dataOf(h.db.rows("moduleDocs").find((r) => r.key === h.sequence)).status, "paused");
  assert.equal(dataOf(h.db.rows("moduleDocs").find((r) => r.key === h.step)).delayDays, 1);
  await assert.rejects(h.op("steps.update", { key: h.step, expect: 2, data: { note: "Injected into an absent bound field" } }), /canonical sequence lifecycle/);
  await assert.rejects(h.op("sequences.update", { key: h.sequence, expect: 3, data: { maxAddsPerDay: 999 } }), /canonical sequence lifecycle/);
  const resumed = await h.run({ kind: "approveLaunch", sequenceKey: h.sequence, expectedProjectionVersion: 3, expectedLaunchRevision: 2, totalRequestCap: 10 });
  assert.equal(resumed.id, launchId);
  assert.equal(h.db.rows("sequenceLaunches")[0].authorizationEpoch, 3);
  assert.equal(h.db.rows("sequenceLaunches")[0].templateSetHash, launch.templateSetHash, "unchanged template membership does not change owner set identity");
});

test("SQ1 consent requires a live human and same transaction while manual-only sequence writes remain usable", async () => {
  const h = await fixture("call");
  const c = h.ctx();
  const authority = await lifecycle.sq1HumanContext(c);
  await assert.rejects(lifecycle.applySq1Lifecycle(h.ctx(), authority, { kind: "approveLaunch", sequenceKey: h.sequence, expectedProjectionVersion: 1, totalRequestCap: 10 }), /original transaction/);
  await assert.rejects(h.run({ kind: "approveLaunch", sequenceKey: h.sequence, expectedProjectionVersion: 1, totalRequestCap: 10 }), /Manual-only/);
  assert.equal(h.db.rows("sequenceLaunches").length, 0);
  await h.op("steps.update", { key: h.step, expect: 1, data: { delayDays: 1 } });
  await modules.transition.handler(h.ctx(), { module: "sequences", machine: "sequence", name: "launch", key: h.sequence, expect: 1 });
  assert.equal(dataOf(h.db.rows("moduleDocs").find((r) => r.key === h.sequence)).status, "active");
  // Turned off where Canon keeps the member: what reads their role judges the stored row.
  caller = { ...rep, isActive: false };
  await h.db.patch("rep", { isActive: false });
  await assert.rejects(lifecycle.sq1HumanContext(h.ctx()), /signed-in person/);
  await h.db.patch("rep", { isActive: true });
  caller = rep;
  agent = "agent";
  await assert.rejects(lifecycle.sq1HumanContext(h.ctx()), /signed-in person/);
  agent = null; caller = null;
  await assert.rejects(lifecycle.sq1HumanContext(h.ctx()), /signed-in person/);
});

test("public module disable and uninstall invalidate bound launches and generic upgrades cannot strip retained identities", async () => {
  const h = await fixture();
  await h.run({ kind: "approveLaunch", sequenceKey: h.sequence, expectedProjectionVersion: 1, totalRequestCap: 10 });
  caller = admin;
  const next = { ...manifest, version: "0.8.0" };
  await assert.rejects(modules.storeModule.handler(h.ctx(), { moduleId: manifest.id, source: { kind: "github-public", owner: "o", repo: "r", ref: "main", sha: "b".repeat(40) },
    version: next.version, manifest: JSON.stringify(next), manifestHash: "new", bundleHash: "new", bundleStorageId: "bundle:new" }), /canonical sequence bindings/);
  const c = h.ctx(), authority = await lifecycle.sq1HumanContext(c);
  await modules.setEnabled.handler(c, { moduleId: manifest.id, enabled: false });
  await assert.rejects(lifecycle.applySq1Lifecycle(c, authority, { kind: "pauseLaunch", launchId: h.db.rows("sequenceLaunches")[0]._id as Id<"sequenceLaunches">, expectedLaunchRevision: 2 }), /live sequence lifecycle context changed/);
  assert.equal(h.db.rows("sequenceLaunches")[0].state, "paused");
  assert.equal(h.db.rows("sequenceLaunches")[0].authorizationEpoch, 2);
  assert.equal(dataOf(h.db.rows("moduleDocs").find((r) => r.key === h.sequence)).status, "paused");
  await h.settlePublications();
  await modules.uninstall.handler(h.ctx(), { moduleId: manifest.id });
  assert.equal(h.db.rows("modulePackages")[0].status, "uninstalled");
  assert.equal(h.db.rows("sequenceLaunches")[0].authorizationEpoch, 3);
  assert.equal(h.db.rows("sequenceLaunches").length, 1, "uninstall retains canonical history");
  assert.equal(h.db.rows("outboundMessages").length, 0);
});

test("explicit contact binding and request preparation retain stable identity, refuse generic finish and close only matching tasks on trusted finish", async () => {
  const h = await fixture();
  const approved = await h.run({ kind: "approveLaunch", sequenceKey: h.sequence, expectedProjectionVersion: 1, totalRequestCap: 10 });
  const launchId = approved.id as Id<"sequenceLaunches">;
  const contact = "con_person", otherContact = "con_other", key = `${h.sequence}|${contact}`;
  await modules.applyCall.handler(h.ctx(), { module: "sequences", call: "advance", epoch: 1, system: "org", admit: [], intents: [
    { op: "put", collection: "enrollments", data: { sequence: h.sequence, contact, stepIndex: 0, rep: "rep" } },
    { op: "put", collection: "tasks", data: { sequence: h.sequence, contact, stepIndex: 0, rep: "rep", kind: "call", dueDay: "2026-10-20" } },
    { op: "put", collection: "tasks", data: { sequence: h.sequence, contact: otherContact, stepIndex: 0, rep: "rep", kind: "call", dueDay: "2026-10-20" } },
  ] });
  await modules.systemTransition.handler(h.ctx(), { orgId: "org", module: "sequences", machine: "enrollment", name: "start", key, expect: 1 });
  const bind: Sq1LifecycleCommand = { kind: "bindEnrollment", launchId, enrollmentKey: key, expectedLaunchRevision: 1, expectedProjectionVersion: 2 };
  await assert.rejects(h.run(bind), /actual contact/);
  const bound = await h.run(bind, [`people::${contact}`]);
  const enrollmentId = bound.id as Id<"sequenceEnrollments">;
  const c = h.ctx(), authority = await lifecycle.sq1HumanContext(c);
  const request = await lifecycle.prepareSq1EmailRequest(c, authority, enrollmentId, 1);
  const same = await lifecycle.prepareSq1EmailRequest(c, authority, enrollmentId, 2);
  assert.equal(same, request);
  assert.equal(h.db.rows("outboxRequests").length, 1);
  assert.equal(h.db.rows("outboxRequests")[0].state, "preparing");
  assert.equal(h.db.rows("sequenceLaunches")[0].reservedRequests, 0);
  assert.equal(h.db.rows("outboundMessages").length, 0);
  const currentProjection = h.db.rows("moduleDocs").find((r) => r.collection === "enrollments" && r.key === key)!;
  await assert.rejects(modules.transition.handler(h.ctx(), { module: "sequences", machine: "enrollment", name: "finish", key, expect: currentProjection.version }), /canonical sequence lifecycle/);
  await h.run({ kind: "finishEnrollment", enrollmentId, expectedEnrollmentRevision: 2 });
  assert.equal(h.db.rows("outboxRequests")[0].state, "withdrawn");
  assert.equal(h.db.rows("sequenceEnrollments")[0].state, "finished");
  assert.equal(dataOf(h.db.rows("moduleDocs").find((r) => r.collection === "tasks" && dataOf(r).contact === contact)).state, "skipped");
  assert.equal(dataOf(h.db.rows("moduleDocs").find((r) => r.collection === "tasks" && dataOf(r).contact === otherContact)).state, "open");
  await assert.rejects(h.run({ ...bind, expectedProjectionVersion: 5 }, [`people::${contact}`]));
  assert.equal(h.db.rows("sequenceEnrollments").length, 1);
});
