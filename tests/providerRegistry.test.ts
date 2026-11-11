import assert from "node:assert/strict";
import test from "node:test";
import { providerProblems, type ProviderDecl } from "../modules/kernel/providers.ts";
import { PROVIDERS, ProviderUnavailable, providerSettings, resolveCapability, runChain, type Resolution } from "../convex/lib/providers/registry.ts";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const env = { TREG_TOKEN: "t" };
const chainOf = (r: Resolution) => r.chain.map((c) => `${c.provider}:${c.source}`);

test("email.find resolves to the workspace's own key first, then the deployment's, else a reason naming both", () => {
  assert.deepEqual(chainOf(resolveCapability("email.find", { workspace: new Set(["deepline"]), env })), ["deepline:workspace", "treg:deployment"]);
  assert.deepEqual(chainOf(resolveCapability("email.find", { workspace: new Set(), env })), ["treg:deployment"]);
  assert.deepEqual(chainOf(resolveCapability("email.find", { workspace: new Set(["deepline"]), env: { TREG_TOKEN: " " } })), ["deepline:workspace"]);
  assert.deepEqual(chainOf(resolveCapability("email.find", { workspace: new Set(["deepline"]), env }, { sources: ["deployment"] })), ["treg:deployment"]);
  const none = resolveCapability("email.find", { workspace: new Set(), env: {} });
  assert.deepEqual(none.chain, []);
  assert.ok(none.reason?.includes("Deepline") && none.reason.includes("TREG_TOKEN"), none.reason ?? "");
});

test("Find email order: a Deepline hit skips treg; a miss or a failure runs it; the last provider's error is the caller's", async () => {
  const both = resolveCapability("email.find", { workspace: new Set(["deepline"]), env });
  const run = async (resolution: Resolution, deepline: (last: boolean) => Promise<string | null>) => {
    let treg = 0;
    const out = await runChain(resolution, async ({ provider }, last) => (provider === "deepline" ? deepline(last) : (treg += 1, "treg")));
    return { out, treg };
  };
  assert.deepEqual(await run(both, async () => "ada@acme.example"), { out: "ada@acme.example", treg: 0 });
  assert.deepEqual(await run(both, async () => null), { out: "treg", treg: 1 });
  assert.deepEqual(await run(both, async () => { throw new Error("Deepline down"); }), { out: "treg", treg: 1 });
  assert.deepEqual(await run(resolveCapability("email.find", { workspace: new Set(), env }), async () => "unused"), { out: "treg", treg: 1 });
  const alone = resolveCapability("email.find", { workspace: new Set(["deepline"]), env: {} });
  assert.deepEqual(await run(alone, async (last) => (last ? "miss" : null)), { out: "miss", treg: 0 });
  await assert.rejects(run(alone, async () => { throw new Error("Deepline down"); }), /Deepline down/);
  await assert.rejects(run(resolveCapability("email.find", { workspace: new Set(), env: {} }), async () => "unused"), ProviderUnavailable);
});

test("every registered provider is a valid declaration, and a bad one is refused with each problem's path", () => {
  for (const decl of Object.values(PROVIDERS)) assert.deepEqual(providerProblems(decl), [], decl.id);
  const bad: ProviderDecl = { id: "Bad", label: " ", capabilities: ["email.find", "nope" as never], keys: [{ name: "lower", source: "workspace" }], cost: { credits: 0, per: "call" }, limits: [{ max: 1.5, per: "day" }], terms: { "phone.find": { limits: [{ max: 0, per: "day" }] } } };
  assert.deepEqual(providerProblems(bad).map((p) => p.split(" ")[0]), ["id", "label", "capabilities[1]", "keys[0].name", "cost.credits", "limits[0].max", "terms.phone.find", "terms.phone.find.limits[0].max"]);
});

test("Settings shows each capability's provider and key source, and bring-your-own-key where a self-hosted install has none", () => {
  const view = (workspace: string[], e: Record<string, string>) => providerSettings({ workspace: new Set(workspace), env: e }).map((c) => ({
    capability: c.capability, ready: c.ready, serving: c.providers.find((p) => p.serving)?.id ?? null,
    keys: c.providers.flatMap((p) => p.keys.map((k) => `${k.name}:${k.source}:${k.set}`)),
  }));
  const treg = ["TREG_TOKEN:deployment:false"], unipile = ["UNIPILE_API_KEY:deployment:false", "UNIPILE_DSN:deployment:false"];
  assert.deepEqual(view([], {}), [
    { capability: "email.find", ready: false, serving: null, keys: ["DEEPLINE_API_KEY:workspace:false", ...treg] },
    ...["phone.find", "person.enrich", "company.enrich", "people.search"].map((capability) => ({ capability, ready: false, serving: null, keys: treg })),
    { capability: "linkedin.send", ready: false, serving: null, keys: unipile },
    { capability: "linkedin.read", ready: false, serving: null, keys: unipile },
  ]);
  const hosted = { TREG_TOKEN: "t", UNIPILE_API_KEY: "k", UNIPILE_DSN: "api1.unipile.com:1" };
  assert.deepEqual(view([], hosted).map((c) => c.serving), ["treg", "treg", "treg", "treg", "treg", "unipile", "unipile"]);
  assert.deepEqual(view(["deepline"], hosted)[0], { capability: "email.find", ready: true, serving: "deepline", keys: ["DEEPLINE_API_KEY:workspace:true", "TREG_TOKEN:deployment:true"] });
  assert.equal(view([], { UNIPILE_API_KEY: "k" }).find((c) => c.capability === "linkedin.send")?.ready, false);
  // Each capability shows its own cost and limits: Find phone its allowance, an enrichment its credits.
  const terms = Object.fromEntries(providerSettings({ workspace: new Set(), env: hosted }).map((c) => [c.capability, c.providers.find((p) => p.serving)!]));
  assert.deepEqual([terms["phone.find"].limits.map((l) => l.max), terms["person.enrich"].cost, terms["email.find"].limits.map((l) => l.max)], [[50, 50], { credits: 8, per: "hit" }, [100, 100]]);
});

// ───────────── treg's hosted phone and enrichment calls, pinned through their entry points (no live call) ─────────────

/** treg over a fake HTTP layer: each request's endpoint, headers and body, answered by `answers[endpoint]`. */
function fakeTreg(answers: Record<string, { body: unknown; cost: number; callId: string }>) {
  const seen: Array<{ endpoint: string; headers: Record<string, string>; body: unknown }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const endpoint = new URL(url).pathname.replace("/call/", "");
    seen.push({ endpoint, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : null });
    const a = answers[endpoint];
    if (!a) throw new Error(`unexpected treg call ${endpoint}`);
    return new Response(JSON.stringify(a.body), { status: 200, headers: { "X-Treg-Call-Id": a.callId, "X-Treg-Cost-Micro": String(a.cost) } });
  }) as typeof fetch;
  return { seen, fetchImpl };
}

const contact = { id: "c1", fullName: "Ada Lovelace", title: null, linkedinUrl: "https://www.linkedin.com/in/ada", email: null, phone: null, ownerId: null, accountId: "a1" };
const treg = fakeTreg({
  "treg.people.phone.find": { body: { output: { phone: "+1 415 555 0123" }, _treg: { served_by: "contactout" } }, cost: 30_000, callId: "call_phone" },
  "treg.people.enrich": { body: { output: { full_name: "Ada Lovelace", title: "CTO", linkedin_url: "https://www.linkedin.com/in/ada", company_domain: "acme.example" } }, cost: 8_100, callId: "call_person" },
  "treg.companies.enrich": { body: { output: { name: "Acme", domain: "acme.example", employees: 40 } }, cost: 1_900, callId: "call_company" },
});
const edits: unknown[] = [];
const fakeClient = { mode: "fake", get: async () => ({ account: { id: "a1", domain: "acme.example", name: "Acme" }, contacts: [contact] }), getContact: async () => contact, contractVersion: async () => null };
const Paths = loadConvex(["records.ts", "lib/researchEnrich.ts"], {
  "lib/recordClient.ts": (real) => ({ ...real, recordClient: () => fakeClient }),
  "lib/canon/partyLedger.ts": (real) => ({ ...real, editPartyRecord: async (ports: unknown) => { edits.push(ports); } }),
  "records.ts": (real) => ({ ...real, recordEditPorts: async (_ctx: unknown, _caller: unknown, args: unknown) => args }),
}, { fetch: treg.fetchImpl });

function pathCtx(db: ReturnType<typeof memoryDb>, extra: Record<string, (args: any) => unknown> = {}) {
  const R = Paths["records.ts"];
  const answers: Record<string, (args: any) => unknown> = {
    "internal.records.callerContext": () => ({ orgId: "org", userId: "u1", name: "Ada", role: "admin", access: { userId: "u1", role: "admin", teamOwners: ["u1"], rules: {} } }),
    "internal.records.phoneLookupUsage": (a) => R.phoneLookupUsage.handler({ db }, a),
    "internal.records.recordProviderCall": (a) => R.recordProviderCall.handler({ db }, a),
    "internal.providers.workspaceKeys": () => [],
    "internal.canon.recordHasStream": () => true,
    ...extra,
  };
  const run = async (ref: unknown, args: unknown) => {
    const fn = answers[String(ref)];
    if (!fn) throw new Error(`unexpected call ${String(ref)}`);
    return fn(args);
  };
  return { runQuery: run, runMutation: run, runAction: run };
}

const withEnv = async (env: Record<string, string>, fn: () => Promise<void>) => {
  const old = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try { await fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};
const plain = (x: unknown) => JSON.parse(JSON.stringify(x));
const receipts = (db: ReturnType<typeof memoryDb>) => db.rows("providerCalls").map((r) => ({ provider: r.provider, endpoint: r.endpoint, feature: r.feature, callId: r.callId, costMicro: r.costMicro, outcome: r.outcome }));

test("Find phone looks up what is known on the deployment's treg key, files one find_phone receipt, and writes the hit as found enrichment", async () => {
  await withEnv({ TREG_TOKEN: "t", TREG_PAID_CALLS: "on" }, async () => {
    treg.seen.length = 0; edits.length = 0;
    const db = memoryDb({ providerCalls: [] });
    const out = await Paths["records.ts"].findPhone.handler(pathCtx(db), { accountId: "a1", contactId: "c1" });
    assert.deepEqual(plain(out), { status: "found", phone: "+1 415 555 0123" });
    const [call] = treg.seen;
    assert.deepEqual([treg.seen.length, call.endpoint, call.headers["X-Treg-Token"], call.headers["X-Treg-Meta"], call.headers["X-Treg-Route-Max-Cost"]], [1, "treg.people.phone.find", "t", "customer=org, feature=find_phone", "0.3"]);
    assert.match(call.headers["Idempotency-Key"], /^find-phone:org:c1:\d{4}-\d\d-\d\d$/);
    assert.deepEqual(call.body, { full_name: "Ada Lovelace", domain: "acme.example", linkedin_url: "https://www.linkedin.com/in/ada" });
    assert.deepEqual(plain(receipts(db)), [{ provider: "treg", endpoint: "treg.people.phone.find", feature: "find_phone", callId: "call_phone", costMicro: 30_000, outcome: "hit" }]);
    assert.equal(edits.length, 1);
  });
  await withEnv({ TREG_TOKEN: "" }, async () => {
    await assert.rejects(Paths["records.ts"].findPhone.handler(pathCtx(memoryDb({ providerCalls: [] })), { accountId: "a1", contactId: "c1" }), /Phone lookup is not configured/);
  });
});

test("Research enrichment files one research_enrich receipt a profile and charges credits by what treg charged, only where paid calls are on", async () => {
  const caller = { orgId: "org", userId: "u1", access: { userId: "u1", role: "admin" as const, teamOwners: ["u1"], rules: {} } };
  const E = Paths["lib/researchEnrich.ts"] as unknown as Record<string, (...a: unknown[]) => Promise<any>>;
  const person = { id: "c1", fullName: "Ada Lovelace", linkedinUrl: "https://www.linkedin.com/in/ada", domain: "acme.example" };
  await withEnv({ TREG_TOKEN: "t", TREG_PAID_CALLS: "on" }, async () => {
    treg.seen.length = 0;
    const db = memoryDb({ providerCalls: [] });
    const charged: Array<{ ref: string; amountMicro: number }> = [];
    const ctx = pathCtx(db, {
      "internal.credits.chargeOf": () => null, "internal.credits.balanceOf": () => ({ spendableMicro: 1e12 }), "internal.canon.ensureCustomFields": () => null,
      "internal.credits.charge": (a) => (charged.push({ ref: a.ref, amountMicro: a.amountMicro }), true), "internal.credits.meterCharge": () => null, "internal.researchAgents.savePages": () => null,
    });
    assert.deepEqual(plain(await E.enrichPeople(ctx, caller, [person])), { enriched: 1, note: null });
    assert.equal(await E.enrichCompany(ctx, caller, { id: "a1", domain: "acme.example" }), true);
    assert.deepEqual(treg.seen.map((s) => [s.endpoint, s.headers["X-Treg-Meta"], s.headers["X-Treg-Route-Max-Cost"]]), [["treg.people.enrich", "customer=org, feature=research_enrich", "0.01"], ["treg.companies.enrich", "customer=org, feature=research_enrich", "0.003"]]);
    assert.deepEqual(plain(receipts(db)), [
      { provider: "treg", endpoint: "treg.people.enrich", feature: "research_enrich", callId: "call_person", costMicro: 8_100, outcome: "hit" },
      { provider: "treg", endpoint: "treg.companies.enrich", feature: "research_enrich", callId: "call_company", costMicro: 1_900, outcome: "hit" },
    ]);
    assert.deepEqual(charged.map((c) => [c.ref.split(":").slice(0, 4).join(":"), c.amountMicro]), [["enrich:contact:org:c1", 3_000_000], ["enrich:account:org:a1", 1_000_000]]);
  });
  await withEnv({ TREG_TOKEN: "t", TREG_PAID_CALLS: "off" }, async () => {
    treg.seen.length = 0;
    assert.deepEqual(plain(await E.enrichPeople(pathCtx(memoryDb({})), caller, [person])), { enriched: 0, note: null });
    assert.deepEqual(treg.seen, []);
  });
});
