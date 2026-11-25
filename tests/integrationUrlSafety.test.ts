import assert from "node:assert/strict";
import test from "node:test";
import { createGranolaClient } from "../convex/lib/calls/granola.ts";
import { createEmailBisonClient } from "../convex/lib/outbound/emailbison.ts";
import { postToSlack } from "../convex/lib/agents/slack.ts";
import { deliveryMode } from "../convex/lib/outbound/adapters.ts";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

test("call connections reject private bases and paths that escape before storing or scheduling", async () => {
  const fn = loadConvex(["callProviders.ts"], { "lib/tokenHelpers.ts": r => ({ ...r, encryptForStorage: async (x: string) => x }), "lib.ts": r => ({ ...r, requireUser: async () => ({ _id: "u", orgId: "o", role: "admin" }) }) })["callProviders.ts"];
  for (const provider of ["gong", "chorus", "fathom", "avoma", "granola"]) {
    for (const [instanceUrl, callsPath] of [["http://127.0.0.1:9", "/calls"], ["https://user:pass@api.example.com", "/calls"], ["https://api.example.com", "//private.example/calls"]]) {
      const db = memoryDb({});
      await assert.rejects(fn.connect.handler({ db, scheduler: { runAfter: async () => assert.fail("scheduled unsafe sync") } }, { provider, apiKey: "key", instanceUrl, callsPath }));
      assert.equal(db.rows("integrations").length, 0);
    }
    const db = memoryDb({});
    await fn.connect.handler({ db, scheduler: { runAfter: async () => {} } }, { provider, apiKey: "key", instanceUrl: "https://regional.example.com", callsPath: "/calls" });
    assert.equal(db.rows("integrations").length, 1);
  }
});

test("provider clients refuse private targets before injected HTTP and refuse redirects", async () => {
  let reached = 0;
  const http = (async () => { reached++; return Response.json({ notes: [], data: [] }); }) as typeof fetch;
  await assert.rejects(async () => createGranolaClient({ apiKey: "key", baseUrl: "https://127.0.0.1", fetchImpl: http }).changedNotes("2026-01-01"));
  await assert.rejects(async () => createEmailBisonClient({ apiKey: "key", baseUrl: "https://127.0.0.1", fetchImpl: http }).validate());
  assert.equal(reached, 0);
  const redirect = (async (_url, init) => { assert.equal(init?.redirect, "manual"); return new Response("private contents", { status: 302, headers: { location: "http://127.0.0.1" } }); }) as typeof fetch;
  await assert.rejects(createGranolaClient({ apiKey: "key", fetchImpl: redirect }).changedNotes("2026-01-01"));
  await assert.rejects(createEmailBisonClient({ apiKey: "key", baseUrl: "https://send.example.com", fetchImpl: redirect }).validate());
});

test("Slack rejects stored private URLs and never returns receiver text", async (t) => {
  const before = process.env.CANON_ALLOW_LOOPBACK_WEBHOOKS;
  t.after(() => { if (before === undefined) delete process.env.CANON_ALLOW_LOOPBACK_WEBHOOKS; else process.env.CANON_ALLOW_LOOPBACK_WEBHOOKS = before; });
  delete process.env.CANON_ALLOW_LOOPBACK_WEBHOOKS;
  let reached = false;
  const http = (async () => { reached = true; return new Response("internal secret", { status: 403 }); }) as typeof fetch;
  assert.equal((await postToSlack("http://127.0.0.1/hook", "hi", http)).ok, false);
  assert.equal(reached, false);
  process.env.CANON_ALLOW_LOOPBACK_WEBHOOKS = "true";
  assert.equal(JSON.stringify(await postToSlack("http://127.0.0.1/hook", "hi", http)).includes("internal secret"), false);
});

test("self-host HTTP sends live while every existing local-stack marker sinks", (t) => {
  const keys = ["CONVEX_SITE_URL", "FSGTM_ENABLE_DEMO_DATA", "CANONCRM_LOCAL_STACK", "CANON_AUTH"];
  const before = keys.map(k => process.env[k]);
  t.after(() => keys.forEach((k, i) => { if (before[i] === undefined) delete process.env[k]; else process.env[k] = before[i]; }));
  for (const k of keys) delete process.env[k];
  for (const site of ["http://crm.example.com/convex-site", "http://localhost:3211"]) {
    process.env.CONVEX_SITE_URL = site;
    assert.equal(deliveryMode(), "live");
    process.env.FSGTM_ENABLE_DEMO_DATA = "true";
    assert.equal(deliveryMode(), "sink");
    delete process.env.FSGTM_ENABLE_DEMO_DATA;
    process.env.CANONCRM_LOCAL_STACK = "true";
    process.env.CANON_AUTH = "convex";
    assert.equal(deliveryMode(), "sink");
    delete process.env.CANONCRM_LOCAL_STACK;
  }
});

test("stored call integrations are revalidated and upstream refusal bodies never escape", async () => {
  let status = 200;
  let malformed = false;
  let reached = 0;
  const http = (async () => { reached++; return status === 200 && !malformed ? Response.json({ calls: [] }) : new Response("private-service-secret", { status }); }) as typeof fetch;
  const fn = loadConvex(["callProviderActions.ts"], {
    "lib/tokenHelpers.ts": r => ({ ...r, decryptFromStorage: async () => "key" }),
    "integrationHttp.ts": r => ({ ...r, pinnedIntegrationFetch: () => http }),
  }, { fetch: http })["callProviderActions.ts"];
  let integration = { instanceUrl: "https://127.0.0.1", accessToken: "cipher", isActive: true, syncConfig: { callsPath: "/calls" } };
  const ctx = { runQuery: async () => integration, runMutation: async () => ({ insights: 0, callId: "c" }) };
  await assert.rejects(fn.syncProviderInternal.handler(ctx, { orgId: "o", provider: "gong", trigger: "manual" }));
  assert.equal(reached, 0);
  integration = { ...integration, instanceUrl: "https://regional.example.com" };
  for (const provider of ["gong", "chorus", "fathom"]) {
    assert.equal((await fn.syncProviderInternal.handler(ctx, { orgId: "o", provider, trigger: "manual" })).calls, 0);
    status = 403;
    await assert.rejects(fn.syncProviderInternal.handler(ctx, { orgId: "o", provider, trigger: "manual" }), (e: Error) => !e.message.includes("private-service-secret") && e.message.includes("403"));
    status = 200;
    malformed = true;
    await assert.rejects(fn.syncProviderInternal.handler(ctx, { orgId: "o", provider, trigger: "manual" }), (e: Error) => !/private|secret|Unexpected token/.test(e.message) && e.message.includes("200"));
    malformed = false;
  }
});

test("pinned integration transport rejects all private DNS answers, pins once and refuses redirect hops", async () => {
  const { pinnedIntegrationFetch } = loadConvex(["integrationHttp.ts"])["integrationHttp.ts"] as unknown as typeof import("../convex/integrationHttp.ts");
  for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "::ffff:127.0.0.1", "fc00::1"]) {
    let reached = false;
    const http = pinnedIntegrationFetch({ lookup: async () => [{ address: "8.8.8.8", family: 4 }, { address, family: address.includes(":") ? 6 : 4 }], requestHop: async () => { reached = true; throw new Error("should not connect"); } });
    await assert.rejects(http("https://regional.example.com/calls"));
    assert.equal(reached, false);
  }
  for (const method of ["GET", "POST"]) {
    let resolutions = 0;
    let requests = 0;
    const http = pinnedIntegrationFetch({ lookup: async () => { resolutions++; return [{ address: resolutions === 1 ? "8.8.8.8" : "127.0.0.1", family: 4 }]; }, requestHop: async (_url, addresses) => {
      requests++;
      assert.equal(addresses[0].address, "8.8.8.8");
      return { status: 302, headers: new Headers({ location: "http://127.0.0.1/secret" }), body: new Uint8Array() };
    } });
    assert.equal((await http("https://regional.example.com/calls", { method })).status, 302);
    assert.equal(resolutions, 1);
    assert.equal(requests, 1);
  }
});

test("Slack connect and channel mapping require explicit loopback permission on a self-host", async (t) => {
  const keys = ["CONVEX_SITE_URL", "CANON_ALLOW_LOOPBACK_WEBHOOKS"];
  const before = keys.map(k => process.env[k]);
  t.after(() => keys.forEach((k, i) => { if (before[i] === undefined) delete process.env[k]; else process.env[k] = before[i]; }));
  process.env.CONVEX_SITE_URL = "http://localhost:3211";
  delete process.env.CANON_ALLOW_LOOPBACK_WEBHOOKS;
  const fn = loadConvex(["agentSlack.ts", "outbound.ts"], { "lib.ts": r => ({ ...r, requireUser: async () => ({ _id: "u", orgId: "o", role: "admin" }) }) });
  const ctx = { runQuery: async () => ({ userId: "u", orgId: "o", role: "admin" }), runMutation: async () => null, db: memoryDb({}) };
  const url = "http://127.0.0.1:9/hook";
  await assert.rejects(fn["agentSlack.ts"].connect.handler(ctx, { url }));
  await assert.rejects(fn["outbound.ts"].mapSlack.handler(ctx, { name: "team", url }));
  process.env.CANON_ALLOW_LOOPBACK_WEBHOOKS = "true";
  assert.equal((await fn["agentSlack.ts"].connect.handler(ctx, { url })).ok, true);
});

test("configured HTTP self-host sends all outbox channels, local-stack markers sink all of them", async (t) => {
  const { sendSlack, sendWebhook, sendPostmark } = await import("../convex/lib/outbound/adapters.ts");
  const keys = ["CONVEX_SITE_URL", "CANONCRM_LOCAL_STACK", "FSGTM_ENABLE_DEMO_DATA", "POSTMARK_SERVER_TOKEN", "POSTMARK_FROM_ADDRESS"];
  const before = keys.map(k => process.env[k]);
  t.after(() => keys.forEach((k, i) => { if (before[i] === undefined) delete process.env[k]; else process.env[k] = before[i]; }));
  Object.assign(process.env, { CONVEX_SITE_URL: "http://localhost:3211", POSTMARK_SERVER_TOKEN: "fake-token", POSTMARK_FROM_ADDRESS: "notices@example.com" });
  delete process.env.CANONCRM_LOCAL_STACK;
  delete process.env.FSGTM_ENABLE_DEMO_DATA;
  let requests = 0;
  const http = (async () => { requests++; return Response.json({ MessageID: "receipt" }); }) as typeof fetch;
  const post = async () => { requests++; return { ok: true as const, status: 200 }; };
  const send = async () => [await sendSlack("https://hooks.slack.com/services/T/B/key", "hi", http), await sendWebhook({ url: "https://receiver.example.com/hook", secret: "secret", body: "{}", id: "row" }, post), await sendPostmark({ to: "a@example.com", subject: "hi", text: "hi" }, http)];
  assert.deepEqual((await send()).map(r => r.ok && r.providerId), ["slack", "http-200", "receipt"]);
  assert.equal(requests, 3);
  for (const marker of ["FSGTM_ENABLE_DEMO_DATA", "CANONCRM_LOCAL_STACK"]) {
    process.env[marker] = "true";
    assert.deepEqual((await send()).map(r => r.ok && r.providerId), ["local", "local", "local"]);
    delete process.env[marker];
  }
  assert.equal(requests, 3);
});

test("Slack timeouts retain unknown delivery across the Node action boundary", async (t) => {
  const keys = ["CONVEX_SITE_URL", "FSGTM_ENABLE_DEMO_DATA", "CANONCRM_LOCAL_STACK"];
  const before = keys.map(k => process.env[k]);
  t.after(() => keys.forEach((k, i) => { if (before[i] === undefined) delete process.env[k]; else process.env[k] = before[i]; }));
  keys.forEach(k => delete process.env[k]);
  process.env.CONVEX_SITE_URL = "http://localhost:3211";
  const { integrationFetch } = loadConvex(["lib/integrationHttp.ts"], {}, { Error })["lib/integrationHttp.ts"] as unknown as typeof import("../convex/lib/integrationHttp.ts");
  const { sendSlack } = await import("../convex/lib/outbound/adapters.ts");
  const http = integrationFetch({ runAction: async (_ref: unknown, args: { timeoutMs: number }) => {
    assert.equal(args.timeoutMs, 8000);
    return { ok: false, error: "timeout" };
  } } as never, 8000);
  const result = await sendSlack("https://hooks.slack.com/services/T/B/key", "hi", http);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.unknown, true);
});

test("malformed successful provider responses never disclose body text in parse errors", async () => {
  const { fetchAvomaCalls } = await import("../convex/lib/calls/avoma.ts");
  const { nullProgressEmitter } = await import("../engine/src/progress.ts");
  const fetchImpl = (async () => new Response("private-service-secret", { status: 200 })) as typeof fetch;
  const safe = (e: Error) => !/private|secret|Unexpected token/.test(e.message) && e.message.includes("200");
  await assert.rejects(createGranolaClient({ apiKey: "key", fetchImpl }).changedNotes("2026-01-01"), safe);
  await assert.rejects(fetchAvomaCalls({ apiKey: "key", baseUrl: "https://regional.example.com/v1", callsPath: "/meetings/", progress: nullProgressEmitter(), fetchImpl }), safe);
});
