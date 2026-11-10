import assert from "node:assert/strict";
import test from "node:test";
import { AUTO_ACCEPT, resolveAttribute, sameValue, type FactLike, type SourceKind } from "../convex/lib/canon/policy.ts";
import {
  factIdOf,
  fold,
  foldAll,
  GapError,
  MAX_PENDING_PER_FIELD,
  project,
  StreamMismatchError,
  writeRule,
  type Assertion,
  type EntryBody,
  type Fact,
  type FoldState,
  type LedgerEntry,
} from "../convex/lib/objects/fold.ts";
import { resolveObjectDef, STANDARD_OBJECTS, type FieldDef, type FieldId, type FieldValue } from "../convex/lib/objects/registry.ts";

const DAY = 86_400_000;
const account = resolveObjectDef(STANDARD_OBJECTS.account, {
  registryVersion: 1,
  customFields: [
    { fieldId: "f_regions" as FieldId, apiName: "custom.regions", label: "Regions", type: "multipicklist", options: ["NA", "EMEA", "APAC"].map((value) => ({ value, label: value, active: true })) },
    { fieldId: "f_partner" as FieldId, apiName: "custom.is_partner", label: "Partner", type: "checkbox" },
  ],
});
const id = (apiName: string): FieldId => {
  const field = account.byApiName.get(apiName);
  assert.ok(field, apiName);
  return field.fieldId;
};

function entry(version: number, observedAt: number, kind: SourceKind, body: EntryBody, streamId = "acc_1"): LedgerEntry {
  return { streamId, version, observedAt, source: { kind, ref: `${kind}:${streamId}` }, actor: { kind: kind === "user" ? "user" : "integration", id: kind }, body };
}
const assert1 = (version: number, observedAt: number, kind: SourceKind, values: Record<string, FieldValue>, extra: Partial<Assertion> = {}) =>
  entry(version, observedAt, kind, {
    kind: "assert",
    status: AUTO_ACCEPT.has(kind) ? "accepted" : "proposed",
    assertions: Object.entries(values).map(([apiName, value]) => ({ fieldId: id(apiName), value, ...extra })),
  });
const rowOf = (entries: LedgerEntry[]) => {
  const state = foldAll(entries);
  assert.ok(state);
  return project(account, state);
};

test("equal-time tie: the later write wins (Salesforce t1, HubSpot t2, Salesforce t2 resolves to Salesforce)", () => {
  const row = rowOf([
    assert1(1, 1, "salesforce", { industry: "Software" }),
    assert1(2, 2, "hubspot", { industry: "SaaS" }),
    assert1(3, 2, "salesforce", { industry: "Fintech" }),
  ]);
  assert.equal(row.values.industry, "Fintech");
  assert.deepEqual(row.meta.industry, { state: "contested", factId: "acc_1@3#0", sourceKind: "salesforce" });
});

test("two saves of one field in the same millisecond keep the second value", () => {
  const row = rowOf([
    assert1(1, 5, "user", { industry: "Software" }),
    assert1(2, 5, "user", { industry: "Fintech" }),
  ]);
  assert.equal(row.values.industry, "Fintech");
});

test("project reads the newest user value, empties, and the row timestamps", () => {
  const row = rowOf([
    entry(1, 10, "user", { kind: "lifecycle", op: "create" }),
    assert1(2, 10, "salesforce", { name: "Acme", employees: 120 }),
    assert1(3, 20, "user", { employees: 150 }),
    entry(4, 30, "salesforce", { kind: "confirm", fieldIds: [id("name")] }),
  ]);
  assert.equal(row.values.name, "Acme");
  assert.equal(row.values.employees, 150);
  assert.deepEqual(row.meta.employees, { state: "resolved", factId: "acc_1@3#0", sourceKind: "user" });
  assert.equal(row.values.domain, null);
  assert.deepEqual(row.meta.domain, { state: "empty", factId: null, sourceKind: null });
  assert.equal("createdAt" in row.values, false, "system fields are the row's own timestamps");
  assert.deepEqual([row.createdAt, row.updatedAt, row.deletedAt, row.mergedInto], [10, 20, null, null], "a confirm changes nothing the user sees");
});

test("a proposal stays out of the row until a decide entry accepts it", () => {
  const proposed = assert1(1, 10, "enrichment", { industry: "Robotics" }, { confidence: 0.9, evidence: "https://acme.example/about" });
  const before = rowOf([proposed]);
  assert.equal(before.values.industry, null);
  const state = foldAll([proposed]);
  assert.ok(state);
  assert.deepEqual(state.fields.industry.pending.map((p) => p.factId), ["acc_1@1#0"]);

  const fact = state.fields.industry.pending[0];
  const accepted = fold(state, entry(2, 20, "user", { kind: "decide", decisions: [{ fact, status: "accepted" }] }));
  assert.deepEqual(accepted.fields.industry.pending, []);
  assert.equal(project(account, accepted).values.industry, "Robotics");
  assert.deepEqual(project(account, accepted).meta.industry, { state: "resolved", factId: "acc_1@1#0", sourceKind: "enrichment" });

  const rejected = fold(state, entry(2, 20, "user", { kind: "decide", decisions: [{ fact, status: "rejected" }] }));
  assert.deepEqual(rejected.fields.industry?.candidates, []);
  assert.deepEqual(rejected.fields.industry?.pending, []);
});

test("pending proposals per field are bounded, dropping the oldest", () => {
  const entries = Array.from({ length: MAX_PENDING_PER_FIELD + 5 }, (_, i) => assert1(i + 1, i, "agent_run", { industry: `guess ${i}` }));
  const state = foldAll(entries);
  assert.ok(state);
  assert.equal(state.fields.industry.pending.length, 20);
  assert.equal(state.fields.industry.pending[0].value, "guess 5");
});

test("replaying an applied entry is a no-op; a gap or another stream's entry throws", () => {
  const entries = [assert1(1, 1, "salesforce", { name: "Acme" }), assert1(2, 2, "user", { name: "Acme Inc" })];
  const state = foldAll(entries);
  assert.ok(state);
  assert.equal(fold(state, entries[0]), state);
  assert.equal(foldAll(entries, state), state);

  assert.throws(() => fold(null, assert1(2, 1, "user", { name: "x" })), (e: unknown) => e instanceof GapError && e.expected === 1 && e.received === 2);
  assert.throws(() => fold(state, assert1(4, 3, "user", { name: "x" })), (e: unknown) => e instanceof GapError && e.streamId === "acc_1" && e.expected === 3 && e.received === 4);
  assert.throws(() => fold(state, entry(3, 3, "user", { kind: "lifecycle", op: "delete" }, "acc_2")), StreamMismatchError);
});

test("delete, restore, merge and erase", () => {
  const created = [entry(1, 10, "user", { kind: "lifecycle", op: "create" }), assert1(2, 10, "user", { name: "Acme" })];
  const deleted = [...created, entry(3, 20, "user", { kind: "lifecycle", op: "delete" }), entry(4, 25, "user", { kind: "lifecycle", op: "delete" })];
  assert.deepEqual([rowOf(deleted).deletedAt, rowOf(deleted).values.name], [20, "Acme"], "a second delete keeps the first time; values survive");
  const restored = [...deleted, entry(5, 30, "user", { kind: "lifecycle", op: "restore" })];
  assert.deepEqual([rowOf(restored).deletedAt, rowOf(restored).values.name, rowOf(restored).updatedAt], [null, "Acme", 30]);

  const merged = rowOf([...created, entry(3, 40, "user", { kind: "lifecycle", op: "merge", into: "acc_9" })]);
  assert.deepEqual([merged.deletedAt, merged.mergedInto], [40, "acc_9"]);

  const erased = rowOf([
    ...created,
    entry(3, 50, "user", { kind: "lifecycle", op: "erase" }),
    assert1(4, 60, "salesforce", { name: "Acme again" }),
    entry(5, 70, "user", { kind: "lifecycle", op: "restore" }),
  ]);
  assert.deepEqual([erased.deletedAt, erased.values.name, erased.meta.name.factId], [50, null, null], "erasure is final");
});

test("fold never mutates its input state", () => {
  const start = foldAll([assert1(1, 1, "salesforce", { name: "Acme", industry: "Software" }), assert1(2, 2, "enrichment", { domain: "acme.example" })]);
  assert.ok(start);
  const snapshot = structuredClone(start);
  deepFreeze(start);
  const pendingFact = start.fields.domain.pending[0];
  const next = foldAll([
    assert1(3, 3, "salesforce", { name: "Acme Corp" }),
    entry(4, 4, "user", { kind: "decide", decisions: [{ fact: pendingFact, status: "accepted" }] }),
    entry(5, 5, "user", { kind: "lifecycle", op: "erase" }),
  ], start);
  assert.deepEqual(start, snapshot);
  assert.equal(next?.version, 5);
});

test("write rule: unchanged values from the same source record confirm instead of appending", () => {
  const state = foldAll([
    assert1(1, 1, "salesforce", { name: "Acme", "custom.regions": ["EMEA", "NA"] }),
    assert1(2, 2, "enrichment", { industry: "Software" }, { evidence: "https://acme.example" }),
  ]);
  const salesforce = { kind: "salesforce" as const, ref: "salesforce:acc_1" };
  assert.deepEqual(writeRule(state, salesforce, [
    { fieldId: id("name"), value: "Acme" },
    { fieldId: id("custom.regions"), value: ["EMEA", "NA"] },
    { fieldId: id("employees"), value: 40 },
  ]), { append: [{ fieldId: "employees", value: 40 }], confirm: ["name", "f_regions"], status: "accepted" });
  assert.deepEqual(writeRule(state, { kind: "salesforce", ref: "salesforce:other" }, [{ fieldId: id("name"), value: "Acme" }]).append.length, 1, "another source record writes");
  assert.deepEqual(writeRule(state, salesforce, [{ fieldId: id("name"), value: "Acme Inc" }]).append, [{ fieldId: "name", value: "Acme Inc" }]);

  const enrichment = { kind: "enrichment" as const, ref: "enrichment:acc_1" };
  assert.deepEqual(writeRule(state, enrichment, [{ fieldId: id("industry"), value: "Software", evidence: "https://acme.example" }]), { append: [], confirm: ["industry"], status: "proposed" }, "a pending proposal counts");
  assert.equal(writeRule(state, enrichment, [{ fieldId: id("industry"), value: "Software", evidence: "https://other.example" }]).append.length, 1, "new evidence is a new fact");
  assert.equal(writeRule(null, salesforce, [{ fieldId: id("name"), value: "Acme" }]).append.length, 1);
});

test("write rule: two records of one source kind each confirm their own unchanged value", () => {
  const recordA = { kind: "salesforce" as const, ref: "salesforce:A" };
  const recordB = { kind: "salesforce" as const, ref: "salesforce:B" };
  const at = (version: number, source: typeof recordA, value: string): LedgerEntry => ({
    streamId: "acc_1", version, observedAt: version, source, actor: { kind: "integration", id: "salesforce" },
    body: { kind: "assert", status: "accepted", assertions: [{ fieldId: id("name"), value }] },
  });
  const state = foldAll([at(1, recordA, "Acme A"), at(2, recordB, "Acme B")]);
  assert.deepEqual(writeRule(state, recordA, [{ fieldId: id("name"), value: "Acme A" }]), { append: [], confirm: ["name"], status: "accepted" });
  assert.deepEqual(writeRule(state, recordB, [{ fieldId: id("name"), value: "Acme B" }]).confirm, ["name"]);
});

test("write rule: re-proposing a value a reviewer rejected is not a new proposal", () => {
  const enrichment = { kind: "enrichment" as const, ref: "enrichment:acc_1" };
  const proposed = assert1(1, 1, "enrichment", { industry: "Fintech" });
  const pendingFact = foldAll([proposed])!.fields[id("industry")]!.pending[0]!;
  const state = foldAll([proposed, entry(2, 2, "user", { kind: "decide", decisions: [{ fact: pendingFact, status: "rejected" }] })]);
  assert.deepEqual(writeRule(state, enrichment, [{ fieldId: id("industry"), value: "Fintech" }]), { append: [], confirm: ["industry"], status: "proposed" });
});

test("sameValue compares lists in order: a new primary is a change", () => {
  assert.equal(sameValue(["NA", "EMEA"], ["NA", "EMEA"]), true);
  assert.equal(sameValue(["NA", "EMEA"], ["EMEA", "NA"]), false);
  assert.equal(sameValue(["NA"], ["NA", "EMEA"]), false);
  assert.equal(sameValue(["NA"], "NA"), false);
  assert.equal(sameValue([], null), false);
  assert.equal(sameValue(5000, 5000.0000000001), true);
});

/**
 * Property: for random streams, the projection of the fold equals
 * resolveAttribute over each field's full accepted history, newest written
 * first: the `facts` ledger reads by observedAt then creation time, and a
 * proposal accepted later keeps the place of its creation.
 */
const originOf = (factId: string) => {
  const m = /@(\d+)#(\d+)$/.exec(factId);
  return m ? Number(m[1]) * 10_000 + Number(m[2]) : -1;
};

test("project(fold(...)) equals resolveAttribute over the full history for 1,000 random streams (fixed seed)", () => {
  const random = mulberry32(20261006);
  const fields = account.fields.filter((f) => !f.system && f.type !== "formula");
  let compared = 0;
  let contested = 0;
  let fromDecide = 0;
  let ties = 0;
  for (let i = 0; i < 1000; i++) {
    const entries = randomStream(random, `acc_${i}`, fields);
    let state: FoldState | null = null;
    const history = new Map<string, FactLike<FieldValue>[]>();
    const remember = (fact: Fact) => {
      const list = history.get(fact.fieldId) ?? [];
      list.push({ _id: fact.factId, attribute: fact.fieldId, value: fact.value, sourceKind: fact.sourceKind, sourceRef: fact.sourceRef, evidence: fact.evidence, confidence: fact.confidence, observedAt: fact.observedAt, validFrom: fact.validFrom, status: "accepted" });
      history.set(fact.fieldId, list);
    };
    for (const e of entries) {
      if (state) deepFreeze(state);
      state = fold(state, e);
      if (e.body.kind === "assert" && e.body.status === "accepted") {
        e.body.assertions.forEach((a, k) => remember({ factId: factIdOf(e.streamId, e.version, k), fieldId: a.fieldId, value: a.value, sourceKind: e.source.kind, sourceRef: e.source.ref, observedAt: e.observedAt, validFrom: a.validFrom, confidence: a.confidence ?? 1, evidence: a.evidence }));
      }
      if (e.body.kind === "decide") {
        for (const d of e.body.decisions) {
          if (d.status === "accepted") {
            remember(d.fact);
            fromDecide++;
          }
        }
      }
    }
    assert.ok(state);
    assert.equal(foldAll(entries, state), state, "replay over an up-to-date state is a no-op");
    const row = project(account, state);
    for (const field of fields) {
      const want = resolveAttribute([...(history.get(field.fieldId) ?? [])].sort((a, b) => originOf(b._id) - originOf(a._id)));
      const got = { value: row.values[field.fieldId], factId: row.meta[field.fieldId].factId, sourceKind: row.meta[field.fieldId].sourceKind, state: row.meta[field.fieldId].state };
      assert.deepEqual(got, { value: want.value, factId: want.factId, sourceKind: want.sourceKind, state: want.state }, `${state.streamId}.${field.apiName}`);
      compared++;
      if (want.state === "contested") contested++;
      if (hasEqualTimeTie(history.get(field.fieldId) ?? [])) ties++;
    }
  }
  assert.equal(compared, 1000 * fields.length);
  assert.ok(contested > 60 && fromDecide > 600 && ties > 100, `the generator exercises contests (${contested}), decided proposals (${fromDecide}) and equal-time ties (${ties})`);
});

/** Two sources whose facts are equally recent: only acceptance order separates them. */
function hasEqualTimeTie(facts: readonly FactLike<FieldValue>[]): boolean {
  const seen = new Map<string, SourceKind>();
  for (const f of facts) {
    const key = `${f.validFrom ?? f.observedAt}:${f.observedAt}`;
    const other = seen.get(key);
    if (other && other !== f.sourceKind) return true;
    seen.set(key, f.sourceKind);
  }
  return false;
}

const SOURCES: readonly SourceKind[] = ["user", "salesforce", "hubspot", "import", "enrichment", "agent_run", "call"];
const WORDS = ["alpha", "beta", "gamma"];
const REGIONS = ["NA", "EMEA", "APAC"];

function randomValue(random: () => number, field: FieldDef): FieldValue {
  if (random() < 0.1) return null;
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(random() * xs.length)];
  switch (field.type) {
    case "number":
    case "currency":
      return pick([100, 200, 300]);
    case "checkbox":
      return random() < 0.5;
    case "multipicklist":
      return [...REGIONS].sort(() => random() - 0.5).slice(0, 1 + Math.floor(random() * 2));
    default:
      return pick(WORDS);
  }
}

/**
 * A random stream: asserts from every source class with coarse, often equal
 * times and out-of-order validFrom; decides over the pending proposals;
 * deletes, restores and confirms in between.
 */
function randomStream(random: () => number, streamId: string, fields: readonly FieldDef[]): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  const pending: Fact[] = [];
  let t = 10 * DAY;
  const push = (kind: SourceKind, body: EntryBody) => {
    entries.push({ streamId, version: entries.length + 1, observedAt: t, source: { kind, ref: `${kind}:${streamId}` }, actor: { kind: "integration", id: kind }, body });
  };
  push("user", { kind: "lifecycle", op: "create" });
  const steps = 2 + Math.floor(random() * 10);
  for (let step = 0; step < steps; step++) {
    if (random() < 0.6) t += Math.floor(random() * 3) * DAY;
    const roll = random();
    if (roll < 0.65) {
      const kind = SOURCES[Math.floor(random() * SOURCES.length)];
      const status = AUTO_ACCEPT.has(kind) ? "accepted" : "proposed";
      const chosen = [...new Set(Array.from({ length: 1 + Math.floor(random() * 4) }, () => fields[Math.floor(random() * fields.length)]))];
      const assertions: Assertion[] = chosen.map((field) => ({
        fieldId: field.fieldId,
        value: randomValue(random, field),
        ...(random() < 0.4 ? { validFrom: t - Math.floor(random() * 4) * DAY } : {}),
        ...(status === "proposed" ? { confidence: Math.round(random() * 10) / 10 } : {}),
        ...(random() < 0.3 ? { evidence: `https://evidence.example/${Math.floor(random() * 3)}` } : {}),
      }));
      push(kind, { kind: "assert", status, assertions });
      if (status === "proposed") {
        const version = entries.length;
        assertions.forEach((a, k) => pending.push({
          factId: factIdOf(streamId, version, k), fieldId: a.fieldId, value: a.value, sourceKind: kind, sourceRef: `${kind}:${streamId}`,
          observedAt: t, validFrom: a.validFrom, confidence: a.confidence ?? 1, evidence: a.evidence,
        }));
      }
    } else if (roll < 0.85 && pending.length) {
      const decided = pending.splice(0, 1 + Math.floor(random() * pending.length));
      push("user", { kind: "decide", decisions: decided.map((fact) => ({ fact, status: random() < 0.7 ? "accepted" : "rejected" })) });
    } else if (roll < 0.93) {
      push("user", { kind: "lifecycle", op: random() < 0.5 ? "delete" : "restore" });
    } else {
      push("salesforce", { kind: "confirm", fieldIds: [fields[Math.floor(random() * fields.length)].fieldId] });
    }
  }
  return entries;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
