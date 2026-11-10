import assert from "node:assert/strict";
import test from "node:test";
import {
  parseQuickEnrichResult,
  quickEnrichInput,
  quickEnrichResolve,
  QuickEnrichMissingKeyError,
} from "../engine/src/connectors/quickenrich.ts";
import { createQuickEnrichAdapter, runContactWaterfall, type ContactProviderAdapter } from "../engine/src/contactProviders.ts";

function mockFetch(handler: (body: Record<string, unknown>) => { status: number; json?: unknown }) {
  const calls: Array<{ url: string; body: Record<string, unknown>; auth: string | null }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ url, body, auth: new Headers(init.headers).get("authorization") });
    const { status, json } = handler(body);
    return new Response(JSON.stringify(json ?? {}), { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test("quickenrich fails fast with a clear missing-key error and makes no request", async () => {
  const { impl, calls } = mockFetch(() => ({ status: 200 }));
  const saved = process.env.QUICKENRICH_API_KEY;
  delete process.env.QUICKENRICH_API_KEY;
  try {
    await assert.rejects(
      quickEnrichResolve([{ fullName: "Ada Lovelace", companyDomain: "acme.test" }], { fetchImpl: impl }),
      (error: unknown) => error instanceof QuickEnrichMissingKeyError && /QUICKENRICH_API_KEY/.test((error as Error).message),
    );
  } finally {
    if (saved !== undefined) process.env.QUICKENRICH_API_KEY = saved;
  }
  assert.equal(calls.length, 0);
});

test("quickenrich resolves emails/mobiles index-aligned and skips unidentifiable prospects", async () => {
  const { impl, calls } = mockFetch((body) => {
    if (body.linkedin_url) return { status: 200, json: { data: { email: "GRACE@NAVY.TEST", mobile: "+1 555 010 9999" } } };
    if (body.full_name === "Nobody Found") return { status: 404 };
    return { status: 200, json: { email: "ada@acme.test", email_status: "valid" } };
  });
  const out = await quickEnrichResolve(
    [
      { fullName: "Ada Lovelace", firstName: "Ada", lastName: "Lovelace", companyDomain: "acme.test" },
      { fullName: "No Company" },
      { linkedin: "https://linkedin.com/in/grace", companyDomain: "navy.test" },
      { fullName: "Nobody Found", companyDomain: "acme.test" },
    ],
    { apiKey: "qe_test", fetchImpl: impl, concurrency: 2 },
  );
  assert.equal(out.length, 4);
  assert.equal(out[0].email, "ada@acme.test");
  assert.equal(out[1].email, undefined);
  assert.equal(out[2].email, "grace@navy.test");
  assert.equal(out[2].mobile, "+1 555 010 9999");
  assert.equal(out[3].email, undefined);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.auth === "Bearer qe_test"));
});

test("quickenrich surfaces auth failures as provider errors", async () => {
  const { impl } = mockFetch(() => ({ status: 401 }));
  await assert.rejects(
    quickEnrichResolve([{ fullName: "Ada Lovelace", companyDomain: "acme.test" }], { apiKey: "bad", fetchImpl: impl }),
    /quickenrich person enrich failed: HTTP 401/,
  );
});

test("quickenrich parser rejects invalid emails and short phones", () => {
  assert.deepEqual(parseQuickEnrichResult({ email: "not-an-email", phone: "123" }), { email: undefined, mobile: undefined });
  assert.deepEqual(parseQuickEnrichResult({ result: { work_email: "x@y.test", status: "invalid" } }), { email: undefined, mobile: undefined });
  assert.equal(quickEnrichInput({ fullName: "Solo" }), null);
});

test("quickenrich runs as a waterfall step after pipe0 for records still missing email", async () => {
  const { impl, calls } = mockFetch(() => ({ status: 200, json: { email: "late@acme.test" } }));
  const pipe0: ContactProviderAdapter = {
    provider: "pipe0",
    resolve: async (prospects) => prospects.map((p, i) => (i === 0 ? { ...p, email: "first@acme.test" } : p)),
  };
  const result = await runContactWaterfall({
    prospects: [
      { fullName: "One", companyDomain: "acme.test" },
      { fullName: "Two", companyDomain: "acme.test" },
    ],
    steps: [
      { provider: "pipe0", fields: ["work_email"] },
      { provider: "quickenrich", fields: ["work_email"] },
    ],
    adapters: { pipe0, quickenrich: createQuickEnrichAdapter({ apiKey: "qe_test", fetchImpl: impl }) },
  });
  assert.equal(result.prospects[0].email, "first@acme.test");
  assert.equal(result.prospects[1].email, "late@acme.test");
  assert.equal(calls.length, 1);
  assert.deepEqual(result.attempts.map((a) => [a.provider, a.attempted]), [["pipe0", 2], ["quickenrich", 1]]);
});
