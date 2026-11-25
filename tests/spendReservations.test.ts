import assert from "node:assert/strict";
import test from "node:test";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const user = { _id: "rep", orgId: "org", role: "other" };
const files = loadConvex(["records.ts", "icps.ts", "companyWebFacts.ts", "dialer.ts"], {
  "lib.ts": (r) => ({ ...r, requireUser: async () => user }),
  "lib/dialer/hours.ts": (r) => ({ ...r, callingHoursProblem: () => null }),
  "lib/suppressions/store.ts": (r) => ({ ...r, callerOutreachPurpose: async () => "manual", suppressionFor: async () => ({ voice: { blocked: false } }) }),
  "lib/recordingPolicy.ts": (r) => ({ ...r, readPolicy: async () => ({ callRecording: false }) }),
  "permissions.ts": (r) => ({ ...r, requireWriteAccess: async () => ({ role: user.role, rules: { contact: { edit: user.role === "rep" } } }) }),
}, { process: { env: { TELNYX_API_KEY: "fake", TELNYX_CONNECTION_ID: "fake" } } });
function context(tables = {}) {
  const db = memoryDb(tables);
  const scheduled: unknown[] = [];
  return { db, scheduled, scheduler: { runAfter: async (...args: unknown[]) => { scheduled.push(args); } } };
}

test("a viewer cannot start a dialer session before any provider work", async () => {
  const ctx = context({ dialerNumbers: [{ _id: "number", orgId: "org", number: "+14155550999" }] });
  await assert.rejects(files["dialer.ts"].startSession.handler(ctx, { agentPhone: "+14155550123" }));
  assert.equal(ctx.scheduled.length, 0);
});

test("ICP derivations refuse a full workspace before spending and cap daily reservations", async () => {
  const full = context({ icps: Array.from({ length: 25 }, (_, i) => ({ _id: `i${i}`, orgId: "org" })) });
  await assert.rejects(files["icps.ts"].reserveDerivation.handler(full, { orgId: "org" }));
  const ctx = context();
  for (let i = 0; i < 20; i++) await files["icps.ts"].reserveDerivation.handler(ctx, { orgId: "org" });
  await assert.rejects(files["icps.ts"].reserveDerivation.handler(ctx, { orgId: "org" }));
});

test("website extraction stops quietly at its daily cap and cached reads consume nothing", async () => {
  const ctx = context();
  const read = (domain: string) => files["companyWebFacts.ts"].readAndEnsure.handler(ctx, { orgId: "org", domain, refresh: true });
  for (let i = 0; i < 100; i++) assert.equal((await read(`company${i}.com`)).reading, true);
  assert.equal((await read("company0.com")).reading, true);
  const denied = await read("over.com");
  assert.equal(denied.limitReached, true);
  assert.equal(denied.reading, false);
  assert.equal(ctx.scheduled.length, 200);
  const marker = ctx.db.rows("companyWebFactReads").find((r) => r.domain === "company0.com")!;
  await files["companyWebFacts.ts"].finish.handler(ctx, { startedAt: marker.startedAt, facts: { domain: "company0.com", status: "ok", fetchedAt: Date.now(), sizeCluesVersion: 1, pages: [], socials: [], addresses: [], emails: [], staff: [] } });
  const cached = await read("company0.com");
  assert.equal(cached.reading, false);
  assert.equal(cached.facts.status, "ok");
  await ctx.db.patch(ctx.db.rows("companyWebFacts")[0]._id, { fetchedAt: 0 });
  const stale = await read("company0.com");
  assert.equal(stale.limitReached, true);
  assert.equal(stale.facts.status, "ok");
  assert.equal(ctx.scheduled.length, 200);
});

test("phone reservations include pending hits and a miss refunds its monthly slot only once", async () => {
  const ctx = context();
  const reserve = () => files["records.ts"].reservePhoneLookup.handler(ctx, { orgId: "org" });
  const reservations: Array<{ reservationId: string }> = [];
  for (let i = 0; i < 50; i++) reservations.push(await reserve());
  assert.equal((await reserve()).limit, "daily");
  const finish = () => files["records.ts"].settlePaidLookup.handler(ctx, { reservationId: reservations[0].reservationId, hit: false });
  await finish(); await finish();
  const month = ctx.db.rows("moduleRateLimits").find((r) => String(r.key).startsWith("lookup:month:"));
  assert.equal(month?.count, 49);
});


test("a rep starts phone and browser sessions, places calls, and stops at the daily caps", async () => {
  user.role = "rep";
  try {
    const ctx = context({ users: [user], dialerNumbers: [{ _id: "number", orgId: "org", number: "+14155550999" }], dialerCredentials: [{ _id: "cred", userId: "rep", orgId: "org", sipUsername: "sip-rep" }] });
    const start = (audio = "phone") => files["dialer.ts"].startSession.handler(ctx, { agentPhone: "+14155550123", audio });
    let sessionId;
    for (let i = 0; i < 20; i++) {
      sessionId = await start(i === 0 ? "browser" : "phone");
      if (i === 0) assert.match(String((await ctx.db.get(sessionId))?.agentPhone), /sip-rep/);
      await ctx.db.patch(sessionId, { status: "ended" });
    }
    await assert.rejects(start(), /limit/i);
    await ctx.db.patch(sessionId!, { status: "ready", agentLegId: "agent" });
    for (let i = 0; i < 300; i++) {
      const call = await files["dialer.ts"].claimCall.handler(ctx, { userId: "rep", orgId: "org", contactId: `c${i}`, contactName: "Ada", to: "+14155550124" });
      assert.ok(call.callId);
      await ctx.db.patch(sessionId!, { currentCallId: undefined });
    }
    await assert.rejects(files["dialer.ts"].claimCall.handler(ctx, { userId: "rep", orgId: "org", contactId: "over", contactName: "Ada", to: "+14155550124" }), /limit/i);
    assert.equal(ctx.db.rows("dialerCalls").length, 300);
  } finally { user.role = "other"; }
});

test("website derivation checks ICP capacity and reserves before parallel model calls with either credential source", async () => {
  let connected = false;
  const attempts: Array<{ llm?: unknown; apiKey?: string }> = [];
  const actions = loadConvex(["icpActions.ts"], {
    "lib/llmResolver.ts": (r) => ({ ...r, resolveLlm: async () => connected ? { provider: "chatgpt" } : null }),
    "../engine/src/icpDerive.ts": (r) => ({ ...r, deriveWebsiteIcp: async (args: { llm?: unknown; apiKey?: string }) => { attempts.push(args); return { company: { name: "Acme" }, icp: {} }; } }),
    "lib/icps.ts": (r) => ({ ...r, specFromIcp: () => ({}) }),
  }, { process: { env: { OPENROUTER_API_KEY: "fake", CANONCRM_LOCAL_STACK: "true", CI: "true", NODE_ENV: "test" } } });
  for (connected of [false, true]) {
    attempts.length = 0;
    const ctx = context();
    // The test DB has no OCC. Serialize mutations as Convex's transaction retries do.
    let transaction = Promise.resolve<unknown>(null);
    const actionCtx = { runQuery: async () => ({ orgId: "org", userId: "rep" }), runMutation: (ref: unknown, args: unknown) => {
      const result = transaction.then(() => String(ref).endsWith("reserveDerivation") ? files["icps.ts"].reserveDerivation.handler(ctx, args) : "icp");
      transaction = result.catch(() => null);
      return result;
    } };
    const outcomes = await Promise.allSettled(Array.from({ length: 25 }, () => actions["icpActions.ts"].deriveFromWebsite.handler(actionCtx, { domain: "acme.example" })));
    assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 20);
    assert.equal(attempts.length, 20);
    assert.equal(Boolean(attempts[0].llm), connected);
    assert.equal(attempts[0].apiKey, connected ? undefined : "fake");
    attempts.length = 0;
    for (let i = 0; i < 25; i++) await ctx.db.insert("icps", { orgId: "org" });
    await assert.rejects(actions["icpActions.ts"].deriveFromWebsite.handler(actionCtx, { domain: "full.example" }));
    assert.equal(attempts.length, 0);
  }
});

test("parallel hosted email finders reserve the final monthly hit before spending", async () => {
  let providerCalls = 0;
  const email = loadConvex(["lib/providers/emailFind.ts"], {
    "lib/emailFinder.ts": (r) => ({ ...r, findVerifiedWorkEmail: async (opts: { allowPaidFinder(): Promise<boolean>; receipt(endpoint: string, receipt: unknown, hit: boolean): Promise<void> }) => {
      await opts.allowPaidFinder();
      providerCalls++;
      await opts.receipt("hunter.people.email.find", { status: 200 }, true);
      return { email: "a@example.com", provider: "treg:hunter", paid: true };
    } }),
  }, { process: { env: { TREG_TOKEN: "fake" } } });
  const now = new Date();
  const month = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const ctx = context({ providerCalls: Array.from({ length: 99 }, (_, i) => ({ _id: `email${i}`, orgId: "org", endpoint: "hunter.people.email.find", outcome: "hit", at: now.getTime() })) });
  let transaction = Promise.resolve<unknown>(null);
  const ports = {
    runQuery: async (ref: unknown, args: unknown) => String(ref).endsWith("paidEmailHitsThisMonth") ? files["records.ts"].paidEmailHitsThisMonth.handler(ctx, args) : String(ref).endsWith("workspaceKeys") ? [] : null,
    runMutation: (ref: unknown, args: unknown) => {
      const name = String(ref).split(".").at(-1)!;
      const result = transaction.then(() => files["records.ts"][name].handler(ctx, args));
      transaction = result.catch(() => null);
      return result;
    },
  };
  const find = email["lib/providers/emailFind.ts"].findWorkEmail as unknown as (ctx: unknown, args: unknown) => Promise<unknown>;
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => find(ports, { orgId: "org", fullName: "Ada Lovelace", domain: "example.com" })));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(providerCalls, 1);
  assert.equal(ctx.db.rows("moduleRateLimits").find((r) => r.key === `lookup:month:hunter.people.email.find:org:${month}`)?.count, 100);
});

test("phone monthly reservations include in-flight hits and settle only once", async () => {
  const now = new Date(), month = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const ctx = context({ moduleRateLimits: [{ _id: "pending", key: `lookup:month:treg.people.phone.find:org:${month}`, count: 49, windowStart: month, expiresAt: month + 40 * 86_400_000 }] });
  const reserve = () => files["records.ts"].reservePhoneLookup.handler(ctx, { orgId: "org" });
  const slot = await reserve();
  assert.ok(slot.reservationId);
  assert.equal((await reserve()).limit, "monthly");
  await files["records.ts"].settlePaidLookup.handler(ctx, { reservationId: slot.reservationId, hit: true });
  await files["records.ts"].settlePaidLookup.handler(ctx, { reservationId: slot.reservationId, hit: false });
  assert.equal((await reserve()).limit, "monthly");
});

test("all dialer claims refuse read-only members and workspace session caps apply across reps", async () => {
  const ctx = context({ users: [user] });
  for (const claim of ["claimCall", "claimRace"]) await assert.rejects(files["dialer.ts"][claim].handler(ctx, { userId: "rep", orgId: "org", entries: [] }), /role/i);
  user.role = "rep";
  try {
    const day = Math.floor(Date.now() / 86_400_000) * 86_400_000;
    const capped = context({ dialerNumbers: [{ _id: "number", orgId: "org", number: "+14155550999" }], moduleRateLimits: [{ _id: "orgcap", key: "dialer:sessions:org:org", windowStart: day, count: 100, expiresAt: day + 86_400_000 }] });
    await assert.rejects(files["dialer.ts"].startSession.handler(capped, { agentPhone: "+14155550123" }), /limit/i);
    assert.equal(capped.scheduled.length, 0);
  } finally { user.role = "other"; }
});

test("module-owned ICP definitions refuse derivation before consuming any allowance", async () => {
  const ctx = context({ moduleInterfaceOwners: [{ _id: "owner", orgId: "org", moduleId: "@canon/icps" }] });
  await assert.rejects(files["icps.ts"].reserveDerivation.handler(ctx, { orgId: "org" }));
  assert.equal(ctx.db.rows("moduleRateLimits").length, 0);
});
