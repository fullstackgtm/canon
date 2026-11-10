import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Id } from "../convex/_generated/dataModel";
import type { P4MailboxJob } from "../convex/lib/outbound/mailboxQueue.ts";
import type { P4MailboxMetadata } from "../convex/lib/outbound/mailboxTypes.ts";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const NOW = Date.UTC(2026, 9, 21, 20), DAY = 86_400_000, MODULE = "@canon-fixtures/visit-log";
let now = NOW;
const configuration = { env: {} as Record<string, string> };
const graph = loadConvex(["lib/outbound/ownerEmailPreparation.ts", "lib/outbound/mailboxQueue.ts", "lib/outbound/mailboxAdapter.ts", "lib/outbound/mailboxBinding.ts", "outbound.ts", "outboundDispatch.ts", "emailAccounts.ts"], {}, {
  process: configuration, Date: class extends Date { static now() { return now; } }, FormData,
  fetch: async () => { throw new Error("No vendor calls in owner email fixtures"); },
});
const queue = graph["lib/outbound/mailboxQueue.ts"] as unknown as typeof import("../convex/lib/outbound/mailboxQueue.ts");
const preparation = graph["lib/outbound/ownerEmailPreparation.ts"] as unknown as typeof import("../convex/lib/outbound/ownerEmailPreparation.ts");
const adapter = graph["lib/outbound/mailboxAdapter.ts"] as unknown as typeof import("../convex/lib/outbound/mailboxAdapter.ts");
const binding = graph["lib/outbound/mailboxBinding.ts"] as unknown as typeof import("../convex/lib/outbound/mailboxBinding.ts");
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const orgId = "org" as Id<"organizations">, senderId = "mail" as Id<"emailAccounts">, preparedBy = "manager" as Id<"users">;
function world() {
  now = NOW;
  configuration.env = { CONVEX_SITE_URL: "https://localhost", TOKEN_ENCRYPTION_KEY: "owner-exact-fixture-only", CANON_SERVICE_JWT_ISSUER: "https://service.test" };
  let actor = "owner", agent = false;
  const manifest = JSON.parse(readFileSync("tests/fixtures/modules/visit-log/module.json", "utf8"));
  manifest.outbound = { email: { from: ["member_mailbox"], kinds: ["personal", "automated"] } };
  manifest.templates = { draft: { channel: "email", subject: "Hello {$to.firstName}", body: "Hi {$to.name},\n{$doc.title}\nFrom {$sender.name}." } };
  const manifestFields = () => { const value = JSON.stringify(manifest); return { manifest: value, manifestHash: createHash("sha256").update(value).digest("hex") }; };
  const db = memoryDb({
    organizations: [{ _id: "org", clerkOrgId: "clerk-org", timezone: "UTC", outboundEmailPolicy: { postalAddress: "123 Main St", recipientWeeklyCap: 3, updatedAt: NOW, updatedBy: "admin" } }],
    users: ["owner", "manager", "admin"].map((u) => ({ _id: u, orgId: "org", name: u, role: u === "owner" ? "rep" : u, clerkUserId: `session:${u}`, isActive: true })),
    orgMemberships: ["owner", "manager", "admin"].map((u) => ({ _id: `member-${u}`, userId: u, orgId: "org", role: u === "owner" ? "rep" : u, isActive: true })),
    rolePermissions: [{ _id: "rep-policy", orgId: "org", role: "rep", rules: [{ object: "contact", visibility: "own", unowned: false }] },
      { _id: "manager-policy", orgId: "org", role: "manager", rules: [{ object: "contact", visibility: "team", unowned: false }] }],
    teamGroups: [{ _id: "team", orgId: "org", managerId: "manager", memberIds: ["owner"] }],
    modulePackages: [{ _id: "pkg", orgId: "org", moduleId: MODULE, slug: "visit-log", status: "installed", epoch: 1, version: manifest.version, ...manifestFields() }],
    recipeEnablements: [{ _id: "enabled", orgId: "org", point: "module", recipeId: MODULE, contributionKey: "nav", enabled: true }],
    moduleDocs: [{ _id: "doc", orgId: "org", moduleId: MODULE, collection: "visits", key: "draft", version: 1, ownerUserId: "owner", data: { rep: "owner", title: "My <personal> agenda & draft.", status: "planned" } }],
    emailAccounts: [{ _id: "mail", orgId: "org", userId: "owner", displayName: "Mailbox Owner", address: "Owner@Example.test", provider: "google", status: "ok", connectedAt: NOW - DAY, unipileAccountId: "local-mail" }],
    outboundChannels: [{ _id: "channel", orgId: "org", moduleId: MODULE, channel: "email", enabledBy: "admin", enabledAt: NOW }],
    canonExternalIds: [{ _id: "mapping", orgId: "org", provider: "record:contact", externalId: "con_person", entityId: "stream" }],
    canonEntities: [{ _id: "stream", orgId: "org", entityType: "contact", projectionTable: "recordContacts", projectionId: "con_person" }],
    recordRows: [{ _id: "hot", orgId: "org", streamId: "stream", object: "contact", version: 1, lifecycle: { status: "active" }, values: { ownerId: "owner", fullName: "Ada Lovelace", email: "Ada@Example.test" } }],
    ledgerEntries: [{ _id: "ledger", orgId: "org", streamId: "stream", object: "contact", version: 1 }],
  });
  const ctx = { db, scheduler: { runAfter: async () => "scheduled" }, auth: { getUserIdentity: async () => ({ subject: actor, tokenIdentifier: `session:${actor}`, issuer: agent ? "https://service.test" : "https://clerk.test", org_id: "clerk-org" }) } };
  const reads = { ...ctx, db: { get: db.get, query: db.query, normalizeId: db.normalizeId } };
  const input = { orgId, moduleId: MODULE, preparedBy, senderId, contactId: "con_person", template: "draft", source: { collection: "visits", key: "draft", version: 1 }, requestedNotBefore: NOW };
  const enqueue = (automated = false, cause = "owner-draft") => (automated ? queue.enqueueOwnerAutomatedEmail : queue.enqueueOwnerPersonalEmail)(ctx as never, input, { cause, index: 0 });
  const review = async (id: string) => {
    const row = (await db.get(id))!, m = row.mailbox as P4MailboxMetadata;
    if (m.kind !== "owner.exact-email.v1") throw new Error("Expected exact owner row");
    return plain(m);
  };
  const act = (id: string, expectedBindingHash?: string, action = "approve") => graph["outbound.ts"].act.handler(ctx, { id, action, ...(expectedBindingHash ? { expectedBindingHash } : {}) });
  const approve = async (id: string) => act(id, (await review(id)).prepared.bindingHash);
  const outbox = () => graph["outbound.ts"].outbox.handler(reads, { module: MODULE });
  const claim = async (): Promise<P4MailboxJob[]> => plain(await graph["outboundDispatch.ts"].claim.handler(ctx, {}));
  const settle = (job: P4MailboxJob, result = { ok: true, providerId: "provider-confirmed" } as Record<string, unknown>) => graph["outboundDispatch.ts"].settleMailbox.handler(ctx, { expected: job.expected, result });
  const direct = () => graph["emailAccounts.ts"].claimSend.handler(ctx, { orgId: "org", userId: "owner", accountId: "mail", contactId: "con_direct", to: "direct@example.test", subject: "Direct" });
  const as = (user: string, service = false) => { actor = user; agent = service; };
  return { db, ctx, reads, input, enqueue, review, act, approve, outbox, claim, settle, direct, as, manifest,
    changeTemplate: async (body: string) => { manifest.templates.draft.body = body; await db.patch("pkg", manifestFields()); } };
}
function enqueued(v: Awaited<ReturnType<typeof queue.enqueueOwnerPersonalEmail>>) {
  assert.ok("id" in v); if (!("id" in v)) throw new Error("Expected exact row or non-deliverable history"); return v;
}

test("owner reviews frozen authored bytes, approves once and claims the existing paired transport without grant or SQ1 authority", async () => {
  const h = world(), result = enqueued(await h.enqueue());
  assert.equal(result.state, "awaiting_approval"); assert.equal(h.db.rows("emailSends").length, 0);
  const m = await h.review(result.id), p = m.prepared;
  assert.equal(p.purpose, "manual_action"); assert.equal(p.validUntil, NOW + 7 * DAY);
  assert.equal(p.delivery.text, "Hi Ada Lovelace,\nMy <personal> agenda & draft.\nFrom Mailbox Owner.");
  assert.equal(p.delivery.html, "<p>Hi Ada Lovelace,<br>My &lt;personal&gt; agenda &amp; draft.<br>From Mailbox Owner.</p>");
  assert.equal(p.delivery.headers.listUnsubscribe, null); assert.equal("grantId" in p, false); assert.equal("request" in m, false);
  const [visible] = await h.outbox(); assert.equal(visible.actions.approve, true); assert.equal(visible.ownerReview.bindingHash, p.bindingHash);
  await h.approve(result.id); await h.approve(result.id); assert.equal(h.db.rows("emailSends").length, 0);
  const [job] = await h.claim(); assert.equal(job.expected.kind, "owner.exact-email.v1");
  assert.deepEqual(plain(await adapter.sendMailboxEmail(job.delivery)), { ok: true, providerId: `local-${job.delivery.emailSendId}` });
  await h.settle(job); await h.settle(job);
  assert.equal((await h.db.get(result.id))!.state, "sent"); assert.equal(h.db.rows("emailSends").length, 1);
  const observations = h.db.rows("observations");
  assert.equal(observations.length, 1);
  assert.deepEqual(plain(observations[0].body), { type: "email", key: `email:${job.delivery.emailSendId}`,
    event: { kind: "sent", userId: "owner", from: "owner@example.test", to: "ada@example.test", subject: p.delivery.subject, body: p.delivery.text } });
  assert.equal((await h.enqueue()).state, "refused");
});

test("manager, admin, service, preview and revoked membership cannot approve on behalf of the owner", async () => {
  const h = world(), result = enqueued(await h.enqueue()), baseline = h.db.checkpoint();
  for (const actor of ["manager", "admin"]) {
    h.as(actor); const [view] = await h.outbox(); assert.equal(view.actions.approve, false); await assert.rejects(h.approve(result.id));
  }
  h.as("owner", true); await assert.rejects(h.approve(result.id)); h.as("owner");
  await h.db.patch("member-owner", { isActive: false }); await assert.rejects(h.approve(result.id)); h.db.rollback(baseline);
  await h.db.patch("owner", { role: "admin" }); await h.db.patch("member-owner", { role: "admin" });
  await h.db.insert("accessPreviews", { orgId: "org", userId: "owner", asUserId: "manager", expiresAt: NOW + DAY });
  await assert.rejects(h.approve(result.id)); h.db.rollback(baseline);
  h.as("manager"); await h.act(result.id, undefined, "cancel"); assert.equal((await h.db.get(result.id))!.state, "cancelled");
});

test("CAS, source, recipient, linkage, template and permission drift refuse approval and final claim without refreshing bytes", async () => {
  const h = world(), result = enqueued(await h.enqueue()), frozen = await h.review(result.id), baseline = h.db.checkpoint();
  await assert.rejects(h.act(result.id, "stale-snapshot")); await assert.rejects(h.act(result.id));
  const changes = [
    () => h.db.patch("doc", { version: 2, data: { rep: "owner", title: "Changed authored text", status: "planned" } }),
    () => h.db.patch("hot", { values: { ownerId: "owner", fullName: "Changed Name", email: "changed@example.test" } }),
    () => h.db.patch("mail", { unipileAccountId: "local-reconnected" }),
    () => h.db.patch("rep-policy", { rules: [{ object: "contact", fields: [{ apiName: "email", level: "hidden" }] }] }),
    () => h.changeTemplate("Changed canonical template"),
    () => h.db.patch("pkg", { epoch: 2, version: "2.0.0" }),
  ];
  for (const change of changes) {
    h.db.rollback(baseline); await change(); await assert.rejects(h.approve(result.id));
    assert.deepEqual(await h.review(result.id), frozen);
  }
  h.db.rollback(baseline); await h.approve(result.id); await changes[0]();
  assert.deepEqual(await h.claim(), []); assert.equal((await h.db.get(result.id))!.state, "refused"); assert.equal(h.db.rows("emailSends").length, 0);
  assert.equal(enqueued(await h.enqueue()).created, false);
});

test("both public readers recheck private source and contact visibility, while the permitted owner can review", async () => {
  const h = world(), result = enqueued(await h.enqueue());
  assert.equal((await h.outbox())[0].text.includes("personal"), true);
  const baseline = h.db.checkpoint();
  for (const change of [
    () => h.db.patch("doc", { ownerUserId: "admin" }),
    () => h.db.patch("rep-policy", { rules: [{ object: "contact", fields: [{ apiName: "fullName", level: "hidden" }] }] }),
    () => h.db.patch("mapping", { orgId: "foreign" }),
  ]) {
    h.db.rollback(baseline); await change(); assert.deepEqual(plain(await h.outbox()), []);
    h.as("admin"); await h.db.insert("accessPreviews", { orgId: "org", userId: "admin", asUserId: "owner", expiresAt: NOW + DAY });
    const settings = await graph["outbound.ts"].settings.handler(h.reads, {}); assert.deepEqual(plain(settings.rows), []);
    h.as("owner"); await assert.rejects(h.approve(result.id));
  }
});

test("current source visibility preserves frozen history after an edit without authorizing stale preparation", async () => {
  const h = world(), sent = enqueued(await h.enqueue(false, "sent-history"));
  await h.approve(sent.id); const [job] = await h.claim(); await h.settle(job);
  const pending = enqueued(await h.enqueue(false, "pending-history"));
  await h.db.patch("doc", { version: 2, data: { rep: "owner", title: "Later source edit", status: "planned" } });
  const rows = await h.outbox();
  assert.deepEqual(plain(rows.map((r: { state: string }) => r.state).sort()), ["awaiting_approval", "sent"]);
  assert.equal(rows.every((r: { text: string }) => r.text.includes("My <personal> agenda & draft.")), true);
  await assert.rejects(h.approve(pending.id));
  h.as("admin"); await h.db.insert("accessPreviews", { orgId: "org", userId: "admin", asUserId: "owner", expiresAt: NOW + DAY });
  const settings = await graph["outbound.ts"].settings.handler(h.reads, {});
  assert.equal(settings.rows.length, 2);
  assert.equal(h.db.rows("emailSends").length, 1);
});

test("public mailbox lists stay within the read budget for a full page and recheck visibility on each invocation", async (t) => {
  const h = world(), result = enqueued(await h.enqueue()), original = (await h.db.get(result.id))!;
  for (let i = 1; i < 200; i++) {
    const contactId = `con_page${i}`, streamId = `stream-${i}`, key = `draft-${i}`;
    await h.db.insert("canonExternalIds", { orgId: "org", provider: "record:contact", externalId: contactId, entityId: streamId });
    await h.db.insert("canonEntities", { _id: streamId, orgId: "org", entityType: "contact" });
    await h.db.insert("recordRows", { orgId: "org", streamId, object: "contact", version: 1, lifecycle: { status: "active" }, values: { ownerId: "owner", fullName: `Contact ${i}`, email: `page${i}@example.test` } });
    await h.db.insert("ledgerEntries", { orgId: "org", streamId, object: "contact", version: 1 });
    await h.db.insert("moduleDocs", { orgId: "org", moduleId: MODULE, collection: "visits", key, version: 1, ownerUserId: "owner", data: { rep: "owner", title: `Visit ${i}`, status: "planned" } });
    const prepared = await preparation.prepareOwnerPersonalEmail(h.ctx as never, { ...h.input, contactId, source: { ...h.input.source, key } });
    assert.equal(prepared.state, "prepared"); if (prepared.state !== "prepared") throw new Error("Expected prepared page fixture");
    const row = Object.fromEntries(Object.entries(original).filter(([key]) => key !== "_id" && key !== "_creationTime"));
    await h.db.insert("outboundMessages", { ...plain(row), cause: `page-${i}`, idempotencyKey: `page-${i}`,
      target: `address:${prepared.prepared.recipient.address}`, rendered: { subject: prepared.prepared.delivery.subject, text: prepared.prepared.delivery.text },
      to: { address: prepared.prepared.recipient.address }, about: `visits/${key}`, mailbox: { kind: "owner.exact-email.v1", prepared: plain(prepared.prepared) } });
  }
  h.as("admin");
  await h.db.insert("accessPreviews", { orgId: "org", userId: "admin", asUserId: "owner", expiresAt: NOW + DAY });
  let reads = 0;
  const count = () => { reads++; };
  const ctx = { ...h.reads, db: { ...h.reads.db,
    get: (id: string) => { count(); return h.db.get(id); },
    query: (table: string) => { count(); return h.db.query(table); },
  } };
  for (const read of [() => graph["outbound.ts"].settings.handler(ctx, {}), () => graph["outbound.ts"].outbox.handler(ctx, { module: MODULE })]) {
    reads = 0;
    const result = await read(), rows = Array.isArray(result) ? result : result.rows;
    assert.equal(rows.length, 100);
    t.diagnostic(`Mailbox page used ${reads} index reads`);
    assert.ok(reads < 4096, `Mailbox page used ${reads} index reads`);
  }
  await h.db.patch("rep-policy", { rules: [{ object: "contact", fields: [{ apiName: "email", level: "hidden" }] }] });
  assert.deepEqual(plain((await graph["outbound.ts"].settings.handler(ctx, {})).rows), []);
});

test("personal purpose ignores unsubscribe, quiet hours and recipient weekly cap but retains manual floors and shared capacity", async () => {
  const h = world();
  delete configuration.env.TOKEN_ENCRYPTION_KEY;
  await h.db.patch("org", { outboundEmailPolicy: undefined, timezone: "invalid" });
  await h.db.insert("suppressions", { orgId: "org", kind: "email", value: "ada@example.test", source: "unsubscribe", state: "active" });
  const result = enqueued(await h.enqueue()); assert.equal(result.state, "awaiting_approval"); await h.approve(result.id);
  const approved = h.db.checkpoint();
  for (const source of ["manual", "bounce", "dnc"]) {
    h.db.rollback(approved); await h.db.insert("suppressions", { orgId: "org", kind: "email", value: "ada@example.test", source, state: "active" });
    assert.deepEqual(await h.claim(), []); assert.equal((await h.db.get(result.id))!.state, "suppressed");
  }
  h.db.rollback(approved); for (let i = 0; i < 99; i++) await h.db.insert("emailSends", { orgId: "org", accountId: "mail", userId: "owner", contactId: "con_old", to: "old@example.test", subject: "Old", state: "sent", at: NOW - 1000 });
  await h.direct(); assert.deepEqual(await h.claim(), []); assert.equal((await h.db.get(result.id))!.state, "held");
  now += DAY + 1; const [job] = await h.claim(); assert.equal(job.delivery.prepared.delivery.headers.listUnsubscribe, null);
});

test("automated owner approval keeps its purpose, frozen compliance, recipient cap and hours", async () => {
  const h = world(), result = enqueued(await h.enqueue(true)), m = await h.review(result.id), p = m.prepared;
  assert.equal(p.purpose, "automated_outreach"); assert.equal(p.delivery.text.includes("123 Main St\nUnsubscribe: https://localhost/outbound/unsubscribe?token="), true);
  assert.equal(p.delivery.headers.listUnsubscribePost, "List-Unsubscribe=One-Click");
  await h.approve(result.id); assert.equal((await h.db.get(result.id))!.state, "held");
  assert.equal((await h.db.get(result.id))!.notBefore, Date.UTC(2026, 9, 22, 8));
  assert.equal(h.db.rows("emailSends").length, 0);
  await h.db.patch("org", { outboundEmailPolicy: { postalAddress: "Changed footer", recipientWeeklyCap: 1 } });
  now = Date.UTC(2026, 9, 22, 8); assert.deepEqual(await h.claim(), []); assert.equal((await h.db.get(result.id))!.state, "refused");
  assert.deepEqual((await h.review(result.id)).prepared, p);
});

test("stable logical identity refuses address and authorization-kind replacements without an owner decision", async () => {
  const h = world(), result = enqueued(await h.enqueue()), original = (await h.db.get(result.id))!;
  assert.deepEqual(plain(await h.enqueue()), { id: result.id, state: "awaiting_approval", created: false });
  assert.equal((await h.enqueue(true)).state, "refused");
  await h.db.patch("hot", { values: { ownerId: "owner", fullName: "Ada Lovelace", email: "new@example.test" } });
  assert.equal((await h.enqueue()).state, "refused"); assert.equal(h.db.rows("outboundMessages").length, 1);
  const checkpoint = h.db.checkpoint();
  await h.db.patch(result.id, { state: "queued" });
  assert.deepEqual(await h.claim(), []); assert.equal((await h.db.get(result.id))!.state, "refused");
  h.db.rollback(checkpoint);
  const m = original.mailbox as P4MailboxMetadata;
  assert.equal(binding.mailboxMetadataShape({ ...m, request: { kind: "sq1.email.v1", requestId: "fake", epoch: 1, digest: "a".repeat(64) } }), false);
  assert.equal(binding.mailboxMetadataShape({ ...m, prepared: { ...m.prepared, grantId: "set-grant" } }), false);
  assert.equal((await h.enqueue(false, "canon:sq1.email.v1:request")).state, "refused");
  await h.db.patch(result.id, { mailbox: { ...m, prepared: { ...m.prepared, grantId: "set-grant" } } });
  await assert.rejects(h.act(result.id));
  assert.equal((await h.db.get(result.id))!.state, "awaiting_approval");
  await h.db.patch(result.id, { state: "queued" }); assert.deepEqual(await h.claim(), []);
  assert.equal(h.db.rows("emailSends").length, 0);
});

test("unknown paired receipt settles after uninstall, ignores stale outcomes and never reopens the row", async () => {
  const h = world(), result = enqueued(await h.enqueue()); await h.approve(result.id); const [job] = await h.claim();
  await h.db.delete("pkg"); await h.db.delete("doc"); await h.db.delete("hot");
  await h.settle({ ...job, expected: { ...job.expected, attempt: 2 } }); assert.equal((await h.db.get(result.id))!.state, "sending");
  now += 11 * 60_000; await graph["outboundDispatch.ts"].tick.handler(h.ctx, {});
  assert.equal((await h.db.get(result.id))!.state, "unknown");
  assert.equal(h.db.rows("observations").length, 0);
  await h.settle(job); assert.equal((await h.db.get(result.id))!.state, "unknown");
  assert.equal(h.db.rows("emailSends")[0].receiptRevision, 1); assert.equal(h.db.rows("outboxRequests").length, 0);
});

test("expired exact preparation and unsupported template bindings refuse without reminting", async () => {
  const h = world(), result = enqueued(await h.enqueue()), frozen = (await h.review(result.id)).prepared;
  now += 7 * DAY; await assert.rejects(h.approve(result.id)); assert.equal((await preparation.revalidateOwnerEmail(h.ctx as never, frozen)).state, "refused");
  assert.deepEqual((await h.review(result.id)).prepared, frozen);
  const next = world(); await next.changeTemplate("{$vars.authored} {$doc.title|url}");
  const history = enqueued(await next.enqueue()); assert.equal(history.state, "refused");
  assert.equal(enqueued(await next.enqueue()).created, false); assert.deepEqual(await next.claim(), []);
  await assert.rejects(next.act(history.id, "not-consent"));
});


test("personal exact transport uses frozen HTML and attempt identity without custom compliance headers", async () => {
  const h = world(), row = enqueued(await h.enqueue()); await h.approve(row.id); const [job] = await h.claim();
  configuration.env.CONVEX_SITE_URL = "https://fixture.convex.site";
  configuration.env.UNIPILE_API_KEY = "fixture-private"; configuration.env.UNIPILE_DSN = "api1.unipile.com:13111";
  job.delivery.account.unipileAccountId = "provider-account";
  const result = await adapter.sendMailboxEmail(job.delivery, async (_url, init) => {
    const form = init?.body as FormData;
    assert.equal(form.get("custom_headers"), null);
    assert.equal(form.get("subject"), "Hello Ada");
    assert.equal(form.get("body"), "<p>Hi Ada Lovelace,<br>My &lt;personal&gt; agenda &amp; draft.<br>From Mailbox Owner.</p>");
    assert.equal(new Headers(init?.headers).get("Idempotency-Key"), job.delivery.emailSendId);
    return Response.json({ object: "EmailSent", provider_id: "confirmed-personal" }, { status: 201 });
  });
  assert.deepEqual(plain(result), { ok: true, providerId: "confirmed-personal" });
});

test("owner approval never overrides automated recipient cap or an immutable personal requested floor", async () => {
  const h = world(); now = Date.UTC(2026, 9, 22, 8);
  await h.db.patch("org", { outboundEmailPolicy: { postalAddress: "123 Main St", recipientWeeklyCap: 1 } });
  const first = enqueued(await h.enqueue(true, "automated-first")); await h.approve(first.id); const [job] = await h.claim(); await h.settle(job);
  const second = enqueued(await h.enqueue(true, "automated-second")); await h.approve(second.id);
  assert.equal((await h.db.get(second.id))!.state, "held"); assert.equal((await h.db.get(second.id))!.notBefore, now + 7 * DAY + 1);
  assert.equal(h.db.rows("emailSends").length, 1);
  h.input.requestedNotBefore = now + 60_000;
  const personal = enqueued(await h.enqueue(false, "personal-floor")); await h.approve(personal.id);
  assert.equal((await h.db.get(personal.id))!.notBefore, now + 60_000); assert.equal((await h.db.get(personal.id))!.state, "held");
  assert.deepEqual(await h.claim(), []);
  now += 60_000; const [personalJob] = await h.claim(); assert.equal(personalJob.expected.outboundMessageId, personal.id);
});


test("authored source values stay literal instead of becoming recursive merge instructions", async () => {
  const h = world();
  await h.db.patch("doc", { data: { rep: "owner", title: "Literal {$to.email} and {{vars.secret}}.", status: "planned" } });
  const result = enqueued(await h.enqueue()), m = await h.review(result.id);
  assert.equal(m.prepared.delivery.text, "Hi Ada Lovelace,\nLiteral {$to.email} and {{vars.secret}}.\nFrom Mailbox Owner.");
  assert.equal((await preparation.revalidateOwnerEmail(h.ctx as never, m.prepared)).state, "valid");
});
