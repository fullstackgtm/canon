import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseModuleManifest, pageReadable, type ModuleManifest } from "../../../kernel/manifest.ts";
import { widgetOf } from "../../../kernel/schema.ts";
import { answerRows, calls, fieldPage, runPage } from "../server.ts";

const manifest = JSON.parse(readFileSync(new URL("../module.json", import.meta.url), "utf8")) as ModuleManifest;
const field = { id: "buyer", label: "Buyer", attribute: "custom.buyer", kind: "classify", entity: "contact", question: "Who buys?", options: [{ key: "ops", label: "Operations", description: "Owns operations" }], owner: "Ada", agentStatus: "active", autoAccept: 0.8, canEditGate: true, canRefresh: true, refreshCadence: "weekly", refreshNextAt: 0, refreshEstimate: { cap: 100, jevUsdMax: 0.012, extractionCallsMax: 0 } };

test("AF2 uses closed direct human operations, editable forms and action-only answers", () => {
  const parsed = parseModuleManifest(manifest);
  assert.deepEqual(parsed.ok ? [] : parsed.errors, []);
  for (const name of ["start", "probe", "stop", "autoAccept", "refresh"]) {
    const c = manifest.calls![name];
    assert.equal(c.agent, "human");
    assert.equal(c.canon?.operation, `research.${name}`);
    assert.deepEqual([c.reads, c.writes], [{}, []]);
  }
  for (const name of ["start", "probe"]) {
    const args = manifest.calls![name].args!;
    for (const key of ["contacts", "filter", "capCredits"]) assert.notEqual(widgetOf(args.value[key]), null);
  }
  assert.equal(pageReadable("research.answers", manifest), false);
  const invalid = structuredClone(manifest);
  invalid.pages[0].bind = { answers: { canon: "research.answers", args: { slug: "buyer" } } };
  assert.equal(parseModuleManifest(invalid).ok, false);
  assert.equal(manifest.pages.some((p) => p.path === "field/:slug"), true);
  assert.equal(manifest.pages.some((p) => p.path === "run/:slug/:run"), true);
  assert.deepEqual(Object.keys(calls).sort(), ["answers", "field", "run"]);
});

test("field and run fixtures present literal progress, counters, sample, Jev and trace steps", () => {
  const details = fieldPage(field);
  assert.equal(details.canRun, true);
  assert.deepEqual(details.options, [{ key: "ops", label: "Operations", description: "Owns operations" }]);
  assert.equal(fieldPage({ ...field, agentStatus: "paused" }).canRun, false);
  assert.equal(fieldPage({ ...field, latestRun: { status: "running" } }).canRun, false);
  const run = runPage(field, {
    id: "run:old", status: "running", inScope: 20, planned: 10, done: 4, errors: 1, answered: 2, unknown: 1, noEvidence: 1, inferred: 1, skipped: 3, pagesRead: 8, llmCalls: 6,
    scheduled: true, probe: true, credits: { cap: 10, spent: 3 }, stop: { rule: "cap", message: "Cap reached" }, error: "One record failed",
    verdict: { kind: "mixed", settled: 4, answered: 2, jev: { read: 3, picks: [{ choice: "ops", count: 2, confident: 1 }], bands: { high: 1, mid: 1, low: 1 } } },
    sample: [{ label: "Ada", status: "answered", value: "ops", quote: "Runs operations", jev: { choice: "ops", confidence: 0.9 } }],
  }, [{ id: "trace:1", label: "Ada", status: "answered", value: "ops", model: "fixture-model", promptVersion: "v3", calls: 2, ms: 1500, steps: [{ kind: "search", query: "Ada operations", pages: 2 }, { kind: "model", action: "answer" }, { kind: "read", url: "https://fixture.example", ok: true }] }]);
  assert.deepEqual(run.summary.map((r) => [r.label, r.value]), [
    ["Status", "running · scheduled refresh · sample of 10"], ["Progress", "50% of 10 planned · 20 in scope"],
    ["Answered", "2"], ["Unknown", "1"], ["Without evidence", "1"], ["Inferred by Jev", "1"], ["Errors", "1"], ["Skipped", "3"], ["Pages read", "8"], ["Model calls", "6"], ["Credits", "3 of 10 credits"], ["Stopped", "Cap reached"], ["Error", "One record failed"],
  ]);
  assert.deepEqual(run.picks, [{ choice: "Operations", count: 2, confident: 1 }]);
  assert.deepEqual([run.sample[0].value, run.sample[0].quote, run.sample[0].pick, run.sample[0].confidence], ["Operations", "Runs operations", "Operations", "90%"]);
  assert.deepEqual(run.traces[0].steps.map((s) => s.text), ["Search: Ada operations · 2 results", "Model: answer", "Read: https://fixture.example"]);
  assert.deepEqual([run.traces[0].model, run.traces[0].prompt, run.traces[0].calls, run.traces[0].seconds], ["fixture-model", "v3", 2, "1.5"]);
  assert.equal(runPage(field, { credits: { spent: 0 } }, []).summary.some((r) => r.label === "Credits"), false);
  assert.deepEqual(runPage(field, undefined, [{ label: "Must not escape" }]).traces, []);
});

test("answer fixtures retain literal quotes, source links, status and Jev read scores", () => {
  assert.deepEqual(answerRows(field, [{ account: "Ada", value: "ops", status: "proposed", evidence: '"Runs operations"\n\nSource: https://fixture.example (inferred by Jev)', verification: 0.85, verifiedBy: "read", observedAt: 0 }]), [{
    record: "Ada", value: "Operations", status: "proposed", check: "Jev read 0.85", quote: '"Runs operations"', source: "https://fixture.example", via: "Inferred by Jev", observed: "1970-01-01 00:00 UTC",
  }]);
  assert.equal(answerRows(field, [{ evidence: "Literal quote\n\nSource: javascript:bad", verification: null }])[0].source, "");
  assert.deepEqual(answerRows(undefined, [{ evidence: "Private" }]), []);
});
