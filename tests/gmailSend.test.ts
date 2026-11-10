import assert from "node:assert/strict";
import test from "node:test";
import { bodyHtml, composeProblem } from "../convex/lib/email/compose.ts";
import { signEmailState, verifyEmailState } from "../convex/lib/email/state.ts";
import { signState } from "../convex/lib/linkedin/state.ts";
import { createUnipileClient, mailAccountOf } from "../convex/lib/linkedin/unipile.ts";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

test("only a Google or Microsoft account with a readable address is a mail account", () => {
  assert.deepEqual(
    mailAccountOf({ id: "a1", type: "GOOGLE_OAUTH", name: "Riley", sources: [{ status: "OK" }], connection_params: { mail: { username: "Riley@Acme.com" } } }),
    { id: "a1", provider: "google", status: "OK", address: "riley@acme.com", name: "Riley" },
  );
  // The shape developer.unipile.com/reference/accountscontroller_getaccountbyid documents for OUTLOOK: mail.mailbox_id is Outlook's own.
  assert.deepEqual(
    mailAccountOf({ id: "a4", type: "OUTLOOK", name: "Riley Park", sources: [{ status: "OK" }], connection_params: { mail: { id: "AAMkAD-fixture", username: "riley@example.org", mailbox_id: "mbx-fixture" } } }),
    { id: "a4", provider: "microsoft", status: "OK", address: "riley@example.org", name: "Riley Park" },
  );
  assert.equal(mailAccountOf({ id: "a2", type: "LINKEDIN", name: "x@y.com" }), null);
  assert.equal(mailAccountOf({ id: "a3", type: "GOOGLE_OAUTH", name: "no address" }), null);
});

test("a send posts one multipart email with the idempotency key and returns Gmail's id", async () => {
  let seen: { url: string; headers: Record<string, string>; form: FormData } | null = null;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen = { url, headers: init.headers as Record<string, string>, form: init.body as FormData };
    return Response.json({ object: "EmailSent", tracking_id: "t1", provider_id: "p1" }, { status: 201 });
  }) as typeof fetch;
  const client = createUnipileClient({ apiKey: "k", dsn: "api1.unipile.com:13111", fetchImpl });
  const out = await client.sendEmail("acc", { to: { address: "sam@atlas.example", name: "Sam" }, subject: "Hi", html: "<p>Hello</p>", idempotencyKey: "send-1" });
  assert.deepEqual(out, { providerId: "p1" });
  assert.equal(seen!.url, "https://api1.unipile.com:13111/api/v1/emails");
  assert.equal(seen!.headers["Idempotency-Key"], "send-1");
  assert.equal(seen!.form.get("account_id"), "acc");
  assert.deepEqual(JSON.parse(String(seen!.form.get("to"))), [{ identifier: "sam@atlas.example", display_name: "Sam" }]);
});

test("a draft posts the same email to the mailbox's drafts and sends nothing", async () => {
  let url = "";
  const fetchImpl = (async (u: string) => { url = u; return Response.json({ object: "DraftCreated", draft_id: "d1" }); }) as typeof fetch;
  const client = createUnipileClient({ apiKey: "k", dsn: "api1.unipile.com:13111", fetchImpl });
  assert.deepEqual(await client.createDraft("acc", { to: { address: "sam@atlas.example" }, subject: "Hi", html: "<p>Hello</p>" }), { draftId: "d1" });
  assert.equal(url, "https://api1.unipile.com:13111/api/v1/drafts");
});

test("a Gmail link state verifies only as itself, and not after it expires", async () => {
  const state = await signEmailState("key", { userId: "u", orgId: "o", expiresAt: 2_000 });
  assert.deepEqual(await verifyEmailState("key", state, 1_000), { userId: "u", orgId: "o", expiresAt: 2_000 });
  assert.equal(await verifyEmailState("key", state, 3_000), null);
  assert.equal(await verifyEmailState("other", state, 1_000), null);
  const linkedin = await signState("key", { userId: "u", orgId: "o", riskAcceptedAt: 1, riskTextVersion: "v", timezone: "UTC", expiresAt: 2_000 });
  assert.equal(await verifyEmailState("key", linkedin, 1_000), null);
});

test("compose refuses a missing address or a multi-line subject, and escapes the body into paragraphs", () => {
  assert.match(composeProblem({ to: null, subject: "Hi", body: "x" }) ?? "", /no email address/);
  assert.ok(composeProblem({ to: "sam@atlas.example", subject: "Hi\nBcc: x", body: "x" }));
  assert.equal(composeProblem({ to: "sam@atlas.example", subject: "Hi", body: "x" }), null);
  assert.equal(bodyHtml("Hi <b>Sam</b>,\nline two\n\nBest"), "<p>Hi &lt;b&gt;Sam&lt;/b&gt;,<br>line two</p>\n<p>Best</p>");
});

const accounts = loadConvex(["emailAccounts.ts"], { "lib.ts": (real) => ({ ...real, requireUser: async (ctx: { user: unknown }) => ctx.user }) })["emailAccounts.ts"];

test("an Outlook account links, sends under the same daily cap, and unlinks like a Gmail one", async () => {
  const db = memoryDb({ users: [{ _id: "users:riley", orgId: "organizations:o", email: "riley@example.org", isActive: true }] });
  const scheduled: string[] = [];
  const ctx = { db, auth: { getUserIdentity: async () => null }, user: { _id: "users:riley", orgId: "organizations:o" }, scheduler: { runAfter: async (_ms: number, fn: unknown) => void scheduled.push(String(fn)) } };
  const link = { userId: "users:riley", orgId: "organizations:o", unipileAccountId: "u-outlook", address: "riley@example.org", displayName: "Riley Park", status: "OK" };
  assert.deepEqual(JSON.parse(JSON.stringify(await accounts.connected.handler(ctx, { ...link, provider: "microsoft" }))), { ok: true });
  const [row] = db.rows("emailAccounts");
  assert.deepEqual([row.provider, row.address, row.status], ["microsoft", "riley@example.org", "ok"]);

  const now = Date.now();
  for (let i = 0; i < 100; i++) await db.insert("emailSends", { orgId: "organizations:o", accountId: row._id, userId: "users:riley", contactId: "c", to: "x@example.com", subject: "s", state: "sent", at: now - 1000 - i });
  await assert.rejects(accounts.claimSend.handler(ctx, { userId: "users:riley", orgId: "organizations:o", accountId: row._id, contactId: "c", to: "grace@example.com", subject: "Hi" }), /100 emails in the last 24 hours/);

  await accounts.disconnect.handler(ctx, { accountId: row._id });
  assert.equal((await db.get(row._id))?.status, "disconnected");
  assert.deepEqual(scheduled, ["internal.linkedinActions.deleteRemote"]);
});
