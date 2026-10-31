import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { accessOf } from "../convex/lib/access.ts";
import { DEFAULT_DEAL_TERMS } from "../recipes/terms.ts";
import { stateForReader, type DealState } from "../convex/lib/plays/state.ts";
import type { ModuleScope } from "../convex/lib/modules/scope.ts";
import { aiProblems, choiceValues, fakeAnswer, gateAnswer, outputSchema } from "../modules/kernel/ai.ts";
import type { CallContext, ReadDoc } from "../modules/kernel/calls.ts";
import { parseModuleManifest } from "../modules/kernel/manifest.ts";
import { readRecord, type RecordReadPorts, type RecordReadSpec } from "../convex/lib/modules/recordReads.ts";
import type { RecordClient } from "../convex/lib/recordClient.ts";
import { calls } from "../modules/examples/work/server.ts";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const raw = readFileSync("modules/examples/work/module.json", "utf8");
const parsed = parseModuleManifest(JSON.parse(raw));
assert.ok(parsed.ok, parsed.ok ? undefined : parsed.errors.join("\n"));
const manifest = parsed.manifest;
const ORG = "organizations:o", REP = "users:rep";
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const citation = (kind: "email" | "linkedin" | "call", ownerUserId?: string) => ({ kind, id: kind, quote: "Buyer approved the renewal budget.", support: "buyer" as const, ...(ownerUserId ? { ownerUserId } : {}) });
const state: DealState = {
  summary: "Renewal under discussion.", stage: { label: "Evaluation", reason: "Buyer is evaluating.", crmStage: "Evaluation", mismatch: false }, framework: "Test",
  qualification: [{ key: "budget", group: "Budget", label: "Budget", status: "established", text: "Approved.", sources: [citation("email"), citation("linkedin"), citation("email", REP), citation("call")] }],
  concerns: [], completeness: { established: 1, total: 1 }, coverage: { read: 1, total: 1, omitted: 0, partial: false, inventoryLimited: false }, generatedAt: 10,
};
const loaded = loadConvex(["lib/modules/canonReads.ts", "lib/modules/scope.ts", "moduleActivityContent.ts", "dealState.ts", "dealGaps.ts"]);
const canon = loaded["lib/modules/canonReads.ts"] as unknown as { canonRead: (...args: unknown[]) => Promise<Array<Record<string, unknown>>>; planRecordRead: (...args: unknown[]) => Promise<RecordReadSpec> };
const scopes = loaded["lib/modules/scope.ts"] as unknown as {
  personScope: (...args: unknown[]) => Promise<ModuleScope | null>;
  systemScope: (...args: unknown[]) => Promise<ModuleScope | null>;
};

test("deals.state withholds restricted states and preserves DS1 inbox quote redaction and deal admission", async () => {
  const db = memoryDb({
    deals: [{ _id: "deals:d", orgId: ORG, createdAt: 1 }, { _id: "deals:foreign", orgId: "organizations:other" }, { _id: "deals:archived", orgId: ORG, archivedAt: 2 }],
    canonEntities: [{ _id: "canonEntities:d", orgId: ORG, projectionId: "deals:d", projectionTable: "deals" }],
    dealPlays: [{ _id: "dealPlays:d", orgId: ORG, streamId: "canonEntities:d", state }],
  });
  const read = (access: ReturnType<typeof accessOf>, ids = ["deals:d"], limit = 10) => canon.canonRead({ db }, ORG, access, manifest, "deals.state", { ids }, limit).then(plain);
  const full = accessOf({ userId: REP, role: "rep" });
  assert.deepEqual(await read(full, ["deals:d", "deals:d", "deals:foreign", "deals:archived", "missing"]), [{ id: "deals:d", createdAt: 1, ...stateForReader(state, { restricted: false, mayRead: () => true }), terms: DEFAULT_DEAL_TERMS }]);
  const [row] = await read(full);
  await db.patch("dealPlays:d", { state: undefined });
  assert.deepEqual((await read(full))[0].terms, DEFAULT_DEAL_TERMS);
  await db.patch("dealPlays:d", { state });
  assert.deepEqual((row.state as DealState).qualification[0].sources.map((s) => s.quote), ["", "", "Buyer approved the renewal budget.", "Buyer approved the renewal budget."]);
  for (const rules of [[{ object: "deal", read: false }], [{ object: "deal", visibility: "own" as const }], [{ object: "note", fields: [{ apiName: "body", level: "hidden" as const }] }]]) {
    assert.deepEqual(await read(accessOf({ userId: REP, role: "rep", rules })), []);
  }
  assert.deepEqual(await read({ ...full, preview: { adminId: "admin", asUserId: REP, asName: "Rep" } }), []);
  await assert.rejects(read(full, ["deals:d"], 0));
  assert.equal(state.qualification[0].sources[0].quote, "Buyer approved the renewal budget.");
});

test("deal conversation reads match DS1 and withhold text while preserving message metadata", async () => {
  const owner = "users:owner";
  const threads = [
    { _id: "conversations:contact", contactIds: ["contact:c"], channel: "linkedin", subject: "Discussion", at: 10 },
    { _id: "conversations:domain", contactIds: [], channel: "email", subject: "Budget", at: 20 },
    { _id: "conversations:name", contactIds: [], channel: "email", subject: "Mars Petcare renewal", at: 30 },
    { _id: "conversations:other", contactIds: [], channel: "email", subject: "Unrelated", at: 40 },
  ];
  const db = memoryDb({
    users: [{ _id: REP, orgId: ORG, role: "rep", isActive: true, email: "rep@canon.test" }, { _id: owner, orgId: ORG, role: "manager", isActive: true, email: "owner@canon.test" }],
    deals: [{ _id: "deals:d", orgId: ORG, name: "Mars Petcare renewal", primaryRepId: owner, companyId: "company:mars", createdAt: 1 }],
    canonEntities: [{ _id: "canonEntities:d", orgId: ORG, projectionId: "deals:d", projectionTable: "deals" }],
    dealContacts: [{ _id: "dealContacts:c", dealId: "deals:d", contactId: "contact:c", slot: "Involved" }],
    emailAccounts: [{ _id: "emailAccounts:o", orgId: ORG, userId: owner }],
    linkedinAccounts: [{ _id: "linkedinAccounts:o", orgId: ORG, userId: owner }],
    conversations: threads.map((t) => ({ ...t, orgId: ORG, ownerUserId: owner, createdAt: t.at, lastMessageAt: t.at, updatedAt: t.at, accountRef: t.channel === "email" ? "emailAccounts:o" : "linkedinAccounts:o", counterpart: { email: t._id.endsWith("domain") ? "buyer@mars.test" : "buyer@elsewhere.test", name: "Buyer" } })),
    conversationMessages: threads.map((t) => ({ _id: `conversationMessages:${t.at}`, conversationId: t._id, orgId: ORG, externalMessageId: String(t.at), direction: "in", at: t.at, from: t.at === 30 ? "owner@canon.test" : "buyer@mars.test", text: "Buyer approved the renewal budget." })),
    rolePermissions: [{ _id: "rolePermissions:r", orgId: ORG, role: "rep", rules: [{ object: "note", visibility: "own", unowned: false }] }],
  });
  const context = { db, runQuery: async (_ref: unknown, args: unknown) => loaded["dealGaps.ts"].sourceInventory.handler({ db }, args) };
  const read = async () => {
    const spec = await canon.planRecordRead({ db }, ORG, accessOf({ userId: REP, role: "rep" }), manifest, "deals.conversations", { ids: ["deals:d"] }, 50);
    const client = { listRegister: async () => ({ rows: [{ id: "company:mars", values: { domain: "mars.test" } }], nextCursor: null }) } as unknown as RecordClient;
    const ports = { conversationsOf: (dealIds, domains, fields, limit) => loaded["moduleActivityContent.ts"].dealConversations.handler(context, { orgId: ORG, userId: REP, dealIds, domains, fields, limit }) } as RecordReadPorts;
    return plain(await readRecord(client, ORG, ports, spec));
  };
  const hidden = await read();
  assert.deepEqual(hidden.map((r) => [r.id, r.channel, r.subject, r.messages]), [
    ["deals:d:conversations:name", "email", null, [{ id: "conversationMessages:30", direction: "in", at: 30, from: "owner@canon.test", hidden: true, ownerUserId: owner, buyer: false }]],
    ["deals:d:conversations:domain", "email", null, [{ id: "conversationMessages:20", direction: "in", at: 20, from: "buyer@mars.test", hidden: true, ownerUserId: owner, buyer: true }]],
    ["deals:d:conversations:contact", "linkedin", null, [{ id: "conversationMessages:10", direction: "in", at: 10, from: "buyer@mars.test", hidden: true, ownerUserId: owner, buyer: true }]],
  ]);
  assert.ok(!JSON.stringify(hidden).includes("Buyer approved"));
  await db.patch("rolePermissions:r", { rules: [] });
  const visible = await read();
  assert.deepEqual(visible.map((r) => (r.messages as Array<{ text: string }>)[0].text), Array(3).fill("Buyer approved the renewal budget."));
  const ds1 = await loaded["dealState.ts"].inputs.handler(context, { orgId: ORG, userId: REP, streamId: "canonEntities:d", contactIds: ["contact:c"], companyDomain: "mars.test" });
  assert.deepEqual(visible.map((r) => String(r.id).replace("deals:d:", "")), plain(ds1.sources.filter((s: { kind: string }) => ["email", "linkedin"].includes(s.kind)).map((s: { id: string }) => s.id)));
});

test("Work's hosted steps validate, use retained evidence and drop invented quotes", () => {
  assert.equal(manifest.version, "0.6.0");
  const draft = manifest.calls!.draftGoal;
  assert.deepEqual(aiProblems(manifest, "draftGoal", { ...draft, ai: draft.ai! }), []);
  assert.equal(draft.ai!.credits, false);
  assert.equal(manifest.default, true);
  assert.equal(manifest.contributes?.dealPage?.panels?.length, 1);
  for (const change of [{ retainedEvidence: { deal: "goal" } }, { report: { dimensions: ["status"] } }]) {
    const invalid = JSON.parse(raw);
    Object.assign(invalid.collections.nextBestActions, change);
    assert.equal(parseModuleManifest(invalid).ok, false);
  }
  for (const name of ["buildTimeline", "buildBrief", "buildDecision"]) {
    const call = manifest.calls![name], ai = call.ai!;
    assert.deepEqual(aiProblems(manifest, name, { ...call, ai }), []);
    assert.equal(ai.credits, false);
    const reads = { run: { key: "run", data: { goal: "Renew flat", repRead: "Budget approved" }, version: 1, owner: REP, parentKey: null, createdAt: 1, updatedAt: 1 }, acts: [{ id: "note", text: "The buyer approved the renewal budget." }] };
    const schema = outputSchema(manifest, ai)!;
    const choices = choiceValues(ai, reads);
    const answer = fakeAnswer(ai, schema, reads, choices);
    const checked = gateAnswer(ai, schema, answer, reads, choices);
    assert.ok(checked.kept > 0);
    assert.equal(checked.dropped.length, 0);
    const field = ai.evidence![0].quote.split("[]")[0];
    const invented = gateAnswer(ai, schema, { ...answer, [field]: [{ source: "note", quote: "They signed a three year contract yesterday." }] }, reads, choices);
    assert.deepEqual(invented.data[field], []);
  }
});

test("a coaching run retains dated sources, progresses only after answers and remains auditable", async () => {
  const ctx: CallContext = { now: 100, caller: { userId: REP, role: "rep" }, args: { deal: "deals:d" } };
  const result = await calls.startRun(ctx, { deal: [{ id: "deals:d" }], eligibility: [{ id: "deals:d" }], acts: [{ id: "note", at: 42, subject: "Budget meeting", text: "The buyer approved the renewal budget." }], conversations: [{ channel: "email", subject: "Renewal budget", messages: [{ id: "email-message", at: 43, from: "buyer@mars.test", direction: "in", buyer: true, text: "Finance approved our budget." }, { id: "hidden-message", at: 44, hidden: true }] }] });
  assert.throws(() => calls.startRun(ctx, { deal: [{ id: "deals:d" }], eligibility: [], acts: [] }));
  const key = (result.value as { key: string }).key;
  const db = memoryDb({
    organizations: [{ _id: ORG }], users: [{ _id: REP, orgId: ORG, role: "rep", isActive: true, name: "Rep" }, { _id: "users:manager", orgId: ORG, role: "manager", isActive: true }],
    deals: [{ _id: "deals:d", orgId: ORG, name: "Renewal", primaryRepId: REP }],
    modulePackages: [{ _id: "modulePackages:w", orgId: ORG, moduleId: manifest.id, slug: "work", version: manifest.version, manifest: raw, manifestHash: "test", bundleHash: "test", bundleStorageId: "storage:work", status: "installed" }],
    recipeEnablements: [{ _id: "recipeEnablements:w", orgId: ORG, point: "module", recipeId: manifest.id, contributionKey: "nav", enabled: true }],
  });
  const context = { db, scheduler: { runAfter: async () => null } };
  const person = async (id = REP) => (await scopes.personScope(context, ORG, id, "work"))!;
  const system = async () => (await scopes.systemScope(context, ORG, "work"))!;
  const intents = result.intents!.map((intent) => { assert.ok(intent.op === "put" || intent.op === "transition"); return intent; });
  assert.deepEqual(intents.map((intent) => intent.op), ["put", "transition"]);
  await (await person()).apply("startRun", intents);
  const run = async () => await (await person()).view("runs.one", { key }) as ReadDoc;
  const move = async (name: string, sys = false) => (await (sys ? system() : person())).transition("nextBestAction", name, { key, expect: (await run()).version });
  assert.equal((await run()).data.status, "draftingGoal");
  // A failed draft leaves an empty goal the rep must fill before the timeline.
  await move("goalDraftFailed", true);
  await assert.rejects(move("buildTimeline"));
  await move("draftGoal");
  const fill = async (name: string) => {
    const call = manifest.calls![name], ai = call.ai!, schema = outputSchema(manifest, ai)!;
    const doc = await run(), reads = { run: doc, acts: doc.data.evidenceSources as Array<Record<string, unknown>> };
    const choices = choiceValues(ai, reads);
    const answer = fakeAnswer(ai, schema, reads, choices);
    if (name === "buildBrief") answer.questions = { q1: "Who signs?", q2: "Is the champion available?", q3: "What remains in procurement?" };
    const gated = gateAnswer(ai, schema, answer, reads, choices);
    const incomplete = { ...gated.data };
    delete incomplete[{ draftGoal: "goal", buildTimeline: "timeline", buildBrief: "brief" }[name] ?? "decision"];
    await assert.rejects((await person()).apply(name, [{ op: "op", name: ai.output.op, key, data: incomplete }]));
    await assert.rejects((await person("users:manager")).apply(name, [{ op: "op", name: ai.output.op, key, data: gated.data }]));
    await (await person()).apply(name, [{ op: "op", name: ai.output.op, key, data: gated.data }]);
  };
  await fill("draftGoal"); await move("goalDrafted", true);
  assert.equal((await run()).data.status, "goal");
  await (await person()).op("runs.editGoal", { key, expect: (await run()).version, data: { goal: "Renew flat by November 13", repRead: "Buyer approved budget" } });
  await move("buildTimeline");
  await fill("buildTimeline"); await move("timelineReady", true);
  const rows = await calls.timelineRows(ctx, { run: await run() });
  assert.deepEqual((rows.value as { timeline: unknown[] }).timeline, [{ source: "note", quote: "The buyer approved the renewal budget.", at: 42, date: 42, subject: "Budget meeting" }, { source: "email-message", quote: "Finance approved our budget.", at: 43, date: 43, subject: "Email: Renewal budget" }]);
  await move("confirmTimeline"); await fill("buildBrief"); await move("briefReady", true); await move("readBrief");
  await assert.rejects(move("decide"));
  await (await person()).op("runs.answer", { key, expect: (await run()).version, data: { answers: { a1: "Confirmed by finance", a2: "Champion is available", a3: "Procurement owns signature" } } });
  await move("decide"); await fill("buildDecision"); await move("decisionReady", true);
  assert.equal((await run()).data.status, "decision");
  await assert.rejects((await person()).op("runs.answer", { key, expect: (await run()).version, data: { answers: { a1: "Rewrite history" } } }));
  assert.ok(await (await person("users:manager")).view("runs.one", { key }));
  const events = await (await person()).events("nextBestActions", key);
  assert.ok(events && events.length >= 10);
  await db.patch("deals:d", { archivedAt: 100 });
  assert.equal(await (await person()).view("runs.one", { key }), null);
  assert.equal(await (await person("users:manager")).view("runs.one", { key }), null);
  await db.patch("deals:d", { archivedAt: undefined });
  await db.insert("rolePermissions", { orgId: ORG, role: "rep", rules: [{ object: "deal", visibility: "own", unowned: false }] });
  await db.patch("deals:d", { primaryRepId: "users:manager" });
  const revoked = await person();
  const surfaces = {
    one: () => revoked.view("runs.one", { key }),
    dealList: () => revoked.view("runs.forDeal", { deal: "deals:d" }),
    inbox: () => revoked.view("runs.all", {}),
    peek: () => revoked.peek("nextBestActions", key),
    history: () => revoked.events("nextBestActions", key),
    picker: () => revoked.pick({ type: "ref", to: "doc", collection: "nextBestActions" }, "", 10),
    labels: () => revoked.refLabels([{ ref: { type: "ref", to: "doc", collection: "nextBestActions" }, id: key }]),
    export: () => revoked.exportRows("runs.all", {}, 100),
  };
  for (const [surface, read] of Object.entries(surfaces)) {
    const value = plain(await read());
    assert.ok(value === null || JSON.stringify(value) === "[]" || JSON.stringify(value) === "{}", surface);
  }
  assert.equal((await revoked.snapshot("timelineRows", { run: key })).reads.run, null);
  await assert.rejects(revoked.snapshot("buildDecision", { run: key }));
});
