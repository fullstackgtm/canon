import assert from "node:assert/strict";
import test from "node:test";
import { createDeeplineClient, DeeplineError } from "../convex/lib/deepline.ts";

const KEY = "dl_live_secret_key_123";
const person = { fullName: "Ada Lovelace", domain: "acme.example" };

/** Deepline over a fake HTTP layer: `start` answers the play's run, each `polls` entry one GET of the run. */
function fakeDeepline(start: { status: number; body?: unknown }, polls: unknown[] = []) {
  const requests: Array<{ method: string; url: string; body: { input?: unknown } | null }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    assert.equal((init.headers as Record<string, string>).Authorization, `Bearer ${KEY}`);
    requests.push({ method: init.method ?? "GET", url, body: init.body ? JSON.parse(String(init.body)) : null });
    if (init.method === "POST") return new Response(JSON.stringify(start.body ?? { error: "nope", key: KEY }), { status: start.status });
    const next = polls.shift() ?? { status: "running" };
    return new Response(JSON.stringify(next), { status: 200 });
  }) as typeof fetch;
  let clock = 0;
  const client = createDeeplineClient({ apiKey: KEY, fetchImpl, sleep: async (ms) => { clock += ms; }, now: () => clock });
  return { client, requests };
}

test("a waterfall run that completes returns its email, after polling the run", async () => {
  const { client, requests } = fakeDeepline({ status: 200, body: { workflowId: "wf/1", status: "queued" } }, [
    { status: "running" },
    { status: "completed", result: { email: "Ada@Acme.example", email_status: "valid" }, billing: { credits: 2 } },
  ]);
  const r = await client.findWorkEmail(person);
  assert.deepEqual(r, { email: "ada@acme.example", status: "valid", runId: "wf/1", costCredits: 2 });
  assert.deepEqual(requests[0]!.body?.input, { first_name: "Ada", last_name: "Lovelace", domain: "acme.example" });
  assert.ok(requests.slice(1).every((q) => q.url.includes("/api/v2/runs/wf%2F1")));
});

test("an invalid email is not found", async () => {
  const { client } = fakeDeepline({ status: 200, body: { workflowId: "w", status: "completed", result: { email: "ada@acme.example", email_status: "invalid" } } });
  assert.equal((await client.findWorkEmail(person)).email, null);
});

test("a run still going past the budget is a timeout miss", async () => {
  const { client, requests } = fakeDeepline({ status: 200, body: { workflowId: "w", status: "running" } });
  const r = await client.findWorkEmail(person);
  assert.equal(r.status, "timeout");
  assert.equal(r.email, null);
  assert.ok(requests.length > 2 && requests.length < 20);
});

test("a request that stalls is cut off at the budget and is a timeout miss", async () => {
  const hang = ((_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch;
  const r = await createDeeplineClient({ apiKey: KEY, fetchImpl: hang, budgetMs: 20 }).findWorkEmail(person);
  assert.deepEqual(r, { email: null, status: "timeout", runId: null });
});

test("a refused key throws a DeeplineError that carries neither the key nor the body", async () => {
  const { client } = fakeDeepline({ status: 401 });
  const err = await client.findWorkEmail(person).then(() => null, (e: unknown) => e);
  assert.ok(err instanceof DeeplineError);
  assert.equal(err.status, 401);
  assert.ok(!err.message.includes(KEY) && !err.message.includes("nope"));
});
