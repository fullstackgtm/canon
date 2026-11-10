import assert from "node:assert/strict";
import test from "node:test";
import {
  BudgetExhausted, admission, eventKeyOf, findAccount, signWebhook, subjectOf, turnMeter, verifyWebhook,
} from "../convex/lib/agents/webhook.ts";
import { researchCompany, type AgentSpec } from "../convex/lib/research/agentLoop.ts";
import { createFakeRecordClient, createMemoryRecordStore } from "../convex/lib/recordClient.ts";

const NOW = 1_800_000_000_000;

test("webhook signature: only a fresh HMAC over the exact body is accepted", async () => {
  const body = '{"email":"jane@acme.example"}';
  const ts = String(NOW / 1000);
  const signature = await signWebhook("whsec_test", ts, body);
  const check = (o: Partial<Parameters<typeof verifyWebhook>[0]>) =>
    verifyWebhook({ secret: "whsec_test", body, timestamp: ts, signature, nowMs: NOW, ...o }).then((v) => (v.ok ? "ok" : v.reason));
  assert.equal(await check({}), "ok");
  assert.equal(await check({ signature: null }), "unsigned");
  assert.equal(await check({ nowMs: NOW + 301_000 }), "stale");
  assert.equal(await check({ body: '{"email":"evil@acme.example"}' }), "bad_signature");
  assert.equal(await check({ secret: "whsec_other" }), "bad_signature");
});

test("idempotency: a redelivered event has the same key; the sender's id in the signed body wins over the body hash", async () => {
  const body = '{"id":"evt_1","domain":"acme.example"}';
  assert.equal(await eventKeyOf(JSON.parse(body), body), "id:evt_1");
  assert.equal(await eventKeyOf({ event_id: "evt_1", at: 2 }, '{"event_id":"evt_1","at":2}'), "id:evt_1");
  const anon = '{"domain":"acme.example"}';
  const k = await eventKeyOf(JSON.parse(anon), anon);
  assert.match(k, /^sha256:/);
  assert.equal(await eventKeyOf(JSON.parse(anon), anon), k);
  assert.notEqual(await eventKeyOf({}, '{"domain":"acme.example" }'), k);
});

test("budget: over the daily cap the event is skipped; in a turn, the call that would cross the token budget never happens", async () => {
  const base = { standingMessage: null, fieldCount: 1, turnsPerDay: 3, subject: subjectOf({ contact: { email: "jane@acme.example" } }), ownerConnected: true };
  assert.deepEqual(admission({ ...base, admittedToday: 2 }), { run: true });
  assert.equal((admission({ ...base, admittedToday: 3 }) as { reason: string }).reason, "daily_cap");

  const spec: AgentSpec = { label: "Trial", kind: "qa", question: "Does it offer a free trial?", answerType: "boolean" };
  const home = { url: "https://acme.example/", text: "Acme. Start your free trial today. ".repeat(40), links: [{ href: "https://acme.example/pricing", text: "Pricing" }] };
  const meter = turnMeter({ maxTokens: 1500, maxSeconds: 60 }, NOW, () => NOW);
  let made = 0;
  const call = async (prompt: string) => { meter.charge(prompt); made++; return { action: "read", urls: ["https://acme.example/pricing"] }; };
  const fetchPage = async () => ({ url: "https://acme.example/pricing", text: "Pricing. ".repeat(400), links: [] });
  await assert.rejects(researchCompany(spec, { name: "Acme", domain: "acme.example" }, { fetchPage, call, homepage: home }), (e) => e instanceof BudgetExhausted && e.limit === "tokens");
  assert.equal(made, 1);
  assert.equal(meter.spent.modelCalls, 1);
});

test("tenant scoping: an event resolves only accounts in the agent's own workspace", async () => {
  const client = createFakeRecordClient({ store: createMemoryRecordStore(), now: () => 1_000 });
  await client.upsertAccounts("orgA", { records: [{ domain: "acme.example", name: "Acme" }], source: "pdl", idempotencyKey: "a" });
  await client.upsertAccounts("orgB", { records: [{ domain: "globex.example", name: "Globex" }], source: "pdl", idempotencyKey: "b" });
  assert.equal(await findAccount(client, "orgA", "globex.example"), null);
  assert.equal((await findAccount(client, "orgB", "globex.example"))?.name, "Globex");
  assert.equal((await findAccount(client, "orgA", subjectOf({ website: "https://www.Acme.example/demo" }).domain!))?.name, "Acme");

  // The exact account can sit behind a full page of accounts that merely contain the domain: the search follows the pages.
  const row = (domain: string) => ({ id: domain, domain, name: domain }) as never;
  const pages = [Array.from({ length: 200 }, (_, i) => row(`a${i}.acme.example`)), [row("acme.example")]];
  const paged = { list: async (_ws: string, req: { cursor?: string }) => {
    const n = Number(req.cursor ?? 0);
    return { rows: pages[n], nextCursor: n + 1 < pages.length ? String(n + 1) : null, total: 201 };
  } };
  assert.equal((await findAccount(paged, "orgA", "acme.example"))?.domain, "acme.example");
});
