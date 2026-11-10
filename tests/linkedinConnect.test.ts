import assert from "node:assert/strict";
import test from "node:test";
import {
  HARD_CEILING, NEW_ACCOUNT, RECOMMENDED, RAMP_STEPS,
  effectiveLimits, healthOf, inWindow, isLightDay, localDayStart, nextGapMs, nextRampStep, remaining, validateOverrides,
  DEFAULT_WINDOW, MIN_GAP_MS, estimateInviteTimes, nextInviteSlot, type AccountShape,
} from "../convex/lib/linkedin/limits.ts";
import { signState, verifyState, webhookToken, webhookTokenMatches } from "../convex/lib/linkedin/state.ts";
import { accountOf, accountStatusEvent, createUnipileClient, statusFromUnipile, UnipileError } from "../convex/lib/linkedin/unipile.ts";

const healthy = healthOf({ sent: 0, accepted: 0 }, 0);
const account = (over: Partial<AccountShape> = {}): AccountShape => ({ tier: "premium", rampStep: RAMP_STEPS, overrides: {}, connectionCount: 900, ...over });

test("caps ramp from the new-account column to the recommendation, never past the user's own target or the ceiling", () => {
  assert.deepEqual(effectiveLimits(account({ rampStep: 0 }), healthy), NEW_ACCOUNT);
  assert.deepEqual(effectiveLimits(account(), healthy), RECOMMENDED);
  assert.equal(effectiveLimits(account({ rampStep: 2 }), healthy).invitesPerDay, 9); // 5 + 10 * 2/5
  assert.equal(effectiveLimits(account({ overrides: { invitesPerDay: 3 }, rampStep: 0 }), healthy).invitesPerDay, 3);
  assert.equal(effectiveLimits(account({ overrides: { invitesPerDay: 999 } }), healthy).invitesPerDay, HARD_CEILING.invitesPerDay);
  assert.equal(effectiveLimits(account({ connectionCount: 80 }), healthy).invitesPerDay, 10);
  assert.equal(effectiveLimits(account(), healthy, true).invitesPerDay, 7);
});

test("health halves caps on low acceptance, pauses invites below the floor or with too many pending", () => {
  assert.equal(healthOf({ sent: 10, accepted: 0 }, 0).invitePause, null); // too few to judge
  assert.equal(healthOf({ sent: 40, accepted: 8 }, 0).factor, 0.5);
  assert.match(healthOf({ sent: 40, accepted: 4 }, 0).invitePause ?? "", /10% of invites/);
  assert.match(healthOf({ sent: 0, accepted: 0 }, 401).invitePause ?? "", /401 invites are pending/);
  const paused = effectiveLimits(account(), healthOf({ sent: 40, accepted: 4 }, 0));
  assert.equal(paused.invitesPerDay, 0);
  assert.equal(paused.messagesPerDay, RECOMMENDED.messagesPerDay);
  assert.equal(nextRampStep(2, { sent: 40, accepted: 8 }), 2);
  assert.equal(nextRampStep(2, { sent: 40, accepted: 20 }), 3);
});

test("remaining budget takes the tighter of the daily and weekly invite caps", () => {
  const usage = { invitesToday: 4, invitesWeek: 78, messagesToday: 31, lookupsToday: 0 };
  assert.equal(remaining(RECOMMENDED, usage, "invite"), 2);
  assert.equal(remaining(RECOMMENDED, usage, "message"), 0);
});

test("overrides: whole numbers up to the ceiling, above the recommendation only for admins", () => {
  assert.equal(validateOverrides({ invitesPerDay: 10 }, { tier: "premium", isAdmin: false }), null);
  assert.match(validateOverrides({ invitesPerDay: 20 }, { tier: "premium", isAdmin: false }) ?? "", /Only an admin/);
  assert.equal(validateOverrides({ invitesPerDay: 20 }, { tier: "premium", isAdmin: true }), null);
  assert.match(validateOverrides({ invitesPerWeek: 180 }, { tier: "sales_navigator", isAdmin: true }) ?? "", /above 150/);
  assert.equal(validateOverrides({ invitesPerWeek: 180 }, { tier: "sales_navigator", salesNavHighVolume: true, isAdmin: true }), null);
  assert.match(validateOverrides({ invitesPerDay: 1.5 }, { tier: "premium", isAdmin: true }) ?? "", /whole number/);
});

test("window and day boundaries follow the sender's timezone, across a DST change", () => {
  const tue9amNY = Date.parse("2026-10-06T13:00:00Z");
  assert.equal(inWindow(tue9amNY, DEFAULT_WINDOW, "America/New_York"), true);
  assert.equal(inWindow(tue9amNY, DEFAULT_WINDOW, "Asia/Tokyo"), false); // 22:00 there
  assert.equal(inWindow(Date.parse("2026-10-10T15:00:00Z"), DEFAULT_WINDOW, "America/New_York"), false); // Saturday
  assert.equal(localDayStart(tue9amNY + 1234, "America/New_York"), Date.parse("2026-10-06T04:00:00Z"));
  // 2026-11-01 is the US fall-back day: local midnight is 04:00Z, noon is 17:00Z.
  assert.equal(localDayStart(Date.parse("2026-11-01T17:00:00Z"), "America/New_York"), Date.parse("2026-11-01T04:00:00Z"));
  const light = Array.from({ length: 1000 }, (_, i) => isLightDay("acct", `d${i}`)).filter(Boolean).length;
  assert.ok(light > 60 && light < 140, `light days ${light}`);
  assert.equal(nextGapMs(0), 45_000);
  assert.equal(nextGapMs(1), 180_000);
});

test("connect state is signed, bound to its key and expires; the webhook token matches only its key", async () => {
  const state = { userId: "u1", orgId: "o1", riskAcceptedAt: 1, riskTextVersion: "v", timezone: "Europe/Paris", expiresAt: 10_000 };
  const token = await signState("key-a", state);
  assert.deepEqual(await verifyState("key-a", token, 5_000), state);
  assert.equal(await verifyState("key-b", token, 5_000), null);
  assert.equal(await verifyState("key-a", token, 20_000), null);
  const [body, sig] = token.split(".");
  assert.equal(await verifyState("key-a", `${body}x.${sig}`, 5_000), null);
  assert.equal(await webhookTokenMatches("key-a", await webhookToken("key-a")), true);
  assert.equal(await webhookTokenMatches("key-a", await webhookToken("key-b")), false);
});

test("Unipile: hosted link request, account parsing, errors without bodies, status mapping", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/hosted/accounts/link")) return Response.json({ object: "HostedAuthUrl", url: "https://account.unipile.com/x" }, { status: 201 });
    if (url.endsWith("/accounts/gone")) return Response.json({ type: "errors/resource_not_found", detail: "secret detail" }, { status: 404 });
    return Response.json({ type: "errors/invalid_credentials", detail: "secret detail" }, { status: 401 });
  }) as typeof fetch;
  const client = createUnipileClient({ apiKey: "uk", dsn: "api9.unipile.com:13911", fetchImpl });
  const url = await client.hostedLink({ name: "state", notifyUrl: "n", successUrl: "s", failureUrl: "f", expiresAt: new Date(0), reconnectAccountId: "acc" });
  assert.equal(url, "https://account.unipile.com/x");
  assert.equal(calls[0].url, "https://api9.unipile.com:13911/api/v1/hosted/accounts/link");
  assert.equal((calls[0].init.headers as Record<string, string>)["X-API-KEY"], "uk");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)).type, "reconnect");
  assert.equal(await client.getAccount("gone"), null);
  await assert.rejects(client.getAccount("other"), (e: unknown) => e instanceof UnipileError && e.status === 401 && !e.message.includes("secret"));

  assert.deepEqual(
    accountOf({ id: "a1", type: "LINKEDIN", name: "Ada", sources: [{ status: "CREDENTIALS" }], connection_params: { im: { publicIdentifier: "ada-l", premiumFeatures: ["sales_navigator"] } } }),
    { id: "a1", status: "CREDENTIALS", name: "Ada", publicIdentifier: "ada-l", tier: "sales_navigator" },
  );
  assert.equal(accountOf({ id: "w1", type: "WHATSAPP" }), null);
  assert.deepEqual(accountStatusEvent({ AccountStatus: { account_id: "a1", account_type: "LINKEDIN", message: "CREDENTIALS" } }), { accountId: "a1", message: "CREDENTIALS" });
  assert.equal(statusFromUnipile("CREDENTIALS", "ok"), "credentials");
  assert.equal(statusFromUnipile("RECONNECTED", "credentials"), "ok");
  assert.equal(statusFromUnipile("OK", "disconnected"), "disconnected");
  assert.equal(statusFromUnipile("CREDENTIALS", "disconnected"), "disconnected");
  assert.equal(statusFromUnipile("CONNECTING", "paused"), "paused");
});

test("invites are spread across what is left of the window", () => {
  const end = 10 * 3_600_000;
  assert.equal(nextInviteSlot(0, end, 5, 0.5), 3_600_000); // half of a 2 h share
  assert.equal(nextInviteSlot(0, end, 5, 0), MIN_GAP_MS); // never sooner than the minimum gap
  assert.equal(nextInviteSlot(0, end, 0, 0.5), end); // nothing left today
});

test("queue estimate waits for the window, then fills each day's and week's cap", () => {
  const now = Date.parse("2026-10-09T02:05:00Z"); // Thu 7:05 PM in Los Angeles, after hours
  const base = { now, window: DEFAULT_WINDOW, timezone: "America/Los_Angeles", senderKey: "s", account: { tier: "premium" as const, rampStep: 0, connectionCount: 500 }, health: { invitePause: null, factor: 1 }, recentInvites: [] };
  const day = (t: number | null) => (t === null ? null : new Date(t).toLocaleString("en-US", { timeZone: "America/Los_Angeles", weekday: "short", hour: "numeric", minute: "2-digit" }));
  const t = estimateInviteTimes({ ...base, queued: 7, invitesToday: 0 });
  // Friday's 5 are spread over 8:30-18:00 (one per 1 h 54 m share, placed mid-share), then Monday.
  assert.deepEqual(t.map(day), ["Fri 9:27 AM", "Fri 11:21 AM", "Fri 1:15 PM", "Fri 3:09 PM", "Fri 5:03 PM", "Mon 9:27 AM", "Mon 11:21 AM"]);
  // Already inside the window with 3 sent today: 2 more today, the rest later.
  const inWin = Date.parse("2026-10-09T17:00:00Z"); // Fri 10:00 AM
  const endFri = Date.parse("2026-10-10T01:00:00Z"); // Fri 6:00 PM
  assert.equal(estimateInviteTimes({ ...base, now: inWin, queued: 3, invitesToday: 3 }).filter((x) => x !== null && x < endFri).length, 2);
  // 30 invites in the last week: the weekly cap holds everything back.
  const full = Array.from({ length: 30 }, (_, i) => inWin - 3 * 86_400_000 + i);
  assert.ok(estimateInviteTimes({ ...base, now: inWin, queued: 1, invitesToday: 0, recentInvites: full })[0]! > inWin + 3 * 86_400_000);
});
