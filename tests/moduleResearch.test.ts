import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadConvex } from "./convexHandlers.ts";
import { parseModuleManifest } from "../modules/kernel/manifest.ts";
import { defaultSlots, planUpgrade } from "../modules/kernel/upgrade.ts";
import { fakeAnswer, gateAnswer, outputSchema } from "../modules/kernel/ai.ts";
import type { ModuleManifest } from "../modules/kernel/manifest.ts";
import type { ActionCtx } from "../convex/_generated/server.ts";
import type { runAiStep as RunAiStep } from "../convex/lib/modules/ai.ts";
import type { readWebPages as ReadWebPages, readWebSearch as ReadWebSearch } from "../convex/moduleWebActions.ts";
import { webSearchRequest } from "../modules/kernel/webSearch.ts";
import type { AiRun } from "../convex/lib/modules/scope.ts";
import { researchCalls } from "../modules/examples/icps/research.ts";
import type { CallContext, ReadDoc } from "../modules/kernel/calls.ts";

const manifest = JSON.parse(readFileSync("modules/examples/icps/module.json", "utf8")) as ModuleManifest;
const ai = manifest.calls!.deriveWebsiteResult.ai!;
const schema = outputSchema(manifest, ai)!;
const sourceText = "We supply warehouse inventory tools for manufacturers. Operations managers buy our product for regional factories.";
const reads = { pages: [{ id: "homepage", url: "https://acme.test/", text: sourceText }, { id: "page-1", url: "https://acme.test/products", text: "Our product tracks stock and purchasing for factory operations. Buyers manage manufacturing inventory." }] };
const files = loadConvex(["moduleWebActions.ts", "lib/modules/ai.ts"]);
const readWebPages = files["moduleWebActions.ts"].readWebPages as unknown as typeof ReadWebPages;
const readWebSearch = files["moduleWebActions.ts"].readWebSearch as unknown as typeof ReadWebSearch;
const runAiStep = files["lib/modules/ai.ts"].runAiStep as unknown as typeof RunAiStep;

test("public website sources are bounded, exact and fake transport performs no fetch", async () => {
  let fetched = 0;
  const fetchPage = async (url: string) => {
    fetched++;
    if (url.endsWith("llms.txt")) return { text: "# Plain source\nThe product tracks stock for regional manufacturing teams.", finalUrl: url };
    return { text: `<p>${sourceText.repeat(400)}</p><a href="/products">Product</a><a href="https://other.test/about">About</a>`, finalUrl: url };
  };
  const fake = await readWebPages({ domain: "acme.test" }, true, fetchPage);
  assert.deepEqual([fake.length, fake[0].id, fetched], [2, "homepage", 0]);
  const live = await readWebPages({ domain: "ACME.test" }, false, fetchPage);
  assert.deepEqual(Array.from(live, (s) => [s.id, s.url]), [["homepage", "https://acme.test/"], ["llms", "https://acme.test/llms.txt"], ["page-1", "https://acme.test/products"]]);
  assert.equal(live[0].text.length, 28000);
  assert.equal(live[2].text.length, 10000);
  assert.equal(live[0].text.startsWith(sourceText), true);
  await assert.rejects(readWebPages({ domain: "thin.test" }, false, async (url) => ({ text: "Short", finalUrl: url })));
  await assert.rejects(readWebPages({ domain: "unreadable.test" }, false, async () => null));
  await assert.rejects(readWebPages({ domain: "acme.test" }, false, async () => { throw new Error("Transport failed"); }));
  for (const domain of ["http://127.0.0.1", "http://user:secret@acme.test", "file:///tmp/a", "acme.test:8080", "localhost.local"]) await assert.rejects(readWebPages({ domain }, true, fetchPage));
});

test("web search skips unreadable hosts and pages, deduplicates URLs and caps fetched evidence", async () => {
  const fetched: string[] = [], searched: string[] = [];
  const deps = {
    search: async (query: string) => {
      searched.push(query);
      return (query === "first" ? ["https://linkedin.com/company/acme", "https://x.com/acme", "https://missing.test/", "https://redirect.test/", "https://acme.test/0#fragment"] : ["https://acme.test/0", ...Array.from({ length: 13 }, (_, i) => `https://acme.test/${i + 1}`)]).map((url) => ({ url, title: "Search title" }));
    },
    fetchPage: async (url: string) => {
      fetched.push(url);
      return url.includes("missing") ? null : { text: `<p>${sourceText.repeat(100)}</p>`, finalUrl: url.includes("redirect") ? "https://www.linkedin.com/company/acme" : url };
    },
  };
  const rows = await readWebSearch({ queries: ["first", "second"] }, false, deps);
  assert.deepEqual(searched, ["first", "second"]);
  assert.deepEqual(Array.from(rows, (r) => [r.id, r.url, r.title, r.query, r.text.length]), Array.from({ length: 12 }, (_, i) => [`https://acme.test/${i}`, `https://acme.test/${i}`, "Search title", i ? "second" : "first", 8000]));
  assert.equal(rows[0].text.startsWith(sourceText), true);
  assert.equal(fetched.some((u) => /linkedin|x\.com/.test(u)), false);
  assert.equal(fetched.filter((u) => u === "https://acme.test/0").length, 1);
  const balanced = await readWebSearch({ queries: ["competitors", "news", "posts", "jobs"] }, false, { ...deps, search: async (query) => Array.from({ length: 20 }, (_, i) => ({ url: `https://acme.test/${query}/${i}`, title: query })) });
  assert.deepEqual(Array.from(balanced, (r) => r.query), ["competitors", "competitors", "competitors", "news", "news", "news", "posts", "posts", "posts", "jobs", "jobs", "jobs"]);
  const fixtures = await readWebSearch({ queries: ["first", "first"] }, true, { search: async () => { throw new Error("Search forbidden"); }, fetchPage: async () => { throw new Error("Fetch forbidden"); } });
  assert.deepEqual([fixtures.length, fixtures[0].id, fixtures[0].query], [3, "https://search.example.test/first/1", "first"]);
  for (const queries of [[], Array(5).fill("query"), [" "], ["q".repeat(201)], [1]]) assert.throws(() => webSearchRequest({ queries }));
  assert.throws(() => webSearchRequest({ queries: ["query"], domain: "acme.test" }));
  await assert.rejects(readWebSearch({ queries: ["query"] }, false, { search: async () => { throw new Error("Plan quota refused"); } }));
});

test("web search fixtures bypass plan resolution and a missing live plan refuses before network", async (t) => {
  const previous = process.env.MODULE_AI_MODEL;
  t.after(() => { if (previous === undefined) delete process.env.MODULE_AI_MODEL; else process.env.MODULE_AI_MODEL = previous; });
  let resolved = 0;
  const loaded = loadConvex(["moduleWebActions.ts"], { "lib/llmResolver.ts": (real) => ({ ...real, resolveLlm: async () => { resolved++; return null; } }) }, { fetch: async () => { throw new Error("Network forbidden"); } });
  const invoke = () => loaded["moduleWebActions.ts"].search.handler({}, { queries: ["query"], userId: "member" });
  process.env.MODULE_AI_MODEL = "fake";
  assert.equal((await invoke()).length, 3);
  assert.equal(resolved, 0);
  process.env.MODULE_AI_MODEL = "live";
  await assert.rejects(invoke(), /sign in with ChatGPT/i);
  assert.equal(resolved, 1);
});

test("the 0.3 package upgrades without changing interfaces, and impossible completion or undeclared reads refuse", () => {
  const old = JSON.parse(readFileSync("tests/fixtures/modules/icps-0.3.0.json", "utf8"));
  assert.equal(parseModuleManifest(manifest).ok, true);
  assert.deepEqual(planUpgrade(old, defaultSlots(old), manifest, old.version).problems, []);
  assert.deepEqual(old.provides, manifest.provides);
  for (const edit of [
    (m: ModuleManifest) => {
      m.calls!.implicit = { label: "Implicit web", roles: ["admin"], agent: "allowed", reads: { pages: { canon: "web.pages", args: { domain: "acme.test" } } }, writes: [], returns: "value" };
      m.pages[0].bind!.web = { call: "implicit" };
    },
    (m: ModuleManifest) => { delete m.reads!.web; },
    (m: ModuleManifest) => { m.pages[0].bind!.tree = { call: "tree", refreshOn: ["missing"] }; },
    (m: ModuleManifest) => { delete m.reads!.signup; },
    (m: ModuleManifest) => { m.calls!.adoptDerived.system = true; },
    (m: ModuleManifest) => { m.calls!.adoptDerived.agent = "propose"; },
    (m: ModuleManifest) => { delete m.calls!.adoptDerived.capability; },
    (m: ModuleManifest) => { m.calls!.adoptDerived.reads.accounts = { canon: "companies.bestFit" }; },
  ]) { const next = structuredClone(manifest); edit(next); assert.equal(parseModuleManifest(next).ok, false); }
});

test("one evidence repair shares one reserved run and refuses a repeated failure before any output write", async (t) => {
  process.env.MODULE_AI_MODEL = "live";
  t.after(() => { delete process.env.MODULE_AI_MODEL; });
  const valid = fakeAnswer(ai, schema, reads, {});
  const invalid = structuredClone(valid);
  (invalid.result as { evidence: Array<{ quote: string }> }).evidence.forEach((q) => { q.quote = "An invented claim with no exact source."; });
  for (const repairs of [true, false]) {
    const prompts: string[] = [], receipts: Array<Record<string, unknown>> = [];
    let reservations = 0, writes = 0;
    const ctx = {
      runMutation: async (ref: unknown, args: Record<string, unknown>) => {
        if (String(ref).endsWith("reserve")) { reservations++; return { id: "receipt", ran: 0 }; }
        receipts.push(args); return null;
      },
      runAction: async (_ref: unknown, args: { prompt: string; credits: boolean }) => {
        assert.equal(args.credits, false);
        prompts.push(args.prompt);
        return { raw: prompts.length === 1 || !repairs ? invalid : valid, provider: "chatgpt", model: "test-plan" };
      },
    } as unknown as ActionCtx;
    const run: AiRun = { decl: ai, schema, key: "run", collection: "derivations", expect: { collection: "derivations", key: "run", version: 2 }, module: "ICPs", moduleId: manifest.id, orgId: "org" };
    const invoke = () => runAiStep(ctx, { call: "deriveWebsiteResult", label: "Research", run, reads, userId: "admin", returns: "value", credits: true }, async (intents) => { writes++; assert.equal(intents[0].op, "op"); return { writes: 1, proposed: [] }; });
    if (repairs) assert.deepEqual({ ...(await invoke()).value }, { kept: 2, dropped: 0, model: "test-plan" }); else await assert.rejects(invoke());
    assert.deepEqual([reservations, prompts.length, writes, receipts.at(-1)!.status], [1, 2, repairs ? 1 : 0, repairs ? "done" : "failed"]);
    assert.equal(receipts.at(-1)!.inputChars, prompts[0].length + prompts[1].length);
    assert.equal(prompts[1].includes("An invented claim with no exact source."), true);
    assert.equal(prompts[1].includes(sourceText), true);
  }
  const changedCase = structuredClone(valid);
  (changedCase.result as { evidence: Array<{ quote: string }> }).evidence[0].quote = "WE SUPPLY WAREHOUSE INVENTORY TOOLS FOR MANUFACTURERS.";
  assert.equal(gateAnswer(ai, schema, changedCase, reads, {}).kept, 1, "exact evidence does not fold case");
});

test("plan-only selection refuses a missing plan without entering the Canon credit route", async () => {
  let paid = 0;
  const modelFiles = loadConvex(["moduleAiActions.ts"], {
    "lib/llmResolver.ts": (real) => ({ ...real, resolveLlm: async () => null }),
    "lib/canonModel.ts": (real) => ({ ...real, canonResearchLlm: () => { paid++; return null; } }),
  });
  await assert.rejects(modelFiles["moduleAiActions.ts"].answer.handler({}, { orgId: "org", userId: "admin", label: "Website research", prompt: "", schema: {}, credits: false }));
  assert.equal(paid, 0);
  await assert.rejects(modelFiles["moduleAiActions.ts"].answer.handler({}, { orgId: "org", userId: "admin", label: "Default research", prompt: "", schema: {}, credits: true }));
  assert.equal(paid, 1, "the existing default policy still considers Canon credits");
});


test("website ICP keys retain run identity within the record-service tree ID limit", async () => {
  const ctx: CallContext = { now: 1792600000000, caller: { userId: "x".repeat(32), role: "admin" }, args: { domain: "acme.test" } };
  const begin = await researchCalls.deriveFromWebsite(ctx, {});
  const first = begin.intents![0];
  assert.equal(first.op, "put");
  if (first.op !== "put" || typeof first.key !== "string") throw new Error("Expected derivation");
  const raw = fakeAnswer(ai, schema, reads, {});
  const run: ReadDoc = { key: first.key, version: 2, owner: null, parentKey: null, createdAt: ctx.now, updatedAt: ctx.now, data: { ...first.data, state: "deriving", result: raw.result, sources: reads.pages, model: "test-model" } };
  const result = await researchCalls.adoptDerived({ ...ctx, args: { key: run.key } }, { derivation: run, definitions: [] });
  const made = result.intents![0];
  assert.equal(made.op, "put");
  if (made.op !== "put") throw new Error("Expected definition");
  assert.equal(made.key, first.key.replace(/^derive-/, "website-"));
  assert.ok(`icps:${made.key}`.length <= 64);
});
