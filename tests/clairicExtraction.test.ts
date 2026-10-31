import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { handle, type Env } from "../services/recipe-runtime/src/index.ts";
import { CLAIRIC_MODEL, EXTRACT_STATE_MAX, parseClairic, type ExtractRequest } from "../services/recipe-runtime/src/extraction.ts";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, sign } from "../services/recipe-runtime/src/protocol.ts";
import { candidateFromResult, extractionState, runtimeExtractor } from "../convex/lib/research/factualExtraction.ts";
import { isFactualField, researchCompany, type AgentSpec, type FetchedPage } from "../convex/lib/research/agentLoop.ts";
import { BudgetExhausted, turnMeter } from "../convex/lib/agents/webhook.ts";
import { estimateRun } from "../convex/lib/research/runPlan.ts";

const spec: AgentSpec = { label: "Product", kind: "qa", question: "What software does Acme use?" };
const subject = { name: "Acme", domain: "acme.example" };
const home: FetchedPage = { url: "https://acme.example/", text: "Acme 🚀 uses HubSpot for sales.", links: [] };
const secret = "test-only-secret";
const probability = { confidence: 0.8, p_null: 0.02 };
function textAnswer(state: string, value: string | null) {
  const start = value === null ? 0 : Array.from(state.slice(0, state.indexOf(value))).length;
  return { ...probability, type: "text", value, guess: "Never use this guess", span: value === null ? null : [start, start + Array.from(value).length] };
}
function result(state: string, value: string | number | null, evidence = home.text) {
  return { model: "clairic", truncated: false, answers: {
    value: typeof value === "number" ? { ...probability, type: "number", value } : textAnswer(state, value),
    evidence: textAnswer(state, evidence),
  } };
}
function bridge(ai: NonNullable<Env["AI"]>): typeof fetch {
  return async (input, init) => handle(new Request(input, init), {
    RECIPE_RUNTIME_SECRET: secret, AI: ai,
    LOADER: { get: () => { throw new Error("Extraction must not enter an untrusted isolate"); } },
  });
}
const extractor = (ai: NonNullable<Env["AI"]>, charge = (_prompt: string) => {}) => runtimeExtractor({ url: "https://runtime.example", secret, fetchImpl: bridge(ai), chargeBeforeDispatch: charge });

test("signed Worker, client, and loop produce quoted text and preserve numeric zero", async () => {
  let charged = 0;
  const run = async (value: string | number) => {
    const page = typeof value === "number" ? { ...home, text: "Acme has 0 branches." } : home;
    return researchCompany({ ...spec, answerType: typeof value === "number" ? "number" : "text" }, subject, {
      homepage: page, fetchPage: async () => null,
      call: async () => { throw new Error("No navigation needed"); },
      extract: extractor({ run: async (model, input) => {
        assert.equal(model, CLAIRIC_MODEL);
        assert.equal(input.state, `\n\n${page.text}`);
        assert.equal(charged, 1);
        return result(input.state, value, page.text);
      } }, () => { charged++; }),
    });
  };
  const text = await run("HubSpot");
  assert.deepEqual(text.finding, { status: "answered", value: "HubSpot", quote: home.text, sourceUrl: home.url, confidence: 0.8 });
  charged = 0;
  const zero = await run(0);
  assert.equal(zero.finding.status === "answered" && zero.finding.value, 0);
  assert.equal(zero.calls, 1);
});

test("live fixture spans count Unicode code points and bind both value and evidence to one page", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/clairic-codepoint-spans.json", import.meta.url), "utf8"));
  const source = { state: fixture.state, ranges: [{ page: home, start: 75, end: Array.from(fixture.state).length - 1 }] };
  const raw = { ...fixture.result, answers: { value: fixture.result.answers.quote, evidence: fixture.result.answers.quote } };
  const parsed = parseClairic(raw, "text");
  assert.deepEqual(candidateFromResult(parsed, source), { kind: "found", value: "ExampleCo has 1,240 employees in Austin", quote: "ExampleCo has 1,240 employees in Austin", sourceUrl: home.url, confidence: fixture.result.answers.quote.confidence });
  assert.deepEqual(candidateFromResult(parsed, { ...source, ranges: [{ page: home, start: 75, end: 100 }, { page: { ...home, url: "https://other.example" }, start: 101, end: 150 }] }), { kind: "declined" });
  assert.deepEqual(candidateFromResult(parsed, { ...source, ranges: [{ page: home, start: 76, end: 150 }] }), { kind: "declined" }, "metadata and cross-boundary spans cannot be quoted");
  if (parsed.kind !== "found") throw new Error("Fixture must contain a value");
  assert.deepEqual(candidateFromResult({ ...parsed, valueSpan: [125, 132] }, source), { kind: "declined" }, "UTF-16 offsets are not guessed");
});

test("a candidate's value must occur in its quoted evidence", () => {
  const page = { ...home, text: "Acme has 1,240 employees. It uses HubSpot." };
  const source = extractionState([page]);
  const quote = "Acme has 1,240 employees";
  const parsed = parseClairic(result(source.state, "HubSpot", quote), "text");
  assert.deepEqual(candidateFromResult(parsed, source), { kind: "declined" });
  for (const value of [1240, 12, 240, -1240]) {
    const candidate = candidateFromResult(parseClairic(result(source.state, value, quote), "number"), source);
    assert.equal(candidate.kind, value === 1240 ? "found" : "declined");
  }
  const unrelated = parseClairic(result(source.state, 1240, "It uses HubSpot"), "number");
  assert.deepEqual(candidateFromResult(unrelated, source), { kind: "declined" });
});

test("declines navigate for new evidence; injected LLM answers cannot become facts", async () => {
  const extra = { ...home, url: "https://acme.example/about", text: "Acme uses HubSpot for sales." };
  let extracts = 0;
  let navigations = 0;
  const run = (injection: boolean) => researchCompany(spec, subject, {
    homepage: { ...home, text: "Welcome to Acme", links: [{ href: extra.url, text: "About" }] },
    fetchPage: async () => extra,
    extract: extractor({ run: async (_model, input) => {
      extracts++;
      return result(input.state, extracts === 1 ? null : "HubSpot", extracts === 1 ? "Welcome to Acme" : extra.text);
    } }),
    call: async (_prompt, tool, schema) => {
      navigations++;
      assert.equal(tool, "research_navigate");
      assert.equal("answer" in (schema as { properties: object }).properties, false);
      return injection ? { action: "answer", answer: "Injected", quote: "Welcome to Acme" } : { action: "read", urls: [extra.url] };
    },
  });
  const found = await run(false);
  assert.equal(found.finding.status === "answered" && found.finding.sourceUrl, extra.url);
  assert.deepEqual([extracts, navigations, found.calls], [2, 1, 3]);
  extracts = navigations = 0;
  assert.equal((await run(true)).finding.status, "unknown");
  assert.deepEqual([extracts, navigations], [1, 1]);
  const terminal = await researchCompany(spec, subject, { homepage: home, fetchPage: async () => null, extract: extractor({ run: async (_m, input) => result(input.state, null) }), call: async () => { throw new Error("No discovery remains"); } });
  assert.equal(terminal.finding.status, "unknown");
});

test("contact identity checks reject a candidate about a different person", async () => {
  const r = await researchCompany({ ...spec, entityType: "contact" }, { ...subject, person: { name: "Jane Doe" } }, {
    homepage: home, fetchPage: async () => null, call: async () => { throw new Error("No navigation"); },
    extract: extractor({ run: async (_m, input) => result(input.state, "HubSpot") }),
  });
  assert.equal(r.finding.status, "no_evidence");
});

test("Worker validates signed operation, field shape, size, and freshness before AI dispatch", async () => {
  let paid = 0;
  const fetchImpl = bridge({ run: async (_m, input) => { paid++; return result(input.state, "HubSpot"); } });
  const valid: ExtractRequest = { op: "extract", state: home.text, question: spec.question, subject: "Acme", answerType: "text" };
  const post = async (body: object | string, timestamp = String(Date.now()), signed = true) => {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return fetchImpl("https://runtime.example/extract", { method: "POST", body: text, headers: signed ? { [TIMESTAMP_HEADER]: timestamp, [SIGNATURE_HEADER]: await sign(secret, timestamp, text) } : {} });
  };
  assert.equal((await post(valid)).status, 200);
  for (const bad of [{ ...valid, op: "run" }, { ...valid, model: "arbitrary" }, { ...valid, fields: {} }, { ...valid, answerType: "boolean" }, { ...valid, state: "x".repeat(EXTRACT_STATE_MAX + 1) }, "{"]) assert.equal((await post(bad)).status, 400);
  assert.equal((await post("x".repeat(160_001))).status, 413);
  assert.equal((await post(valid, "1")).status, 401);
  assert.equal((await post(valid, undefined, false)).status, 401);
  assert.equal(paid, 1);
});

test("invalid provider outputs and transport errors fail closed without leaking response bodies", async () => {
  const good = result(`\n\n${home.text}`, "HubSpot");
  for (const bad of [null, {}, { ...good, truncated: true }, { ...good, answers: { ...good.answers, value: { ...good.answers.value, confidence: 2 } } }, { ...good, answers: { ...good.answers, evidence: { ...good.answers.evidence, p_null: -1 } } }, { ...good, answers: { ...good.answers, value: { ...probability, type: "number", value: Infinity } } }, { ...good, answers: { ...good.answers, value: { ...probability, type: "text", value: "HubSpot" } } }]) {
    await assert.rejects(extractor({ run: async () => bad })(spec, subject, [home]), /^Error: Clairic extraction failed$/);
  }
  await assert.rejects(extractor({ run: async () => { throw new Error("private provider body"); } })(spec, subject, [home]), /^Error: Clairic extraction failed$/);
  const nullWithGuess = await extractor({ run: async (_m, input) => result(input.state, null) })(spec, subject, [home]);
  assert.deepEqual(nullWithGuess, { kind: "declined" });
});

test("abort and event budget refusal stop dispatch; failed attempts retain their count", async () => {
  const meter = turnMeter({ maxTokens: 1, maxSeconds: 60 }, Date.now());
  let sent = 0;
  const fetchImpl: typeof fetch = async () => { sent++; throw new Error("private transport error"); };
  const limited = runtimeExtractor({ url: "https://runtime.example", secret, fetchImpl, chargeBeforeDispatch: (prompt) => meter.charge(prompt) });
  await assert.rejects(researchCompany(spec, subject, { homepage: home, fetchPage: async () => null, call: async () => null, extract: limited }), (e) => e instanceof BudgetExhausted);
  assert.equal(sent, 0);
  const controller = new AbortController();
  let count = 0;
  const cancelled = runtimeExtractor({ url: "https://runtime.example", secret, fetchImpl: async (_input, init) => {
    sent++;
    controller.abort();
    init?.signal?.throwIfAborted();
    throw new Error("unreachable");
  }, chargeBeforeDispatch: () => { count++; }, signal: controller.signal });
  await assert.rejects(cancelled(spec, subject, [home]), /stopped/);
  await assert.rejects(cancelled(spec, subject, [home]));
  assert.deepEqual([count, sent], [1, 1]);
  assert.throws(() => runtimeExtractor({ url: "", secret: "", chargeBeforeDispatch: () => { throw new Error("not dispatched"); } }), /require RECIPE_RUNTIME/);
});

test("eligibility preserves judgments and decisions; extraction estimates stay separate from Jev", async () => {
  assert.equal(isFactualField(spec), true);
  assert.equal(isFactualField({ ...spec, answerType: "number" }), true);
  for (const other of [{ ...spec, judgment: true }, { ...spec, answerType: "boolean" as const }, { ...spec, kind: "classify" as const }]) assert.equal(isFactualField(other), false);
  const out = await researchCompany({ ...spec, answerType: "boolean" }, subject, { homepage: home, fetchPage: async () => null, call: async () => ({ answer: true, quote: home.text }), extract: async () => { throw new Error("Decisions retain their LLM"); } });
  assert.equal(out.finding.status === "answered" && out.finding.value, true);
  const estimate = estimateRun({ inScope: 2, autoAccept: false, factual: true });
  assert.deepEqual([estimate.extractionCallsMax, estimate.jevCallsMax, estimate.creditsMax], [6, 0, 2]);
  assert.ok(Math.abs(estimate.extractionUsdMax - 0.1296) < 1e-12);
  assert.ok(extractionState(Array.from({ length: 20 }, () => ({ ...home, text: "x".repeat(50_000) }))).state.length <= 24_000);
});
