import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Snapshot } from "../convex/lib/modules/scope.ts";
import { calls, decide, type RecordingPreferences, type RuleEventFacts } from "../modules/examples/notetaker/server.ts";
import type { CallOutput } from "../modules/kernel/calls.ts";
import { parseModuleManifest } from "../modules/kernel/manifest.ts";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const source = readFileSync("modules/examples/notetaker/module.json", "utf8");
const parsed = parseModuleManifest(JSON.parse(source));
if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
const manifest = parsed.manifest;
const members = [
  { _id: "rep1", orgId: "org", role: "rep", name: "Ria", email: "ria@acme.com", isActive: true },
  { _id: "manager", orgId: "org", role: "manager", name: "Mo", email: "mo@acme.com", isActive: true },
  { _id: "admin", orgId: "org", role: "admin", name: "Ada", email: "ada@acme.com", isActive: true },
];
let user = members[0];
let agent: string | null = null;
const fn = loadConvex(["modules.ts"], {
  "lib.ts": (real) => ({ ...real, getCurrentUser: async () => user, requireUser: async () => user, agentClientOf: async () => agent }),
})["modules.ts"];
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
type Prepared = { name: string; snapshot: Snapshot; output: CallOutput };
const externalPrefs: RecordingPreferences = { mode: "external", includeDomains: [], excludeDomains: [], skipKeywords: [] };
const visiblePolicy = { internalRecording: false, internalDomains: ["acme.com"] };
const atlas: RuleEventFacts = { title: "Atlas discovery", cancelled: false, declined: false, hasVideoLink: true, hosted: false, attendeeDomains: ["atlas.io"] };

function harness() {
  user = members[0]; agent = null;
  const db = memoryDb({
    organizations: [{ _id: "org", name: "Acme", domain: "acme.com" }],
    users: members,
    modulePackages: [{
      _id: "pkg", orgId: "org", moduleId: manifest.id, slug: "notetaker", status: "installed", epoch: 1,
      source: { kind: "canon", name: "notetaker", sha: "a".repeat(64) }, version: manifest.version,
      manifest: source, manifestHash: "a".repeat(64), bundleHash: "b".repeat(64), bundleStorageId: "bundle",
      installedBy: "admin", installedAt: 1,
    }],
    recipeEnablements: [{ _id: "on", orgId: "org", point: "module", recipeId: manifest.id, contributionKey: "nav", enabled: true, at: 1 }],
  });
  const invoke = async (name: string, args: Record<string, unknown>) => {
    const checkpoint = db.checkpoint();
    try { return await fn[name].handler({ db, scheduler: { runAfter: async () => {} } }, { module: manifest.id, ...args }); }
    catch (error) { db.rollback(checkpoint); throw error; }
  };
  const prepare = async (name: string, args: Record<string, unknown> = {}): Promise<Prepared> => {
    const snapshot: Snapshot = await invoke("callPlan", { call: name, args });
    const output = await calls[name]({ now: 1, caller: snapshot.caller, workspace: snapshot.workspace, args }, snapshot.reads);
    return { name, snapshot, output };
  };
  const apply = (prepared: Prepared) => invoke("applyCall", { call: prepared.name, epoch: prepared.snapshot.epoch, intents: prepared.output.intents ?? [] });
  const run = async (name: string, args: Record<string, unknown> = {}) => {
    const prepared = await prepare(name, args);
    if (prepared.output.intents?.length) await apply(prepared);
    return plain(prepared.output.value);
  };
  return {
    db, invoke, prepare, apply, run,
    as(id: string, client: string | null = null) { user = members.find((member) => member._id === id)!; agent = client; },
  };
}

test("personal rules read OFF defaults and the core workspace policy without creating preferences", async () => {
  const h = harness();
  const page = await h.invoke("page", { path: ["rules"] });
  assert.deepEqual(plain([page.module.nav, page.loads]), [
    { label: "Notetaker", icon: "clipboard", section: "Activity", href: "/dashboard/m/notetaker/rules" },
    { prefs: { call: "preferences", args: {} } },
  ]);
  assert.deepEqual(await h.run("preferences"), {
    mode: "off", includeDomains: [], excludeDomains: [], skipKeywords: [],
    policy: { id: "org", createdAt: 0, consent: "notice", internalRecording: false, internalDomains: ["acme.com"], retentionDays: 365, region: "us" },
  });
  assert.equal(h.db.rows("moduleDocs").length, 0);
});

test("each member saves and reloads only their own preferences, including admins and managers", async () => {
  const h = harness();
  await h.run("savePreferences", { mode: "external", includeDomains: ["customer.com"], excludeDomains: ["lawfirm.com"], skipKeywords: ["private"], botName: "Acme notes" });
  const edit = await h.invoke("page", { path: ["rules", "edit"] });
  assert.deepEqual(plain(edit.loads), { prefs: { call: "preferences", args: {} } });
  assert.deepEqual(await h.run("preferences"), {
    user: "rep1", mode: "external", includeDomains: ["customer.com"], excludeDomains: ["lawfirm.com"], skipKeywords: ["private"], botName: "Acme notes",
    policy: { id: "org", createdAt: 0, consent: "notice", internalRecording: false, internalDomains: ["acme.com"], retentionDays: 365, region: "us" },
  });
  await h.run("savePreferences", { mode: "manual", includeDomains: [], excludeDomains: [], skipKeywords: [], botName: "" });
  for (const id of ["manager", "admin"]) {
    h.as(id);
    await assert.rejects(h.prepare("savePreferences", { user: "rep1", mode: "all", includeDomains: [], excludeDomains: [], skipKeywords: [] }));
    await h.run("savePreferences", { mode: "off", includeDomains: [], excludeDomains: [], skipKeywords: [] });
    assert.equal((await h.invoke("view", { view: "prefs.mine", args: {} })).key, id);
  }
  assert.deepEqual(plain(h.db.rows("moduleDocs").map((row) => [row.collection, row.key, row.ownerUserId, row.data])), [
    ["prefs", "rep1", "rep1", { user: "rep1", mode: "manual", includeDomains: [], excludeDomains: [], skipKeywords: [] }],
    ["prefs", "manager", "manager", { user: "manager", mode: "off", includeDomains: [], excludeDomains: [], skipKeywords: [] }],
    ["prefs", "admin", "admin", { user: "admin", mode: "off", includeDomains: [], excludeDomains: [], skipKeywords: [] }],
  ]);
});

test("competing first saves cannot duplicate a row and stale updates cannot overwrite a newer save", async () => {
  const h = harness();
  const args = { mode: "off", includeDomains: [], excludeDomains: [], skipKeywords: [] };
  const first = await h.prepare("savePreferences", args);
  const duplicate = await h.prepare("savePreferences", { ...args, mode: "all" });
  await h.apply(first);
  await assert.rejects(h.apply(duplicate));
  const stale = await h.prepare("savePreferences", { ...args, mode: "external" });
  await h.run("savePreferences", { ...args, mode: "hosted" });
  await assert.rejects(h.apply(stale));
  assert.deepEqual(plain(h.db.rows("moduleDocs").map((row) => [row.key, row.version, row.data])), [
    ["rep1", 2, { user: "rep1", mode: "hosted", includeDomains: [], excludeDomains: [], skipKeywords: [] }],
  ]);
});

test("agents can read preferences but cannot configure them at planning or application", async () => {
  const h = harness();
  const args = { mode: "manual", includeDomains: [], excludeDomains: [], skipKeywords: [] };
  await h.run("savePreferences", args);
  const prepared = await h.prepare("savePreferences", { ...args, mode: "all" });
  h.as("rep1", "agent-client");
  assert.equal((await h.run("preferences")).mode, "manual");
  await assert.rejects(h.prepare("savePreferences", { ...args, mode: "all" }));
  await assert.rejects(h.apply(prepared));
  await assert.rejects(h.invoke("op", { op: "prefs.update", key: "rep1", data: { mode: "all" } }));
  assert.deepEqual(plain(h.db.rows("moduleDocs").map((row) => [row.key, row.version, row.data])), [
    ["rep1", 1, { user: "rep1", mode: "manual", includeDomains: [], excludeDomains: [], skipKeywords: [] }],
  ]);
});

test("section 12 rule goldens cover E1, E2, E4, E5, E6, E7 and E9 without action-time claims", () => {
  const cases: Array<[string, RuleEventFacts, RecordingPreferences, { decision: string; reason: string }]> = [
    ["E1", atlas, externalPrefs, { decision: "record", reason: "external meeting" }],
    ["E2", { ...atlas, title: "Weekly 1:1", attendeeDomains: ["acme.com"] }, externalPrefs, { decision: "skip", reason: "internal meeting" }],
    ["E4", { ...atlas, title: "Borealis demo", hosted: true, attendeeDomains: ["borealis.com"] }, { ...externalPrefs, mode: "hosted" }, { decision: "record", reason: "you host it" }],
    ["E5", { ...atlas, title: "Borealis sync", attendeeDomains: ["borealis.com"] }, { ...externalPrefs, mode: "hosted" }, { decision: "skip", reason: "you don't host it" }],
    ["E6", { ...atlas, title: "Coffee", attendeeDomains: ["cobalt.dev"], hasVideoLink: false }, externalPrefs, { decision: "skip", reason: "no video link" }],
    ["E7", { ...atlas, title: "Cobalt pricing", attendeeDomains: ["cobalt.dev"], declined: true }, externalPrefs, { decision: "skip", reason: "you declined" }],
    ["E9", { ...atlas, title: "Delta intro", attendeeDomains: ["delta.io"] }, { ...externalPrefs, mode: "manual" }, { decision: "skip", reason: "manual" }],
  ];
  for (const [id, event, prefs, expected] of cases) assert.deepEqual(decide(event, prefs, visiblePolicy), expected, id);
});

test("E10 changes from record to cancel even when cancellation removes other event facts", () => {
  const event = { ...atlas, title: "Borealis follow-up", hosted: true, attendeeDomains: ["borealis.com"] };
  const prefs: RecordingPreferences = { ...externalPrefs, mode: "hosted" };
  assert.deepEqual(decide(event, prefs, visiblePolicy), { decision: "record", reason: "you host it" });
  assert.deepEqual(decide({ ...event, title: "", cancelled: true, declined: true, hasVideoLink: false, hosted: false, attendeeDomains: [] }, prefs, visiblePolicy), {
    decision: "cancel", reason: "meeting cancelled",
  });
});

test("the visible internal-off floor cannot be overridden, including unknown attendee domains", () => {
  const policy = { internalRecording: false, internalDomains: [" ACME.COM ", ""] };
  for (const [domains, reason] of [
    [[" acme.com "], "internal meeting"],
    [[], "unknown attendee domains"],
    [["atlas.io", " "], "unknown attendee domains"],
  ] as const) {
    assert.deepEqual(decide({ ...atlas, attendeeDomains: domains, override: "record" }, externalPrefs, policy), { decision: "skip", reason });
  }
  assert.deepEqual(decide({ ...atlas, attendeeDomains: ["acme.com"] }, externalPrefs, { ...policy, internalRecording: true }), {
    decision: "skip", reason: "no external attendees",
  });
});

test("explicit choices override preference rules but not declined or missing-link prerequisites", () => {
  const restrictive: RecordingPreferences = { mode: "off", includeDomains: ["other.com"], excludeDomains: ["atlas.io"], skipKeywords: ["discovery"] };
  assert.deepEqual(decide({ ...atlas, override: "record" }, restrictive, visiblePolicy), { decision: "record", reason: "you chose to record" });
  assert.deepEqual(decide({ ...atlas, override: "skip" }, externalPrefs, visiblePolicy), { decision: "skip", reason: "you chose to skip" });
  assert.deepEqual(decide({ ...atlas, declined: true, override: "record" }, externalPrefs, visiblePolicy), { decision: "skip", reason: "you declined" });
  assert.deepEqual(decide({ ...atlas, hasVideoLink: false, override: "record" }, externalPrefs, visiblePolicy), { decision: "skip", reason: "no video link" });
});

test("domain restrictions use trimmed lowercase exact matches and keywords ignore case and empty entries", () => {
  const cases: Array<[RuleEventFacts, RecordingPreferences, { decision: string; reason: string }]> = [
    [{ ...atlas, attendeeDomains: [" ATLAS.IO "] }, { ...externalPrefs, includeDomains: [" atlas.io ", ""] }, { decision: "record", reason: "external meeting" }],
    [{ ...atlas, attendeeDomains: ["sub.atlas.io"] }, { ...externalPrefs, includeDomains: ["atlas.io"] }, { decision: "skip", reason: "no included domain" }],
    [atlas, { ...externalPrefs, excludeDomains: [" ATLAS.IO ", ""] }, { decision: "skip", reason: "excluded domain" }],
    [{ ...atlas, attendeeDomains: ["sub.atlas.io"] }, { ...externalPrefs, excludeDomains: ["atlas.io"] }, { decision: "record", reason: "external meeting" }],
    [{ ...atlas, title: "Atlas PRIVATE discussion" }, { ...externalPrefs, skipKeywords: [" Private ", ""] }, { decision: "skip", reason: "excluded title keyword" }],
    [atlas, { ...externalPrefs, includeDomains: [" "], excludeDomains: [""], skipKeywords: [" "] }, { decision: "record", reason: "external meeting" }],
  ];
  for (const [event, prefs, expected] of cases) assert.deepEqual(decide(event, prefs, visiblePolicy), expected);
});

test("preview reads the caller's own preferences for every role and remains read-only for agents", async () => {
  const h = harness();
  assert.deepEqual(await h.run("previewDecision", atlas), { decision: "skip", reason: "manual", advisoryOnly: true });
  assert.equal(h.db.rows("moduleDocs").length, 0);
  const people = [
    ["rep1", "all", "record", "all meetings"],
    ["manager", "manual", "skip", "manual"],
    ["admin", "hosted", "skip", "you don't host it"],
  ] as const;
  for (const [id, mode] of people) {
    h.as(id);
    await h.run("savePreferences", { ...externalPrefs, mode });
  }
  const before = plain(h.db.rows("moduleDocs"));
  for (const [id, , decision, reason] of people) {
    h.as(id, "agent-client");
    const prepared = await h.prepare("previewDecision", atlas);
    assert.equal((prepared.snapshot.reads.current as { key: string }).key, id);
    assert.deepEqual(prepared.output, { value: { decision, reason, advisoryOnly: true } });
    await h.apply(prepared);
  }
  assert.deepEqual(plain(h.db.rows("moduleDocs")), before);
  await assert.rejects(h.invoke("applyCall", {
    call: "previewDecision", epoch: 1,
    intents: [{ op: "put", collection: "meetings", key: "invented", data: {} }],
  }));
  assert.deepEqual(plain(h.db.rows("moduleDocs")), before);
});

test("preview uses the actual policy read and strictly rejects caller authority and non-rule arguments", async () => {
  const h = harness();
  await h.run("savePreferences", { ...externalPrefs, mode: "all" });
  const event = { ...atlas, attendeeDomains: [" ACME.COM "], override: "record" };
  assert.deepEqual(await h.run("previewDecision", event), { decision: "skip", reason: "internal meeting", advisoryOnly: true });
  await h.db.insert("recordingPolicy", { orgId: "org", internalRecording: true, internalDomains: ["acme.com"] });
  assert.deepEqual(await h.run("previewDecision", event), { decision: "record", reason: "you chose to record", advisoryOnly: true });
  for (const extra of [
    { user: "manager" }, { org: "other" }, { prefs: externalPrefs },
    { policy: { internalRecording: true, internalDomains: [] } }, { meetingURL: "https://example.com" },
  ]) await assert.rejects(h.prepare("previewDecision", { ...atlas, ...extra }));
  await assert.rejects(h.prepare("previewDecision", { ...atlas, hasVideoLink: "yes" }));
  const missingTitle: Record<string, unknown> = { ...atlas };
  delete missingTitle.title;
  await assert.rejects(h.prepare("previewDecision", missingTitle));
});
