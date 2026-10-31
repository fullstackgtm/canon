import assert from "node:assert/strict";
import { test } from "node:test";
import { piContextStamp, piEligible, piSpecJson, piVerifiedFinding } from "../convex/lib/research/piProtocol.ts";
import { loadConvex, memoryDb } from "./convexHandlers.ts";
import { ID } from "../convex/lib/canon/identity.ts";

const spec = { kind: "qa", label: "Product", question: "What does Acme sell?", answerType: "text" } as const;
const answer = { status: "answered", value: "Forecasting", quote: "Acme sells a forecasting service", sourceUrl: "https://acme.example/", confidence: 1 } as const;

test("Canon verifies Pi answers against its served pages and only admits the bounded migration", () => {
  const pages = [{ url: answer.sourceUrl, text: `${answer.quote} for manufacturers.`, links: [] }];
  assert.equal(piVerifiedFinding(spec, answer, pages).status, "answered");
  assert.equal(piVerifiedFinding(spec, answer, []).status, "no_evidence");
  assert.equal(piVerifiedFinding(spec, { ...answer, quote: "Acme sells payroll software" }, pages).status, "no_evidence");
  assert.equal(piVerifiedFinding(spec, { ...answer, confidence: NaN }, pages).status, "no_evidence");
  assert.equal(piEligible({}, spec), false, "new factual work uses Convex even with the Pi pilot enabled");
  assert.equal(piEligible({ runtime: "pi" }, spec), true);
  for (const run of [{ onCredits: true }, { trigger: "probe" }, { trigger: "refresh" }]) assert.equal(piEligible({ runtime: "pi", ...run }, spec), false);
  for (const other of [{ ...spec, entityType: "contact" as const }, { ...spec, judgment: true }, { ...spec, kind: "classify" as const }, { ...spec, answerType: "number" as const }]) assert.equal(piEligible({ runtime: "pi" }, other), false);
});

test("Pi permission stamps survive Convex JSON serialization and still detect changed permissions", () => {
  const original = { spec: { ...spec, options: undefined }, agent: { updatedAt: 10 }, principals: [{ userId: "u", role: "rep", rules: {}, teamOwners: ["u"] }], standing: { status: "active" } };
  const wire = JSON.parse(JSON.stringify(original, (_key, value) => value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value));
  assert.equal(piContextStamp(original), piContextStamp(wire));
  assert.equal(piSpecJson(original.spec), piSpecJson(wire.spec));
  wire.principals[0].role = "admin";
  assert.notEqual(piContextStamp(original), piContextStamp(wire));
});

test("a rerun stages its next unanswered account after more than 2000 skipped accounts", async () => {
  const db = memoryDb({
    researchRuns: [{ _id: "run", orgId: "org", runtime: "pi", status: "running", piStep: 2001, skipped: 2001, planned: 100 }],
    piResearchSteps: Array.from({ length: 2001 }, (_, index) => ({ _id: `skip-${index}`, runId: "run", index, skipped: 1, landed: { finished: false, completed: 0 } })),
    canonEntities: [{ _id: "entity", orgId: "org" }],
    canonExternalIds: [{ _id: "external", orgId: "org", provider: ID.recordAccount, externalId: "account", entityId: "entity" }],
  });
  const loaded = { spec, agent: { updatedAt: 1 }, principals: [{ userId: "starter" }], standing: { status: "active" } };
  const functions = loadConvex(["piResearch.ts"], {
    "researchAgents.ts": (real) => ({ ...real, loadResearchRun: async () => ({ ...loaded, run: await db.get("run") }) }),
    "lib/research/piEnablement.ts": (real) => ({ ...real, piResearchEnabled: () => true }),
  })["piResearch.ts"];
  const args = { runId: "run", index: 2001, stamp: piContextStamp(loaded), total: 2002,
    record: { recordId: "account", entityId: "entity", label: "acme.example", subjectJson: JSON.stringify({ name: "Acme", domain: "acme.example" }) },
    skipped: 0, nextCursor: null, finished: true };
  const staged = await functions.stage.handler({ db }, args);
  assert.equal(staged.index, 2001);
  assert.equal(staged.record.recordId, "account");
  assert.equal((await functions.stage.handler({ db }, args))._id, staged._id);
  await assert.rejects(functions.stage.handler({ db }, { ...args, index: 2003 }));
});
