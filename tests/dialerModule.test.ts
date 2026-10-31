import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseModuleManifest } from "../modules/kernel/manifest.ts";
import { calls } from "../modules/examples/dialer/server.ts";
import { pickCallable } from "../convex/lib/dialer/candidates.ts";
import { defaultSlots, planUpgrade } from "../modules/kernel/upgrade.ts";
import type { CallContext, MissingRead, ReadDoc } from "../modules/kernel/calls.ts";

test("the displayed pick scans the whole queue and cannot substitute an unshown person at dial time", async () => {
  const candidates = Array.from({ length: 52 }, (_, i) => ({ contactId: `p${i}`, phone: String(i) }));
  const called = new Set(["p50"]);
  const pick = await pickCallable(candidates, 1, called, async (phone) => Number(phone) >= 50);
  assert.deepEqual(pick, { lines: 1, contactIds: ["p51"], held: 50 });
  const shown = candidates.filter((c) => pick.contactIds.includes(c.contactId));
  assert.deepEqual(await pickCallable(shown, 1, called, async () => true), { lines: 1, contactIds: ["p51"], held: 0 });
  assert.deepEqual(await pickCallable(shown, 1, called, async () => false), { lines: 1, contactIds: [], held: 1 });
});

const ctx = (args: Record<string, unknown>) => ({ now: 1_000, caller: { userId: "system", role: "system" as const }, args });
const doc = (key: string, data: Record<string, unknown>) => ({ key, version: 3, owner: null, data }) as never;

test("a queue holds the audience's dialable people in order, and an earlier queue's people leave it or wait again", async () => {
  const out = await calls.fillQueue(ctx({ rep: "u1" }), {
    queue: doc("u1", { snapshot: "snapB", audienceSnapshot: "snapB" }),
    people: [
      { id: "con_a", name: "Ada", phone: "+442079460013" },
      { id: "con_b", name: "Bo", phone: "" },
      { id: "con_c", name: null, phone: "(415) 555-0123" },
      { id: "con_d", name: "Di", phone: "12345" },
    ],
    items: [doc("u1|con_c", { person: "con_c", queue: "snapA", state: "called" }), doc("u1|con_z", { person: "con_z", queue: "snapA", state: "queued" })],
  });
  assert.deepEqual(out.byKey!.u1, [
    { op: "put", collection: "items", key: "u1|con_a", data: { rep: "u1", person: "con_a", name: "Ada", phone: "+442079460013", queue: "snapB", position: 1 } },
    { op: "put", collection: "items", key: "u1|con_c", data: { rep: "u1", person: "con_c", name: "Unnamed", phone: "(415) 555-0123", queue: "snapB", position: 2 } },
    { op: "transition", machine: "item", name: "requeue", key: "u1|con_c" },
    { op: "delete", collection: "items", key: "u1|con_z" },
    { op: "patch", collection: "queues", key: "u1", expect: [{ collection: "queues", key: "u1", version: 3 }], data: { queued: 2, withoutPhone: 2 } },
  ]);
});

const rep: CallContext = { now: Date.parse("2026-10-21T12:00:00Z"), caller: { userId: "u1", role: "rep" }, args: {} };
const task = (key: string, contact: string, dueDay: string): ReadDoc => ({ key, version: 1, owner: "u1", parentKey: null, createdAt: 1, updatedAt: 1,
  data: { contact, dueDay, sequence: "sequence_one", contactName: "Stale task name", phone: "+14155559999" } });

test("due task loads preserve the existing queue when the provider or dialable people are unavailable", async () => {
  const messages = new Set();
  for (const missing of ["not_installed", "off", "not_provided"] as MissingRead["missing"][]) {
    const out = await calls.loadCallTasks(rep, { tasks: { missing }, people: [], queue: doc("u1", { snapshot: "old" }), items: [] });
    assert.deepEqual(out.intents ?? [], []);
    assert.equal((out.value as { loaded: boolean }).loaded, false);
    messages.add((out.value as { message: string }).message);
  }
  assert.equal(messages.size, 3);
  for (const tasks of [[], [task("hidden", "con_hidden", "2026-10-21")]]) {
    const out = await calls.loadCallTasks(rep, { tasks, people: [], queue: doc("u1", { snapshot: "old" }), items: [] });
    assert.deepEqual(out.intents ?? [], []);
    assert.equal((out.value as { loaded: boolean }).loaded, false);
  }
});

test("due tasks use current people once in stable due order and fence queue replacement and requeue", async () => {
  const out = await calls.loadCallTasks(rep, {
    tasks: [task("later", "con_b", "2026-10-21"), task("first", "con_a", "2026-10-20"), task("same-day", "con_c", "2026-10-20"),
      task("repeat", "con_a", "2026-10-21"), task("hidden", "con_hidden", "2026-10-21"), task("no-phone", "con_d", "2026-10-21")],
    people: [{ id: "con_a", name: "Current Ada", phone: "+442079460013" }, { id: "con_b", phone: "+442079460014" },
      { id: "con_c", name: "Current Cy", phone: "+442079460015" }, { id: "con_d", name: "Di", phone: null }],
    queue: doc("u1", { snapshot: "old", audience: "audience" }),
    items: [doc("u1|con_a", { person: "con_a", state: "called" }), doc("u1|con_old", { person: "con_old", state: "queued" })],
  });
  const writes = out.intents!;
  const queue = writes.find((i) => i.op === "put" && i.collection === "queues");
  assert.ok(queue?.op === "put");
  assert.equal(queue.data.audience, undefined);
  assert.equal(queue.data.audienceSnapshot, undefined);
  assert.deepEqual([queue.data.count, queue.data.queued, queue.data.withoutPhone, queue.data.unavailable, queue.data.duplicateTasks, queue.data.loadedAt, queue.data.cutoffDay], [6, 3, 1, 1, 1, rep.now, "2026-10-21"]);
  assert.deepEqual(queue.expect, [{ collection: "queues", key: "u1", version: 3 }, { collection: "items", key: "u1|con_a", version: 3 }, { collection: "items", key: "u1|con_old", version: 3 }]);
  const items = writes.flatMap((i) => i.op === "put" && i.collection === "items" ? [i] : []);
  assert.deepEqual(items.map((i) => i.data.person), ["con_a", "con_c", "con_b"]);
  assert.deepEqual(items.map((i) => [i.data.name, i.data.position]), [["Current Ada", 1], ["Current Cy", 2], ["Unnamed", 3]]);
  assert.deepEqual(items[0].data.sourceTasks, [{ key: "first", sequence: "sequence_one", dueDay: "2026-10-20" }, { key: "repeat", sequence: "sequence_one", dueDay: "2026-10-21" }]);
  assert.equal(items[0].data.phone, "+442079460013");
  assert.deepEqual(items[0].expect, [{ collection: "items", key: "u1|con_a", version: 3 }]);
  assert.ok(writes.some((i) => i.op === "transition" && i.name === "reload" && i.key === "u1|con_a"));
  assert.ok(writes.some((i) => i.op === "delete" && i.key === "u1|con_old"));
  const fill = await calls.fillQueue(ctx({ rep: "u1" }), { queue: doc("u1", queue.data), items: [], people: [] });
  assert.deepEqual(fill.byKey, { u1: [] });
  const create = await calls.loadCallTasks(rep, { tasks: [task("first", "con_a", "2026-10-20")], people: [{ id: "con_a", phone: "+442079460013" }], queue: null, items: [] });
  assert.deepEqual(create.intents?.[0].expect, [{ collection: "queues", key: "u1", version: null }]);
});

test("a full provider window keeps all stable task keys while queueing one call per person", async () => {
  const tasks = Array.from({ length: 500 }, (_, i) => task(`task${i}`, "con_a", "2026-10-21"));
  const out = await calls.loadCallTasks(rep, { tasks, people: [{ id: "con_a", phone: "+442079460013" }], queue: null, items: [] });
  const items = out.intents!.flatMap((i) => i.op === "put" && i.collection === "items" ? [i] : []);
  assert.equal(items.length, 1);
  assert.equal((items[0].data.sourceTasks as unknown[]).length, 500);
  assert.equal((out.value as { count: number }).count, 1);
  assert.match((out.value as { message: string }).message, /More due tasks may exist/);
});

test("Dialer task reads require normal upgrade consent and keep audience and person phone grants", () => {
  const raw = JSON.parse(readFileSync("modules/examples/dialer/module.json", "utf8"));
  const parsed = parseModuleManifest(raw);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  const from = structuredClone(parsed.manifest);
  delete from.uses;
  from.version = "0.3.0";
  const upgrade = planUpgrade(from, defaultSlots(from), parsed.manifest);
  assert.deepEqual(upgrade.newReads, ["uses @canon/sequences callTasks.v1"]);
  assert.deepEqual(upgrade.problems, []);
  assert.deepEqual(parsed.manifest.reads?.people, ["name", "phone"]);
  assert.equal(parsed.manifest.calls?.loadCallTasks.system, undefined);
  assert.equal(parsed.manifest.calls?.loadCallTasks.agent, "allowed");
  assert.deepEqual(parsed.manifest.calls?.loadCallTasks.reads.tasks, { module: "@canon/sequences", provide: "callTasks.v1", limit: 500 });
  const audienceRead = parsed.manifest.calls?.load.reads.snapshot;
  assert.equal(audienceRead && "canon" in audienceRead ? audienceRead.canon : null, "audiences.snapshot");
});

test("a call Canon logs marks the person called for the rep who made it, once", async () => {
  const change = (before: unknown, after: Record<string, unknown> | null, people: string[]) => ({ id: "act", at: 1, before, after, targets: { deals: [], companies: [], people } });
  const out = await calls.onCalls(ctx({ changes: [
    change(null, { kind: "call", ownerId: "u1", personId: "con_a" }, ["con_a"]),
    change({ kind: "call" }, { kind: "call", ownerId: "u1", personId: "con_b" }, ["con_b"]),
    change(null, { kind: "note", ownerId: "u1", personId: "con_c" }, ["con_c"]),
  ] }), {});
  assert.deepEqual(out.intents, [{ op: "dirty", job: "mark", key: "u1|con_a" }]);

  const mark = (state: string) => calls.markCalled(ctx({ rep: "u1", person: "con_a" }), { item: [doc("u1|con_a", { state })] });
  assert.deepEqual((await mark("queued")).byKey, { "u1|con_a": [{ op: "transition", machine: "item", name: "called", key: "u1|con_a" }] });
  assert.deepEqual((await mark("skipped")).byKey, { "u1|con_a": [] });
});

test("a phone component reads a list binding's rows and one-doc values", () => {
  const errorsWith = (change: Record<string, unknown>) => {
    const m = JSON.parse(readFileSync("modules/examples/dialer/module.json", "utf8"));
    Object.assign(m.pages[0].body.find((x: { c: string }) => x.c === "phone"), change);
    const out = parseModuleManifest(m);
    return out.ok ? [] : out.errors.map((e) => e.replace(/^pages\[0\]\.body\[\d+\]/, ""));
  };
  assert.deepEqual(errorsWith({}), []);
  assert.deepEqual(errorsWith({ from: "queue" }), [".from names queue, which binds one doc, not a list"]);
  assert.deepEqual(errorsWith({ person: "nope", since: { bind: "queued", field: "position" } }), [".person names nope, which is not a field or a count of queued's rows", ".since names queued, which binds a list, not one doc"]);
});

test("Dialer's person panel uses a granted record-phone read and preserves the record id", async () => {
  const manifest = JSON.parse(readFileSync("modules/examples/dialer/module.json", "utf8"));
  const parsed = parseModuleManifest(manifest);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  const person = { id: "con_a", name: "Ada", phone: "+442079460013" };
  assert.deepEqual(await calls.person(ctx({ person: "con_a" }), { person: [person] }), { value: [person] });
  const panel = manifest.contributes.personPage.panels[0];
  const withoutPhone = structuredClone(manifest);
  withoutPhone.reads.people = ["name"];
  assert.equal(parseModuleManifest(withoutPhone).ok, false, "the record-phone UI needs a declared phone grant");
  const wrongBinding = structuredClone(manifest);
  wrongBinding.contributes.personPage.panels[0].body[0].from = "queue";
  assert.equal(parseModuleManifest(wrongBinding).ok, false, "record mode reads a caller-scoped call binding");
  const mixed = structuredClone(manifest);
  mixed.contributes.personPage.panels[0].body[0].person = "id";
  assert.equal(parseModuleManifest(mixed).ok, false, "record mode cannot also declare a queue");
  const queuePanel = structuredClone(manifest);
  queuePanel.contributes.personPage.panels[0] = { ...panel, bind: { queue: manifest.pages[0].bind.queue, queued: manifest.pages[0].bind.queued }, body: [manifest.pages[0].body.find((n: { c: string }) => n.c === "phone")] };
  assert.equal(parseModuleManifest(queuePanel).ok, false, "panels expose only record-mode phone controls");
});
