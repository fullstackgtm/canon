import assert from "node:assert/strict";
import { test } from "node:test";
import type { Id } from "../convex/_generated/dataModel";
import type { P4MailboxDelivery } from "../convex/lib/outbound/mailboxAdapter.ts";
import { loadConvex } from "./convexHandlers.ts";

const configuration = { env: {} as Record<string, string> }, timeouts: number[] = [];
let expire = false;
const graph = loadConvex(["lib/outbound/mailboxAdapter.ts", "lib/linkedin/unipile.ts"], {}, {
  process: configuration, FormData, AbortSignal: { timeout(ms: number) {
    timeouts.push(ms);
    return expire ? AbortSignal.abort(new DOMException("Fixture timeout", "TimeoutError")) : AbortSignal.timeout(ms);
  } },
});
const adapter = graph["lib/outbound/mailboxAdapter.ts"] as unknown as typeof import("../convex/lib/outbound/mailboxAdapter.ts");
const unipile = graph["lib/linkedin/unipile.ts"] as unknown as typeof import("../convex/lib/linkedin/unipile.ts");
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const TOKEN = `ZmFrZQ.${"a".repeat(64)}`;
function fixture(local = false): P4MailboxDelivery {
  expire = false; timeouts.length = 0;
  const origin = local ? "http://127.0.0.1:3211" : "https://fixture.convex.site";
  configuration.env = { CONVEX_SITE_URL: origin, UNIPILE_API_KEY: "fixture-key-private", UNIPILE_DSN: "api1.unipile.com:13111" };
  const url = `${origin}/outbound/unsubscribe?token=${TOKEN}`, hash = "a".repeat(64);
  const orgId = "org" as Id<"organizations">, ownerId = "owner" as Id<"users">, senderId = "mail" as Id<"emailAccounts">;
  return {
    emailSendId: "send" as Id<"emailSends">,
    account: { _id: senderId, orgId, userId: ownerId, address: "Owner@Example.test", status: "ok", unipileAccountId: local ? "local-gmail" : "provider-account" },
    prepared: { version: 1, kind: "manifest.automated-email.v1", purpose: "automated_outreach", orgId, moduleId: "fixture", preparedBy: ownerId, preparedAt: 100,
      recipient: { contactId: "con_person", streamId: "stream" as Id<"canonEntities">, address: "person@example.test" },
      sender: { id: senderId, ownerId, address: "owner@example.test", name: "Owner", mailboxLinkHash: hash },
      grantId: "grant" as Id<"mailboxSendGrants">, template: { kind: "manifest", name: "hello", hash }, companyStreamId: null, canonicalMergeHash: hash,
      postalAddress: "123 Main St", unsubscribe: { token: TOKEN, url },
      delivery: { subject: "  Exact frozen subject  ", text: `Frozen text <&>\n123 Main St\nUnsubscribe: ${url}`,
        html: `<p>Frozen text &lt;&amp;&gt;</p><p>123 Main St</p><a href="${url}">Unsubscribe</a>`,
        headers: { listUnsubscribe: `<${url}>`, listUnsubscribePost: "List-Unsubscribe=One-Click", inReplyTo: null, references: [] } },
      renderedHash: hash, bindingHash: hash, requestedNotBefore: 100, validUntil: 200, thread: null },
  };
}
function failed(result: Awaited<ReturnType<typeof adapter.sendMailboxEmail>>, ambiguous: boolean) {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("Expected transport refusal or uncertainty");
  assert.equal(result.retry, false);
  assert.equal(result.unknown === true, ambiguous);
  assert.equal(result.error.includes("fixture-key-private"), false);
  assert.equal(result.error.includes("api1.unipile.com"), false);
}

test("mailbox transport posts exact frozen HTML, closed RFC8058 headers and the attempt idempotency key", async () => {
  const input = fixture(), before = plain(input);
  const fetchImpl: typeof fetch = async (url, init) => {
    assert.equal(url, "https://api1.unipile.com:13111/api/v1/emails");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    const headers = new Headers(init?.headers), form = init?.body as FormData;
    assert.equal(headers.get("Idempotency-Key"), "send");
    assert.equal(headers.get("X-API-KEY"), "fixture-key-private");
    assert.equal(headers.has("Content-Type"), false);
    assert.equal(form.get("account_id"), "provider-account");
    assert.deepEqual(JSON.parse(String(form.get("to"))), [{ identifier: "person@example.test" }]);
    assert.equal(form.get("subject"), "  Exact frozen subject  ");
    assert.equal(form.get("body"), input.prepared.delivery.html);
    assert.deepEqual(JSON.parse(String(form.get("custom_headers"))), [
      { name: "List-Unsubscribe", value: input.prepared.delivery.headers.listUnsubscribe },
      { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
    ]);
    assert.deepEqual(JSON.parse(String(form.get("tracking_options"))), { opens: false, links: false });
    assert.deepEqual([...form.keys()].sort(), ["account_id", "body", "custom_headers", "subject", "to", "tracking_options"]);
    return Response.json({ object: "EmailSent", provider_id: "actual-provider-id", tracking_id: "tracking-only-id" }, { status: 201 });
  };
  assert.deepEqual(plain(await adapter.sendMailboxEmail(input, fetchImpl)), { ok: true, providerId: "actual-provider-id" });
  assert.deepEqual(input, before);
  assert.equal(timeouts.length, 1);
  assert.ok(timeouts[0] > 0 && timeouts[0] <= 30_000);
});

test("legacy direct Gmail preserves its form, tracking-id fallback and default timeout behavior", async () => {
  fixture();
  const client = unipile.createUnipileClient({ apiKey: "fixture-key-private", dsn: "api1.unipile.com:13111", fetchImpl: async (_url, init) => {
    assert.equal(init?.signal, undefined);
    assert.equal(init?.redirect, undefined);
    const form = init?.body as FormData;
    assert.deepEqual([...form.keys()].sort(), ["account_id", "body", "subject", "to"]);
    assert.deepEqual(JSON.parse(String(form.get("to"))), [{ identifier: "person@example.test", display_name: "Person" }]);
    return Response.json({ tracking_id: "legacy-tracking-id" }, { status: 201 });
  } });
  assert.deepEqual(plain(await client.sendEmail("provider-account", { to: { address: "person@example.test", name: "Person" }, subject: "Direct", html: "<p>Direct</p>", idempotencyKey: "direct-send" })), { providerId: "legacy-tracking-id" });
  assert.equal(timeouts.length, 0);
});

test("sink mail never reaches the network and stand-ins cannot deliver live", async () => {
  let calls = 0;
  const never: typeof fetch = async () => { calls++; throw new Error("Unexpected network"); };
  const local = fixture(true);
  delete configuration.env.UNIPILE_API_KEY;
  delete configuration.env.UNIPILE_DSN;
  assert.deepEqual(plain(await adapter.sendMailboxEmail(local, never)), { ok: true, providerId: "local-send" });
  local.account.unipileAccountId = "real-account";
  failed(await adapter.sendMailboxEmail(local, never), false);
  const live = fixture(); live.account.unipileAccountId = "local-gmail";
  failed(await adapter.sendMailboxEmail(live, never), false);
  assert.equal(calls, 0);
});

test("missing configuration, unsafe headers, thread inputs and account drift refuse before I/O", async () => {
  let calls = 0;
  const never: typeof fetch = async () => { calls++; throw new Error("Unexpected network"); };
  for (const change of [
    (i: P4MailboxDelivery) => { i.prepared.delivery.headers.listUnsubscribe = null as never; },
    (i: P4MailboxDelivery) => { i.prepared.delivery.headers.listUnsubscribe += "\r\nBcc: hidden@example.test"; },
    (i: P4MailboxDelivery) => { i.prepared.delivery.headers.listUnsubscribe = `<https://other.test/outbound/unsubscribe?token=${TOKEN}>`; },
    (i: P4MailboxDelivery) => { i.prepared.delivery.headers = { ...i.prepared.delivery.headers, replyTo: "other@example.test" } as never; },
    (i: P4MailboxDelivery) => { i.prepared.delivery.headers.listUnsubscribePost = "Invalid" as never; },
    (i: P4MailboxDelivery) => { i.prepared.delivery.headers.inReplyTo = "<guessed>" as never; },
    (i: P4MailboxDelivery) => { i.prepared.delivery.headers.references.push("<guessed>"); },
    (i: P4MailboxDelivery) => { i.prepared = { ...i.prepared, thread: { predecessorRequestId: "prior" as Id<"outboxRequests">, providerId: "provider" } } as never; },
    (i: P4MailboxDelivery) => { i.prepared.delivery.subject = "Subject\nBcc: hidden@example.test"; },
    (i: P4MailboxDelivery) => { i.account.address = "other@example.test"; },
    (i: P4MailboxDelivery) => { i.account.userId = "other-owner" as Id<"users">; },
    (i: P4MailboxDelivery) => { i.account.status = "disconnected"; },
    () => { delete configuration.env.UNIPILE_API_KEY; },
    () => { delete configuration.env.UNIPILE_DSN; },
    () => { configuration.env.UNIPILE_DSN = "https://user:private@other.test/path"; },
    () => { configuration.env.UNIPILE_DSN = "127.0.0.1:3114"; },
  ]) {
    const input = fixture(); change(input);
    failed(await adapter.sendMailboxEmail(input, never), false);
  }
  assert.equal(calls, 0);
});

test("tracking-only, malformed and missing provider confirmations are unknown", async () => {
  for (const body of [
    { object: "EmailSent", tracking_id: "not-a-provider-receipt" }, { object: "EmailSent", provider_id: null },
    { object: "EmailSent", provider_id: 42 }, { object: "EmailSent", provider_id: "bad\r\nid" }, { object: "Other", provider_id: "wrong-event" }, [], null,
  ]) {
    failed(await adapter.sendMailboxEmail(fixture(), async () => Response.json(body, { status: 201 })), true);
  }
  failed(await adapter.sendMailboxEmail(fixture(), async () => new Response("Malformed fixture-key-private", { status: 201 })), true);
});

test("explicit provider refusals fail without retry while ambiguous HTTP results stay unknown", async () => {
  for (const [status, type, ambiguous] of [
    [400, "errors/invalid_parameters", false], [401, "errors/invalid_credentials", false], [429, "errors/rate_limit", false],
    [422, "errors/invalid_headers", false], [422, "errors/provider_unreachable", true], [409, "errors/already_used", true],
    [408, "errors/request_timeout", true], [500, "errors/provider_error", true], [503, "errors/network_down", true],
  ] as const) {
    failed(await adapter.sendMailboxEmail(fixture(), async () => Response.json({ type, detail: "fixture-key-private api1.unipile.com" }, { status })), ambiguous);
  }
});

test("bounded aborts and network failures stay unknown and never request an automatic retry", async () => {
  const input = fixture(); expire = true;
  failed(await adapter.sendMailboxEmail(input, async (_url, init) => { init?.signal?.throwIfAborted(); throw new Error("Expected aborted signal"); }), true);
  assert.equal(timeouts.length, 1);
  assert.ok(timeouts[0] > 0 && timeouts[0] <= 30_000);
  failed(await adapter.sendMailboxEmail(fixture(), async () => { throw new Error("fixture-key-private api1.unipile.com"); }), true);
});
