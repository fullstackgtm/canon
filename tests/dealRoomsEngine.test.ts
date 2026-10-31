import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CallContext, Intent, ReadDoc } from "../modules/kernel/calls.ts";
import type { VisitArgs, VisitFunction, VisitorWrite } from "../modules/kernel/visit.ts";
import { assessRoom } from "../modules/examples/deal-rooms/dealRooms.calc.ts";
import { calls, SEED_TEMPLATES } from "../modules/examples/deal-rooms/server.ts";
import { sharePolicyHash } from "../convex/lib/modules/shares.ts";
import { signVisitEnvelope, visitHash } from "../src/lib/visitEnvelope.ts";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const NOW = Date.parse("2026-11-20T15:00:00Z");
const ctx = (args: Record<string, unknown>): CallContext => ({ now: NOW, caller: { userId: "avery", role: "rep" }, args });
const doc = (key: string, data: Record<string, unknown>, parentKey: string | null = null): ReadDoc => ({ key, version: 1, data, owner: null, parentKey, createdAt: NOW, updatedAt: NOW });
const close = SEED_TEMPLATES[0];
const D1 = { id: "D1", name: "Acme – Platform", amount: 12_000_000, closeDate: "2026-12-15", ownerId: "avery" };
const committee = [
  { name: "Priya Shah", email: "priya@acme.com", slot: "champion" },
  { name: "Dan Ruiz", email: "dan@acme.com", slot: "executive" },
];
const reads = (existing: ReadDoc[] = []) => ({
  template: doc(close.key, { name: close.name, kind: close.kind, active: true }),
  steps: close.steps.map((s, i) => doc(`t${i + 1}`, { ...s, order: i + 1 }, close.key)),
  deal: [D1],
  existing,
});

test("G-1 fromTemplate(D1): one room, ten steps due back from the close, owners from the committee, never guessed", async () => {
  const out = await calls.fromTemplate(ctx({ deal: "D1", template: close.key, stakeholders: committee }), reads());
  const intents = out.intents as Intent[];
  const room = intents.filter((i) => i.op === "put" && i.collection === "rooms");
  const steps = intents.flatMap((i) => (i.op === "put" && i.collection === "steps" ? [i.data] : []));
  assert.equal(room.length, 1);
  assert.deepEqual(room[0].expect, [{ collection: "rooms", key: "D1|close", version: null }]);
  assert.deepEqual(steps.map((s) => s.dueOn), ["2026-10-31", "2026-11-05", "2026-11-10", "2026-11-15", "2026-11-20", "2026-11-25", "2026-12-01", "2026-12-05", "2026-12-12", "2026-12-22"]);
  assert.deepEqual(steps.map((s) => s.afterClose), [false, false, false, false, false, false, false, false, false, true]);
  assert.deepEqual([steps[7].ownerToConfirm, steps[7].buyerOwnerName, steps[7].sellerOwner], [true, undefined, undefined]);
  assert.deepEqual(steps.filter((s) => s.ownerToConfirm).map((s) => s.title), ["Procurement vendor setup"]);
  assert.deepEqual([steps[5].buyerOwnerName, steps[5].buyerOwnerEmail], ["Dan Ruiz", "dan@acme.com"]);
  assert.equal(steps[2].sellerOwner, "avery");
  assert.deepEqual(out.value, { key: "D1|close", steps: 10, toConfirm: 1 });
});

test("G-1 running it again refuses: the deal already has a close room", () => {
  assert.throws(() => calls.fromTemplate(ctx({ deal: "D1", template: close.key }), reads([doc("D1|close", { deal: "D1", kind: "close" })])), /already has a close room/);
});

const healthRoom = (extra: Record<string, unknown> = {}) => doc("D1|close", { deal: "D1", kind: "close", status: "live", rep: "avery", lastBuyerAt: Date.parse("2026-11-19T18:00:00Z"), ...extra });
const healthSteps = () => close.steps.map((s, i) => doc(`s${i + 1}`, { ...s, dueOn: ["2026-10-31", "2026-11-05", "2026-11-10", "2026-11-15", "2026-11-20", "2026-11-25", "2026-12-01", "2026-12-05", "2026-12-12", "2026-12-22"][i], afterClose: i === 9, status: i < 3 ? "done" : "open" }, "D1|close"));
const system = (args: Record<string, unknown> = {}): CallContext => ({ now: NOW, caller: { userId: "system", role: "system" }, args });
const assessment = async (steps = healthSteps(), deal = D1, room = healthRoom()) => {
  const out = await calls.health(system({ keys: [room.key] }), { rooms: [room], steps, deals: [deal] });
  const patch = out.byKey![room.key].find((i) => i.op === "patch");
  assert.equal(patch?.op, "patch");
  return { out, patch: patch as Extract<Intent, { op: "patch" }> };
};

test("G-2 health: three done of nine, one overdue buyer step, and 21 hours of quiet", async () => {
  const { patch } = await assessment();
  assert.deepEqual({ ...patch.data, progress: Number(Number(patch.data.progress).toFixed(4)) }, {
    health: "needs_attention", progress: 0.3333, slipDays: 0, overdue: 1, buyerOverdueMax: 5, quietDays: 0,
    planEnd: "2026-12-12", nextDue: "2026-11-15", targetDate: "2026-12-15",
  });
  assert.equal(patch.expect!.length, 11);
});

test("G-3 and G-4: slip follows the deal's close date, while step dates stay fixed", async () => {
  const steps = healthSteps(); steps[7].data.dueOn = "2026-12-18";
  const { patch } = await assessment(steps);
  assert.deepEqual([patch.data.planEnd, patch.data.slipDays, patch.data.health], ["2026-12-18", 3, "at_risk"]);
  const figures = await calls.roomFigures(ctx({}), { room: healthRoom(patch.data), steps });
  assert.equal((figures.value as Record<string, unknown>).slipBanner, "Plan ends 3 days after the close date.");
  const watch = await calls.onDeals(system({ changes: [{ id: "D1", at: NOW, before: { closeDate: "2026-12-15" }, after: { closeDate: "2026-12-20" } }] }), {});
  assert.deepEqual(watch.intents, [{ op: "dirty", job: "health", key: "D1|close" }, { op: "dirty", job: "health", key: "D1|onboarding" }]);
  const refreshed = await assessment(steps, { ...D1, closeDate: "2026-12-20" }, healthRoom(patch.data));
  assert.deepEqual(refreshed.patch.data, { health: "needs_attention", slipDays: 0, targetDate: "2026-12-20" });
  assert.deepEqual(refreshed.out.byKey!["D1|close"].map((i) => "collection" in i ? i.collection : null), ["rooms"]);
});

test("G-5: closed deals move open rooms through the matching system transition", async () => {
  const room = doc("D2|close", { deal: "D2", kind: "close", status: "live", rep: "avery" });
  const out = await calls.health(system({ keys: ["D2|close"] }), { rooms: [room], steps: [], deals: [{ id: "D2", isClosed: true, isWon: false }] });
  assert.deepEqual(out.byKey!["D2|close"].at(-1), { op: "transition", machine: "room", name: "closeLost", key: "D2|close", expect: [{ collection: "rooms", key: "D2|close", version: 1 }] });
  const won = await calls.health(system({ keys: ["D2|close"] }), { rooms: [room], steps: [], deals: [{ id: "D2", isClosed: true, isWon: true }] });
  assert.equal((won.byKey!["D2|close"].at(-1) as Extract<Intent, { op: "transition" }>).name, "closeWon");
});

test("health leaves unknown buyer activity unpenalized, avoids no-op writes and preserves closed history", async () => {
  const room = healthRoom(); delete room.data.lastBuyerAt;
  const steps = healthSteps().map((s) => ({ ...s, data: { ...s.data, status: "done" } }));
  const { patch } = await assessment(steps, D1, room);
  assert.deepEqual([patch.data.health, patch.data.progress, patch.data.quietDays, patch.data.lastBuyerAt], ["on_track", 1, undefined, undefined]);
  const current = { ...room, data: { ...room.data, ...patch.data } };
  const out = await calls.health(system({ keys: [room.key, "missing|close"] }), { rooms: [current], steps, deals: [D1] });
  assert.deepEqual(out, { byKey: { "D1|close": [], "missing|close": [] } });
  const closed = await calls.health(system({ keys: [room.key] }), { rooms: [{ ...current, data: { ...current.data, status: "lost" } }], steps, deals: [D1] });
  assert.deepEqual(closed, { byKey: { "D1|close": [] } });
});

test("daily reminders reach seller owners only; digest is scoped to supplied room reads", async () => {
  const room = healthRoom({ title: "Acme close", health: "at_risk" });
  const steps = [doc("seller", { status: "open", side: "seller", sellerOwner: "avery", dueOn: "2026-11-21" }, room.key), doc("buyer", { status: "open", side: "buyer", sellerOwner: "dan", dueOn: "2026-11-21" }, room.key)];
  const daily = await calls.daily(system(), { rooms: [room], steps });
  assert.deepEqual(daily.intents, [{ op: "dirty", job: "health", key: room.key }, { op: "notify", to: ["avery"], subject: "Deal room steps due tomorrow", message: "Acme close: 1 step due tomorrow.", link: "rooms/D1%7Cclose?view=plan", badge: "Deal room" }]);
  assert.deepEqual(await calls.hourly(system(), { rooms: [room] }), { intents: [{ op: "dirty", job: "health", key: room.key }] });
  assert.deepEqual(await calls.digest(ctx({}), { rooms: [room], steps }), { value: { live: 1, atRisk: 1, overdue: 0, buyerActions: null, buyerActivity: "Buyer activity is not available yet." } });
});


test("quiet-time thresholds require measured activity; onboarding counts post-close steps", () => {
  const input = { steps: [], now: NOW, kind: "close" as const, status: "live", linksIssued: 1 };
  assert.deepEqual([assessRoom(input).health, assessRoom({ ...input, lastBuyerAt: NOW - 8 * 86_400_000 }).health, assessRoom({ ...input, lastBuyerAt: NOW - 15 * 86_400_000 }).health], ["on_track", "needs_attention", "at_risk"]);
  const onboarding = assessRoom({ ...input, kind: "onboarding", steps: [{ status: "done", side: "seller", dueOn: "2026-11-21", afterClose: true }, { status: "open", side: "buyer", dueOn: "2026-11-22", afterClose: true }] });
  assert.deepEqual([onboarding.progress, onboarding.planEnd, onboarding.slipDays], [0.5, null, 0]);
});

test("deal reassignment changes the room rep without reassigning the plan's people", async () => {
  const room = healthRoom({ sellerTeam: [{ member: "avery", role: "Account executive" }] });
  const { patch } = await assessment(healthSteps(), { ...D1, ownerId: "sam" }, room);
  assert.deepEqual([patch.data.rep, patch.data.sellerTeam, patch.data.stakeholders], ["sam", undefined, undefined]);
  const selected = await calls.health(system({ keys: ["D1|onboarding"] }), { rooms: [room], steps: healthSteps(), deals: [D1] });
  assert.deepEqual(selected, { byKey: { "D1|onboarding": [] } });
});

const visitorPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const visitorConfig = { privateKeyPem: visitorPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), issuer: "https://canon.test/service", kid: "deal-rooms" };
const visitGraph = loadConvex(["visits.ts", "moduleActivityPublications.ts"], { "lib.ts": (real) => ({ ...real, getCurrentUser: () => { throw new Error("Visitor acquired member authority"); } }) }, {
  process: { env: { ...process.env, MODULE_SHARES: "on", CONVEX_SITE_URL: "https://convex.test", CANON_SERVICE_JWT_ISSUER: visitorConfig.issuer, CANON_SERVICE_JWKS: JSON.stringify({ keys: [{ ...visitorPair.publicKey.export({ format: "jwk" }), kid: visitorConfig.kid }] }) } },
});
const visitHandlers = visitGraph["visits.ts"];

async function buyerRoom(adjust?: (manifest: any) => void) {
  const manifest = JSON.parse(readFileSync("modules/examples/deal-rooms/module.json", "utf8"));
  adjust?.(manifest);
  const publicId = "abcdefghijklmnopqrstuv", roomKey = "D1|close";
  const stored = (key: string, side: string, parentKey = roomKey) => ({ _id: key, orgId: "org", moduleId: manifest.id, collection: "steps", parentKey, gen: 0, key, version: 1, data: { title: key, side, order: 1, status: "open", file: "file", doneByMember: "seller" }, updatedAt: 42 });
  const db = memoryDb({
    organizations: [{ _id: "org", name: "Northwind" }],
    users: [{ _id: "seller", orgId: "org", isActive: true, role: "rep", name: "Avery" }],
    orgMemberships: [{ _id: "membership", userId: "seller", orgId: "org", role: "rep", isActive: true }],
    modulePackages: [{ _id: "pkg", orgId: "org", moduleId: manifest.id, slug: "deal-rooms", version: manifest.version, epoch: 1, status: "installed", manifest: JSON.stringify(manifest), manifestHash: visitHash(JSON.stringify(manifest)) }],
    recipeEnablements: [{ _id: "enabled", orgId: "org", point: "module", contributionKey: "nav", recipeId: manifest.id, enabled: true }],
    moduleDocs: [
      { _id: "root", _creationTime: 42, orgId: "org", moduleId: manifest.id, collection: "rooms", key: roomKey, version: 1, ownerUserId: "seller", data: { title: "Buyer plan", deal: "D1", kind: "close", rep: "seller", status: "live" }, updatedAt: 42 },
      stored("buyer", "buyer"), stored("both", "both"), stored("sellerStep", "seller"), stored("foreign", "buyer", "D2|close"),
    ],
    moduleFiles: [{ _id: "file", orgId: "org", moduleId: manifest.id, storageId: "blob", name: "guide.pdf", type: "application/pdf", bytes: 50 }, { _id: "unticketed", orgId: "org", moduleId: manifest.id, storageId: "other", name: "other.pdf", type: "application/pdf", bytes: 50 }],
    moduleShareGrants: [{ _id: "grant", orgId: "org", moduleId: manifest.id, share: "room", collection: "rooms", key: roomKey, rootCreatedAt: 42, policyHash: await sharePolicyHash(manifest, manifest.shares.room), tokenHash: visitHash("token"), publicId, issuedTo: { name: "Priya" }, identity: "link", expiresAt: Date.now() + 86400000, issuedBy: "seller", issuedAt: Date.now(), opens: 0, sessions: 2 }],
    moduleVisitors: ["first", "second"].map((id) => ({ _id: id, orgId: "org", grantId: "grant", sessionHash: visitHash(id), name: "Priya", verified: false, declared: true, firstAt: 1, lastAt: 1 })),
  });
  const ordinary: Array<{ ref: string; delay: number; args: Record<string, unknown> }> = [], publications: typeof ordinary = [];
  const scheduler = { runAfter: async (delay: number, ref: unknown, args: Record<string, unknown>) => {
    assert.equal(String(ref), "internal.moduleActivityPublications.run", "Visitor cannot schedule semantic work");
    assert.ok(delay >= 0); publications.push({ ref: String(ref), delay, args });
  } };
  const context = () => ({ db: new Proxy(db, { get: (target, key) => { const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value; } }), auth: { getUserIdentity: () => { throw new Error("Visitor used member identity"); } }, scheduler });
  async function transaction<T>(body: (ctx: ReturnType<typeof context>) => Promise<T>) {
    const cp = db.checkpoint(), queues = structuredClone({ ordinary, publications });
    try { return await body(context()); }
    catch (error) { db.rollback(cp); ordinary.splice(0, ordinary.length, ...queues.ordinary); publications.splice(0, publications.length, ...queues.publications); throw error; }
  }
  const publisher = (ref: unknown) => {
    const [visibility, file, name] = String(ref).split(".");
    assert.equal(visibility, "internal"); assert.equal(file, "moduleActivityPublications");
    const handler = visitGraph[`${file}.ts`][name]; assert.ok(handler, `Unknown publisher ${String(ref)}`); return handler;
  };
  const action = { scheduler, runQuery: (ref: unknown, args: Record<string, unknown>) => publisher(ref).handler(context(), args), runMutation: (ref: unknown, args: Record<string, unknown>) => transaction((ctx) => publisher(ref).handler(ctx, args)) };
  // Quiescent publication runs between independent buyer requests; the producer suite exercises pending writes.
  async function settlePublications() {
    const seen = new Set<string>();
    while (publications.some((task) => task.delay === 0)) {
      const position = JSON.stringify([publications, db.rows("moduleActivityHeads"), db.rows("moduleActivityPublications")]);
      assert.ok(seen.size < 100 && !seen.has(position), "Publication must progress"); seen.add(position);
      const [task] = publications.splice(publications.findIndex((item) => item.delay === 0), 1);
      await publisher(task.ref).handler(action, task.args);
    }
    assert.equal(db.rows("moduleActivityPublications").some((row) => row.state === "failed"), false, "Publication failure retains its retry");
    assert.equal(db.rows("moduleActivityHeads").some((row) => row.pending), false, "Publication must finish before the next independent request");
  };
  async function write(input: VisitorWrite, session = "first") {
    const fn: VisitFunction = input.kind === "op" ? "visits:visitOp" : "visits:visitTransition";
    const operation: Record<string, unknown> = { ...input };
    delete operation.kind;
    const args = { ...operation, publicId, sessionHash: visitHash(session) } as VisitArgs;
    const result = await transaction((ctx) => visitHandlers[fn.split(":")[1]].handler(ctx, { ...args, envelope: signVisitEnvelope(visitorConfig, fn, args, { ip: "unknown", ua: "buyer test" }) }));
    await settlePublications(); return JSON.parse(JSON.stringify(result));
  }
  async function raw(fn: VisitFunction, args: VisitArgs) {
    const result = await transaction((ctx) => visitHandlers[fn.split(":")[1]].handler(ctx, { ...args, envelope: signVisitEnvelope(visitorConfig, fn, args, { ip: "unknown", ua: "buyer test" }) }));
    await settlePublications(); return result;
  }
  const ticketCall = async (name: string, args: Record<string, unknown>) => { const result = await transaction((ctx) => visitHandlers[name].handler(ctx, args)); await settlePublications(); return result; };
  return { db, write, raw, ticketCall, publicId, manifest };
}

test("buyer completion and reopening enforce side, CAS and session ownership with signed evidence and no jobs", async () => {
  const { db, write } = await buyerRoom();
  const done = (key: string): Extract<VisitorWrite, { kind: "transition" }> => ({ kind: "transition", machine: "step", transition: "buyerDone", key, expect: 1, args: { note: "Approved" } });
  for (const key of ["sellerStep", "foreign"]) await assert.rejects(write(done(key)));
  await assert.rejects(write({ ...done("buyer"), args: { note: "x".repeat(1001) } }));
  assert.deepEqual(await write(done("buyer")), { ok: true });
  assert.deepEqual(await write(done("both")), { ok: true });
  const completed = (await db.get("buyer"))!.data as Record<string, unknown>;
  assert.equal(completed.status, "done");
  assert.equal(completed.doneBy, "Priya");
  assert.equal(completed.doneByVisitor, "first");
  assert.equal(completed.doneByMember, undefined);
  assert.equal(completed.doneNote, "Approved");
  assert.equal(typeof completed.doneAt, "number");
  const reopen: VisitorWrite = { kind: "transition", machine: "step", transition: "buyerReopen", key: "buyer", expect: 2 };
  await assert.rejects(write(reopen, "second"));
  await assert.rejects(write({ ...reopen, expect: 1 }));
  assert.deepEqual(await write(reopen), { ok: true });
  const reopened = (await db.get("buyer"))!.data as Record<string, unknown>;
  assert.equal(reopened.status, "open");
  for (const field of ["doneAt", "doneBy", "doneByMember", "doneByVisitor", "doneNote"]) assert.equal(reopened[field], undefined, field);
  const event = db.rows("moduleEvents").find((e) => e.verb === "step.buyerDone")!;
  assert.deepEqual(JSON.parse(JSON.stringify(event.evidence)), { ip: "unknown", userAgent: "buyer test" });
  for (const table of ["moduleJobs", "outboundMessages", "observations"]) assert.deepEqual(db.rows(table), []);
});

test("buyer room comments fix attribution and refuse member fields and oversized bodies", async () => {
  const { db, write } = await buyerRoom();
  const post = (data: Record<string, unknown>): VisitorWrite => ({ kind: "op", op: "comments.buyerPost", data });
  for (const data of [{ body: "" }, { body: "x".repeat(2001) }, { body: "Forged", internal: true }, { body: "Forged", authorName: "Avery" }, { body: "Forged", authorMember: "seller" }, { body: "Forged", step: "foreign" }]) await assert.rejects(write(post(data)));
  assert.deepEqual(await write(post({ body: "Ready for review" })), { ok: true });
  const comment = db.rows("moduleDocs").find((d) => d.collection === "comments")!;
  assert.equal(comment.parentKey, "D1|close");
  assert.deepEqual(JSON.parse(JSON.stringify(comment.data)), { body: "Ready for review", internal: false, side: "buyer", authorName: "Priya" });
  assert.deepEqual(db.rows("moduleJobs"), []);
});

test("buyer attachment only changes buyer or joint step files and rejects files without a bound ticket", async () => {
  const { db, write } = await buyerRoom();
  const attach = (key: string, file = "file"): Extract<VisitorWrite, { kind: "op" }> => ({ kind: "op", op: "steps.buyerAttach", key, expect: 1, data: { file } });
  for (const key of ["sellerStep", "foreign"]) await assert.rejects(write(attach(key)));
  await assert.rejects(write(attach("buyer", "unticketed")));
  await assert.rejects(write({ ...attach("buyer"), data: { file: "file", side: "buyer" } }));
  for (const key of ["buyer", "both"]) assert.deepEqual(await write(attach(key)), { ok: true });
  assert.equal((await db.get("sellerStep"))!.version, 1);
  assert.deepEqual(db.rows("moduleJobs"), []);
});

test("closed rooms and revoked links deny every declared buyer write", async () => {
  const { db, write } = await buyerRoom();
  const actions: VisitorWrite[] = [
    { kind: "op", op: "comments.buyerPost", data: { body: "Hello" } },
    { kind: "op", op: "steps.buyerAttach", key: "buyer", expect: 1, data: { file: "file" } },
    { kind: "transition", machine: "step", transition: "buyerDone", key: "buyer", expect: 1 },
    { kind: "transition", machine: "step", transition: "buyerReopen", key: "buyer", expect: 1 },
  ];
  const root = (await db.get("root"))!;
  for (const status of ["draft", "won", "lost", "archived"]) {
    await db.patch("root", { data: { ...(root.data as Record<string, unknown>), status } });
    for (const action of actions) assert.deepEqual(await write(action), { ok: false, status: 403 });
  }
  await db.patch("root", { data: { ...(root.data as Record<string, unknown>), status: "live" } });
  await db.patch("grant", { revokedAt: Date.now() });
  for (const action of actions) assert.deepEqual(await write(action), { ok: false, status: 403 });
  assert.deepEqual(db.rows("moduleEvents"), []);
});


test("buyer step refs reject hidden, foreign, tenant and noncurrent targets through the visitor handler", async () => {
  const h = await buyerRoom((m) => { m.shares.room.read.steps.where = { field: "side", in: ["buyer", "both"] }; });
  const row = (await h.db.get("buyer"))!;
  for (const [key, parentKey, gen, orgId] of [["retired", "D1|close", 1, "org"], ["staged", "D1|close", 2, "org"], ["tenant", "D1|close", 0, "other-org"]] as const) {
    await h.db.insert("moduleDocs", { ...row, _id: key, key, parentKey, gen, orgId });
  }
  const post = (step: string): VisitorWrite => ({ kind: "op", op: "comments.buyerPost", data: { body: "Step reply", step } });
  for (const key of ["sellerStep", "foreign", "retired", "staged", "tenant", "private-key"]) await assert.rejects(h.write(post(key)));
  assert.deepEqual(await h.write(post("buyer")), { ok: true });
  const comment = h.db.rows("moduleDocs").find((d) => d.collection === "comments")!;
  assert.equal((comment.data as Record<string, unknown>).step, "buyer");
  assert.equal(comment.parentKey, "D1|close");
  await assert.rejects(h.write({ kind: "op", op: "comments.buyerPost", data: { body: "Forged", step: "buyer", parentKey: "foreign", gen: 2 } }));
  const policyHash = (await h.db.get("grant"))!.policyHash;
  await h.db.patch("grant", { policyHash: "stale" });
  assert.deepEqual(await h.write(post("buyer")), { ok: false, status: 403 });
  await h.db.patch("grant", { policyHash });
  await h.db.patch("buyer", { parentKey: "foreign" });
  await assert.rejects(h.write(post("buyer")));
});

test("only the current active root rep receives buyer notices, including within a coalescing window", async () => {
  const h = await buyerRoom();
  for (const id of ["next", "otherRep"]) {
    await h.db.insert("users", { _id: id, orgId: "org", isActive: true, role: "rep", name: id });
    await h.db.insert("orgMemberships", { userId: id, orgId: "org", isActive: true, role: "rep" });
  }
  const post = (): Promise<unknown> => h.write({ kind: "op", op: "comments.buyerPost", data: { body: "Hello" } });
  await post();
  assert.deepEqual(h.db.rows("notifications").map((n) => n.userId), ["seller"]);
  const prior = h.db.rows("notifications")[0];
  const root = (await h.db.get("root"))!;
  await h.db.patch("root", { data: { ...(root.data as Record<string, unknown>), rep: "next" } });
  await post();
  assert.deepEqual(h.db.rows("notifications").map((n) => n.userId), ["seller", "next"]);
  assert.equal((await h.db.get(prior._id))!.message, prior.message);
  const notices = JSON.stringify(h.db.rows("notifications"));
  for (const patch of [{ isActive: false }, { isActive: true, isHidden: true }, { isActive: true, isHidden: false, orgId: "other-org" }]) {
    await h.db.patch("next", patch);
    if (patch.orgId) {
      const membership = h.db.rows("orgMemberships").find((r) => r.userId === "next")!;
      await h.db.patch(membership._id, { isActive: false });
    }
    await post();
    assert.equal(JSON.stringify(h.db.rows("notifications")), notices);
  }
  for (const table of ["moduleJobs", "outboundMessages"]) assert.deepEqual(h.db.rows(table), []);
});

test("buyer attachments consume a new ticket bound to that step, CAS, generation and visitor", async () => {
  const h = await buyerRoom();
  const args = { publicId: h.publicId, sessionHash: visitHash("first"), target: { kind: "op", op: "steps.buyerAttach", field: "file", key: "buyer", expect: 1 }, file: { name: "review.pdf", type: "application/pdf", bytes: 12, digest: "a".repeat(64) } } as VisitArgs;
  const reserved = await h.raw("visits:visitUpload", args);
  assert.equal(reserved.ok, true);
  const { ticket, secret } = reserved.value;
  await h.ticketCall("finishUpload", { ticket, secret, storageId: "new-blob" });
  const attach: VisitorWrite = { kind: "op", op: "steps.buyerAttach", key: "buyer", expect: 1, data: { file: ticket } };
  await assert.rejects(h.write(attach, "second"));
  await assert.rejects(h.write({ ...attach, key: "both" }));
  assert.deepEqual(await h.write(attach), { ok: true });
  assert.equal(((await h.db.get(ticket))!.visitorUpload as Record<string, unknown>).state, "attached");
  assert.equal(((await h.db.get("buyer"))!.data as Record<string, unknown>).file, ticket);
  assert.deepEqual(JSON.parse(JSON.stringify((await h.db.get(ticket))!.attachedTo)), { collection: "steps", key: "buyer" });
});
