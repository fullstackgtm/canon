import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Id, TableNames } from "../convex/_generated/dataModel";
import type { P4MailboxJob } from "../convex/lib/outbound/mailboxQueue.ts";
import type { ManifestPreparationInput } from "../convex/lib/outbound/manifestPreparation.ts";
import type { Sq1PreparationResult } from "../convex/lib/outbound/sq1Preparation.ts";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const NOW = Date.UTC(2026, 9, 21, 12), DAY = 86_400_000, MODULE = "@canon/sequences";
const id = <T extends TableNames>(value: string) => value as Id<T>;
let now = NOW;
const configuration = { env: {} as Record<string, string> };
const graph = loadConvex(["mailboxGrants.ts", "lib/outbound/mailboxGrants.ts", "lib/outbound/sq1Preparation.ts", "lib/outbound/sq1Templates.ts", "lib/sequences/emailAuthority.ts", "lib/outbound/mailboxCapacity.ts",
  "lib/outbound/mailboxQueue.ts", "lib/outbound/queue.ts", "outboundDispatch.ts", "emailAccounts.ts", "outbound.ts"], {}, {
  process: configuration, Date: class extends Date { static now() { return now; } }, fetch: async () => { throw new Error("No vendor I/O in mailbox queue fixtures"); },
});
const preparation = graph["lib/outbound/sq1Preparation.ts"] as unknown as typeof import("../convex/lib/outbound/sq1Preparation.ts");
const templates = graph["lib/outbound/sq1Templates.ts"] as unknown as typeof import("../convex/lib/outbound/sq1Templates.ts");
const grants = graph["lib/outbound/mailboxGrants.ts"] as unknown as typeof import("../convex/lib/outbound/mailboxGrants.ts");
const port = graph["lib/sequences/emailAuthority.ts"] as unknown as typeof import("../convex/lib/sequences/emailAuthority.ts");
const capacity = graph["lib/outbound/mailboxCapacity.ts"] as unknown as typeof import("../convex/lib/outbound/mailboxCapacity.ts");
const mailboxQueue = graph["lib/outbound/mailboxQueue.ts"] as unknown as typeof import("../convex/lib/outbound/mailboxQueue.ts");
const queue = graph["lib/outbound/queue.ts"] as unknown as typeof import("../convex/lib/outbound/queue.ts");
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
async function world(body = "Hello {$to.name}.\nFrom {{sender.name}} at {{sender.email}}.") {
  now = NOW; configuration.env = { TOKEN_ENCRYPTION_KEY: "sq1-preparation-fixture-only", CONVEX_SITE_URL: "https://fixture.convex.site", CANON_SERVICE_JWT_ISSUER: "https://service.test" };
  let actor = "owner", service = false;
  const manifest = JSON.parse(readFileSync("modules/examples/sequences/module.json", "utf8"));
  manifest.outbound = { email: { from: ["member_mailbox"], kinds: ["automated"] } };
  const variant = { key: "A", weight: 100, subject: "Hi {{firstName}}", body, templateHash: "" };
  const db = memoryDb({
    organizations: [{ _id: "org", clerkOrgId: "clerk-org", timezone: "UTC", outboundEmailPolicy: { postalAddress: "123 Main St", recipientWeeklyCap: 3, updatedAt: NOW, updatedBy: "owner" } }],
    users: ["owner", "manager", "admin"].map((user) => ({ _id: user, orgId: "org", clerkUserId: `session:${user}`, role: user === "owner" ? "rep" : user, isActive: true, name: user })),
    orgMemberships: ["owner", "manager", "admin"].map((user) => ({ _id: `membership-${user}`, userId: user, orgId: "org", role: user === "owner" ? "rep" : user, isActive: true })),
    rolePermissions: [{ _id: "permissions", orgId: "org", role: "rep", rules: [{ object: "contact", visibility: "own", unowned: false }] },
      { _id: "manager-permissions", orgId: "org", role: "manager", rules: [{ object: "contact", visibility: "team", unowned: false }] }],
    teamGroups: [{ _id: "team", orgId: "org", managerId: "manager", memberIds: ["owner"] }],
    modulePackages: [{ _id: "pkg", orgId: "org", moduleId: MODULE, slug: "sequences", manifest: JSON.stringify(manifest), manifestHash: "fixture-sq1", status: "installed", epoch: 1, version: manifest.version }],
    recipeEnablements: [{ _id: "enabled", orgId: "org", point: "module", recipeId: MODULE, contributionKey: "nav", enabled: true }],
    moduleDocs: [{ _id: "projection", orgId: "org", moduleId: MODULE, collection: "sequences", key: "sequence", version: 1, ownerUserId: "owner", data: { name: "Canonical", owner: "owner", status: "active" } }],
    emailAccounts: [{ _id: "mail", orgId: "org", userId: "owner", displayName: "Ria <Owner>", address: "Owner@Example.test", provider: "google", status: "ok", unipileAccountId: "private-provider", connectedAt: NOW - DAY }],
    sequenceLaunches: [{ _id: "launch", orgId: "org", moduleId: MODULE, moduleSequenceKey: "sequence", revision: 1, authorizationEpoch: 1, state: "active", approvedBy: "owner", approvedAt: NOW, packageEpoch: 1,
      projection: { collection: "sequences", key: "sequence", fields: {}, absent: [] }, sources: [], approvedPlan: { steps: [], settings: {}, schedule: { days: [1, 2, 3, 4, 5], start: "08:00", end: "18:00", timeZone: "UTC", holidays: [] } },
      planDigest: "fixture", templateSetVersion: 1, approvedTemplates: [], templateSetHash: "", approvedSenderRefs: ["mail"], allowedChannels: ["email"], reservedRequests: 0, totalRequestCap: 10 }],
    sequenceEnrollments: [{ _id: "enrollment", orgId: "org", moduleId: MODULE, launchId: "launch", moduleEnrollmentKey: "enrolled", identityKey: "contact:con_person", contactId: "con_person", assignedRep: "owner", revision: 1,
      state: "active", currentStep: { stepKey: "hello", ordinal: 0, occurrence: 0 }, currentRequestId: "request", projection: { collection: "enrollments", key: "enrolled", fields: {}, absent: [] } }],
    outboxRequests: [{ _id: "request", orgId: "org", moduleId: MODULE, launchId: "launch", enrollmentId: "enrollment", stepKey: "hello", ordinal: 0, occurrence: 0, authorizationEpoch: 1, revision: 1, state: "preparing", requestedNotBefore: NOW + 1000 }],
    canonExternalIds: [{ _id: "mapping", orgId: "org", provider: "record:contact", externalId: "con_person", entityId: "stream" }],
    canonEntities: [{ _id: "stream", orgId: "org", entityType: "contact", projectionTable: "recordContacts", projectionId: "con_person" }],
    sequenceRecipientChecks: [{ _id: "check", orgId: "org", sequenceKey: "sequence", contactId: "con_person", checkedAt: NOW, fullName: "Ada & <Lovelace>", address: "ada@example.test", emailStatus: "valid", companyId: "", companyName: "", companyDomain: "" }],
    recordRows: [{ _id: "hot", orgId: "org", streamId: "stream", object: "contact", version: 1, lifecycle: { status: "active" }, values: { ownerId: "owner", fullName: "Ada & <Lovelace>", email: "Ada@Example.test" } }],
    ledgerEntries: [{ _id: "entry", orgId: "org", streamId: "stream", object: "contact", version: 1 }],
  });
  const ctx = { db, scheduler: { runAfter: async () => "scheduled" }, auth: { getUserIdentity: async () => ({ subject: actor, tokenIdentifier: `session:${actor}`, issuer: service ? "https://service.test" : "https://clerk.test", org_id: "clerk-org" }) } };
  const replaceTemplate = async (nextBody: string) => {
    variant.body = nextBody; variant.templateHash = await templates.sq1CanonicalHash(["canon.sq1.template.v1", "email", variant.subject, variant.body]);
    const list = [{ step: { key: "hello", ordinal: 0 }, variant: "A", channel: "email", templateHash: variant.templateHash }];
    await db.patch("launch", { approvedPlan: { steps: [{ key: "hello", ordinal: 0, occurrence: 0, kind: "auto_email", delayDays: 0, thread: false, variants: [plain(variant)] }], settings: {}, schedule: { days: [1, 2, 3, 4, 5], start: "08:00", end: "18:00", timeZone: "UTC", holidays: [] } },
      approvedTemplates: list, templateSetHash: await templates.sq1CanonicalHash(["canon.sq1.template-set.v1", list]) });
  };
  await replaceTemplate(body);
  const options = () => graph["mailboxGrants.ts"].sq1Options.handler(ctx, { senderId: "mail", launchId: "launch" });
  const create = async (over: Record<string, unknown> = {}) => {
    const review = await options();
    return graph["mailboxGrants.ts"].createSq1Set.handler(ctx, { senderId: "mail", launchId: "launch", maxPerDay: 10, expiresAt: NOW + DAY,
      expectSetHash: review?.template.hash ?? "unavailable", expectMailboxLinkHash: review?.mailboxLinkHash ?? "unavailable", ...over });
  };
  const causal = { orgId: id<"organizations">("org"), preparedBy: id<"users">("owner") };
  const prepare = () => preparation.prepareSq1Email(ctx as never, id<"outboxRequests">("request"), causal);
  const validate = (p: ReturnType<typeof prepared>["prepared"]) => preparation.revalidateSq1Email(ctx as never, id<"outboxRequests">("request"), causal, p);
  return { db, ctx, causal, prepare, validate, options, create, replaceTemplate, as: (user: string, agent = false) => { actor = user; service = agent; } };
}
function prepared(value: Sq1PreparationResult) {
  assert.equal(value.state, "prepared");
  if (value.state !== "prepared") throw new Error("Expected canonical frozen preparation");
  return plain(value);
}

test("only the mailbox owner grants the reviewed canonical set, with no manifest fallback", async () => {
  const h = await world(), review = await h.options();
  assert.equal(review.templates[0].body, "Hello {$to.name}.\nFrom {{sender.name}} at {{sender.email}}.");
  const { grantId } = await h.create();
  const row = (await h.db.get(grantId))!;
  assert.deepEqual(plain(row.template), plain(review.template));
  assert.equal("epoch" in (row.template as object), false);
  assert.equal(await grants.mailboxGrantSignatureValid(row as never), true);
  const mine = await graph["mailboxGrants.ts"].mine.handler(h.ctx, { scope: { orgId: "org", userId: "owner" } });
  assert.equal(mine.grants[0].state, "live");
  assert.equal(JSON.stringify(mine).includes("private-provider"), false);
  assert.equal(JSON.stringify(mine).includes(String(row.signature)), false);
  assert.equal(await grants.readManifestMailboxGrant(h.ctx as never, { orgId: id<"organizations">("org"), moduleId: MODULE, senderId: id<"emailAccounts">("mail"), grantId }), null);
  await graph["mailboxGrants.ts"].revoke.handler(h.ctx, { grantId });
  assert.equal((await h.prepare()).state, "refused");
});

test("manager, admin, agent, preview, inactive membership, stale review and missing signer cannot grant for an owner", async () => {
  const h = await world(), baseline = h.db.checkpoint();
  for (const user of ["manager", "admin"]) { h.as(user); await assert.rejects(h.create()); }
  h.as("owner", true); await assert.rejects(h.create()); h.as("owner");
  for (const change of [
    () => h.db.patch("membership-owner", { isActive: false }),
    async () => {
      await h.db.patch("owner", { role: "admin" });
      await h.db.patch("membership-owner", { role: "admin" });
      await h.db.insert("accessPreviews", { orgId: "org", userId: "owner", asUserId: "manager", expiresAt: NOW + DAY });
    },
    () => h.db.patch("mail", { orgId: "foreign" }),
    () => h.db.patch("launch", { approvedSenderRefs: [] }),
  ]) {
    h.db.rollback(baseline); await change(); const before = h.db.checkpoint();
    await assert.rejects(h.create()); assert.deepEqual(h.db.checkpoint(), before);
  }
  h.db.rollback(baseline);
  await assert.rejects(h.create({ expectSetHash: "caller-hash" }));
  delete configuration.env.TOKEN_ENCRYPTION_KEY;
  await assert.rejects(h.create()); assert.equal(h.db.rows("mailboxSendGrants").length, 0);
});

test("canonical set edits and module-doc, custom, AI or fallback merge injection refuse consent or invalidate it", async () => {
  const h = await world(); await h.create(); const frozen = prepared(await h.prepare()).prepared;
  await h.replaceTemplate("Changed reviewed text");
  assert.equal((await h.validate(frozen)).state, "refused");
  const baseline = h.db.checkpoint();
  for (const body of ["{$doc.note}", "{$vars.text}", "{{custom.note}}", "{{ai.body}}", '{{firstName | default "there"}}']) {
    h.db.rollback(baseline); await h.replaceTemplate(body); const before = h.db.checkpoint();
    assert.equal(await h.options(), null); await assert.rejects(h.create()); assert.deepEqual(h.db.checkpoint(), before);
  }
});

test("preparation freezes escaped canonical values and compliance once, fits the real SQ1 port and writes nothing", async () => {
  const h = await world(); await h.create(); const before = h.db.checkpoint(), result = prepared(await h.prepare()), p = result.prepared;
  const header = p.delivery.headers.listUnsubscribe!;
  const url = header.slice(1, -1);
  assert.equal(p.delivery.subject, "Hi Ada");
  assert.equal(p.delivery.text, `Hello Ada & <Lovelace>.\nFrom Ria <Owner> at owner@example.test.\n\n--\n123 Main St\nUnsubscribe: ${url}`);
  assert.equal(p.delivery.html, `<p>Hello Ada &amp; &lt;Lovelace&gt;.<br>From Ria &lt;Owner&gt; at owner@example.test.</p>\n<p>123 Main St</p>\n<p><a href="${url}">Unsubscribe</a></p>`);
  assert.equal(p.delivery.headers.listUnsubscribePost, "List-Unsubscribe=One-Click");
  assert.equal(p.validUntil, NOW + DAY); assert.equal(p.requestedNotBefore, NOW + 1000);
  assert.equal((await h.validate(p)).state, "valid");
  assert.equal((await port.inspect(h.ctx as never, result.request, { prepared: p, row: { phase: "enqueue", outboundMessageId: null } })).allowed, true);
  assert.equal((await preparation.prepareSq1Email(h.ctx as never, id<"outboxRequests">("request"), { ...h.causal, preparedBy: id<"users">("manager") })).state, "prepared");
  assert.deepEqual(h.db.checkpoint(), before);
  const fallback = await world("Hello {{firstName}}."); await fallback.create();
  await fallback.db.patch("check", { fullName: "", companyId: "acc_company", companyName: "SMITH PAVING INC.", companyOwnerId: "owner" });
  await fallback.db.patch("hot", { values: { ownerId: "owner", fullName: "", email: "Ada@Example.test" } });
  const greeting = prepared(await fallback.prepare()).prepared;
  assert.equal(greeting.delivery.subject, "Hi Smith Paving team");
  assert.equal(greeting.delivery.text.split("\n")[0], "Hello Smith Paving team.");
});

test("revalidation rereads worked projection, access, sender, suppression, footer and canonical request without refresh", async () => {
  const h = await world(); await h.create(); const p = prepared(await h.prepare()).prepared, baseline = h.db.checkpoint();
  for (const change of [
    () => h.db.patch("check", { emailStatus: "catch_all" }),
    () => h.db.patch("owner", { isHidden: true }), () => h.db.patch("membership-owner", { isActive: false }),
    () => h.db.patch("permissions", { rules: [{ object: "contact", fields: [{ apiName: "email", level: "hidden" }] }] }),
    () => h.db.patch("mail", { unipileAccountId: "changed-link" }), () => h.db.patch("enabled", { enabled: false }),
    () => h.db.patch("launch", { authorizationEpoch: 2 }), () => h.db.patch("request", { requestedNotBefore: NOW + 2000 }),
    () => h.db.insert("ledgerEntries", { orgId: "org", streamId: "stream", object: "contact", version: 2 }),
    () => h.db.patch("mapping", { entityId: "missing" }),
    () => h.db.patch("hot", { lifecycle: { status: "deleted" } }),
    () => h.db.patch("org", { outboundEmailPolicy: { postalAddress: "Changed postal address", recipientWeeklyCap: 3 } }),
    () => h.db.insert("suppressions", { orgId: "org", kind: "email", value: "ada@example.test", source: "unsubscribe", state: "active" }),
  ]) {
    h.db.rollback(baseline); await change(); const before = h.db.checkpoint();
    assert.equal((await h.validate(p)).state, "refused"); assert.deepEqual(h.db.checkpoint(), before);
  }
  h.db.rollback(baseline);
  await h.db.insert("ledgerEntries", { orgId: "org", streamId: "stream", object: "contact", version: 2 });
  await h.db.patch("hot", { version: 2, values: { ownerId: "owner", fullName: "Ada & <Lovelace>", email: "Ada@Example.test", title: "Unrelated edit" } });
  assert.equal((await h.validate(p)).state, "valid");
  await h.db.patch("hot", { values: { ownerId: "owner", fullName: "Ada & <Lovelace>", email: "changed@example.test" } });
  assert.equal((await h.validate(p)).state, "refused");
});

test("threaded, manual, company-unproven and ambiguous sender or grant paths stay refused", async () => {
  const h = await world(); await h.create(); const baseline = h.db.checkpoint();
  await h.create(); assert.equal((await h.prepare()).state, "refused"); h.db.rollback(baseline);
  for (const patch of [{ thread: true }, { kind: "manual_email" }]) {
    const launch = (await h.db.get("launch"))!;
    const plan = plain(launch.approvedPlan) as { steps: Array<Record<string, unknown>> };
    Object.assign(plan.steps[0], patch); await h.db.patch("launch", { approvedPlan: plan });
    assert.equal((await h.prepare()).state, "refused"); h.db.rollback(baseline);
  }
  await h.db.insert("emailAccounts", { _id: "second-mail", orgId: "org", userId: "owner", address: "second@example.test", status: "ok" });
  await h.db.patch("launch", { approvedSenderRefs: ["mail", "second-mail"] });
  assert.equal((await h.prepare()).state, "refused");
  const company = await world("Hello {{company.name}}"); await company.create();
  assert.equal((await company.prepare()).state, "refused");
});

test("frozen expiry, token or render changes refuse and never remint under old consent", async () => {
  const h = await world(); await h.create(); const p = prepared(await h.prepare()).prepared, before = h.db.checkpoint(), original = plain(p);
  const changed = plain(p); changed.delivery.text = "Changed authored message";
  assert.equal((await h.validate(changed)).state, "refused");
  delete configuration.env.TOKEN_ENCRYPTION_KEY; assert.equal((await h.validate(p)).state, "refused");
  configuration.env.TOKEN_ENCRYPTION_KEY = "sq1-preparation-fixture-only"; now = p.validUntil;
  assert.equal((await h.validate(p)).state, "refused"); assert.deepEqual(p, original); assert.deepEqual(h.db.checkpoint(), before);
});

test("capacity accepts only the real signed set and bound canonical request pair", async () => {
  const h = await world(); await h.create(); const result = prepared(await h.prepare()), p = result.prepared;
  const allow = await port.inspect(h.ctx as never, result.request, { prepared: p, row: { phase: "enqueue", outboundMessageId: null } });
  assert.equal(allow.allowed, true); if (!allow.allowed) throw new Error("Expected fixed SQ1 preflight");
  const requestRow = (await h.db.get("request"))!;
  const outboundId = await h.db.insert("outboundMessages", { orgId: "org", module: MODULE, cause: port.sq1RequestCause(id<"outboxRequests">("request")), channel: "email", kind: "automated", fromUserId: "owner",
    to: { address: p.recipient.address }, target: `address:${p.recipient.address}`, rendered: { subject: p.delivery.subject, text: p.delivery.text }, state: "held", notBefore: p.requestedNotBefore,
    at: NOW, idempotencyKey: await port.sq1RequestOutboxKey(requestRow as never, p), mailbox: { kind: "sq1.email.v1", prepared: p, request: result.request } });
  await port.bindPreparedRequest(h.ctx as never, allow.checked, id<"outboundMessages">(outboundId));
  const before = h.db.checkpoint();
  assert.equal((await capacity.assessP4MailboxCapacity(h.ctx as never, id<"outboundMessages">(outboundId))).state, "available");
  assert.deepEqual(h.db.checkpoint(), before);
  await h.db.patch(outboundId, { mailbox: { kind: "sq1.email.v1", prepared: p } });
  assert.equal((await capacity.assessP4MailboxCapacity(h.ctx as never, id<"outboundMessages">(outboundId))).state, "refused");
});

async function deliveryWorld() {
  const h = await world();
  configuration.env.CONVEX_SITE_URL = "https://localhost";
  await h.db.patch("mail", { unipileAccountId: "local-mail" });
  await h.db.insert("outboundChannels", { orgId: "org", moduleId: MODULE, channel: "email", enabledBy: "admin", enabledAt: NOW });
  const enqueue = () => mailboxQueue.enqueueSq1Email(h.ctx as never, id<"outboxRequests">("request"), h.causal);
  const claim = async (): Promise<P4MailboxJob[]> => plain(await graph["outboundDispatch.ts"].claim.handler(h.ctx, {}));
  const settle = (job: P4MailboxJob, result: Record<string, unknown> = { ok: true, providerId: "provider-confirmed" }) => graph["outboundDispatch.ts"].settleMailbox.handler(h.ctx, { expected: job.expected, result });
  const direct = () => graph["emailAccounts.ts"].claimSend.handler(h.ctx, { userId: "owner", orgId: "org", accountId: "mail", contactId: "con_direct", to: "direct@example.test", subject: "Direct" });

  const atomic = async (call: () => Promise<unknown>) => {
    const checkpoint = h.db.checkpoint();
    try { return await call(); } catch (error) { h.db.rollback(checkpoint); throw error; }
  };
  return { ...h, enqueue, claim, settle, direct, atomic };
}
function enqueued(value: Awaited<ReturnType<typeof mailboxQueue.enqueueSq1Email>>) {
  assert.ok("id" in value);
  if (!("id" in value)) throw new Error("Expected a frozen outbox row");
  return value;
}

test("trusted enqueue binds held bytes without allowance, then actual claim and paired settlement record one result", async () => {
  const h = await deliveryWorld(); await h.create();
  const queued = enqueued(await h.enqueue()), row = (await h.db.get(queued.id))!, frozen = plain(row.mailbox);
  assert.equal(queued.state, "held"); assert.equal((await h.db.get("request"))!.state, "ready");
  assert.equal((await h.db.get("launch"))!.reservedRequests, 0); assert.equal(h.db.rows("emailSends").length, 0);
  assert.deepEqual(plain(await h.enqueue()), { id: queued.id, state: "held", created: false });
  assert.deepEqual(plain((await h.db.get(queued.id))!.mailbox), frozen);
  now += 1000;
  const [job] = await h.claim(); assert.equal(job.channel, "mailbox");
  assert.equal(job.delivery.prepared.delivery.subject, "Hi Ada");
  assert.equal((await h.db.get("launch"))!.reservedRequests, 1); assert.equal((await h.db.get("request"))!.state, "reserved");
  await graph["outboundDispatch.ts"].settle.handler(h.ctx, { ids: [queued.id], result: { ok: true, providerId: "bare-id" } });
  await graph["emailAccounts.ts"].finishSend.handler(h.ctx, { sendId: job.expected.emailSendId, ok: true, providerId: "direct-finisher", body: "untrusted" });
  assert.equal((await h.db.get(queued.id))!.state, "sending");
  assert.equal((await h.enqueue()).state, "refused");
  assert.equal((await h.settle(job)).state, "recorded"); assert.equal((await h.settle(job)).state, "duplicate");
  assert.equal((await h.db.get(queued.id))!.state, "sent");
  assert.equal((await h.db.get(job.expected.emailSendId))!.receiptRevision, 1);
  assert.equal((await h.db.get("request"))!.state, "sent");
  assert.equal((await h.db.get("launch"))!.reservedRequests, 1); assert.equal(h.db.rows("emailSends").length, 1);
});

async function manifestWorld(names = true) {
  const h = await deliveryWorld(), pkg = (await h.db.get("pkg"))!, manifest = JSON.parse(String(pkg.manifest));
  manifest.templates = { hello: { channel: "email", subject: names ? "Hi {$to.firstName}" : "An update", body: names ? "Hello {$to.name}." : "To {$to.email}." } };
  await h.db.patch("pkg", { manifest: JSON.stringify(manifest), manifestHash: `fixture-manifest-grant-${names}` });
  const review = await graph["mailboxGrants.ts"].mine.handler(h.ctx, { scope: { orgId: "org", userId: "owner" } });
  const grant = await graph["mailboxGrants.ts"].createManifest.handler(h.ctx, { senderId: "mail", moduleId: MODULE, template: "hello", maxPerDay: 10, expiresAt: NOW + DAY,
    expectTemplateHash: review.modules[0].templates[0].hash, expectMailboxLinkHash: review.accounts[0].mailboxLinkHash });
  const input: ManifestPreparationInput = { ...h.causal, contactId: "con_person", moduleId: MODULE, senderId: id<"emailAccounts">("mail"), grantId: grant.grantId, requestedNotBefore: NOW };
  return { ...h, input, manifest: (over: Partial<ManifestPreparationInput> = {}, cause = "trusted-manifest") => mailboxQueue.enqueueManifestEmail(h.ctx as never, { ...input, ...over }, { cause, index: 0 }) };
}

test("the actual dispatcher sends a frozen manifest mailbox through the local mailbox adapter and retains workspace notices", async () => {
  const h = await manifestWorld(), result = enqueued(await h.manifest());
  const frozen = plain((await h.db.get(result.id))!.mailbox);
  const notice = await queue.queueWorkspaceEmail(h.ctx as never, { orgId: id<"organizations">("org"), to: { address: "notice@example.test" }, subject: "Workspace notice", body: "Notice", cause: "workspace-notice" });
  const actionCtx = { scheduler: h.ctx.scheduler, runMutation: async (ref: unknown, args: unknown) => {
    const name = String(ref).split(".").at(-1)!;
    return graph["outboundDispatch.ts"][name].handler(h.ctx, args);
  } };
  await graph["outboundDispatch.ts"].dispatch.handler(actionCtx, {});
  const sent = (await h.db.get(result.id))!;
  assert.equal(sent.state, "sent"); assert.match(String(sent.providerId), /^local-emailSends:/);
  assert.equal((await h.db.get(notice.id))!.providerId, "local");
  const mailbox = sent.mailbox as { prepared: unknown; attempt: { receiptRevision: number } };
  assert.deepEqual(plain(mailbox.prepared), (frozen as { prepared: unknown }).prepared); assert.equal(mailbox.attempt.receiptRevision, 1);
  assert.equal((await h.db.get("launch"))!.reservedRequests, 0);
});

test("actual direct and mailbox claims contend for the same last daily slot in both orderings", async () => {
  const h = await deliveryWorld(); await h.create(); const row = enqueued(await h.enqueue()); now += 1000;
  for (let i = 0; i < 99; i++) await h.db.insert("emailSends", { orgId: "org", accountId: "mail", userId: "owner", contactId: "con_other", to: "other@example.test", subject: "Legacy", state: "sent", at: NOW - 1000 });
  const before = h.db.checkpoint();
  await h.direct(); assert.equal((await h.claim()).length, 0);
  assert.equal((await h.db.get(row.id))!.state, "held"); assert.equal((await h.db.get("launch"))!.reservedRequests, 0);
  h.db.rollback(before);
  assert.equal((await h.claim()).length, 1); await assert.rejects(h.direct());
  assert.equal(h.db.rows("emailSends").length, 100); assert.equal((await h.db.get("launch"))!.reservedRequests, 1);
});

test("idempotent reentry rereads template, grant, recipient, root, suppression and expiry without replacing frozen bytes", async () => {
  const h = await deliveryWorld(); const grant = await h.create();
  const suppression = await h.db.insert("suppressions", { orgId: "org", kind: "email", value: "ada@example.test", source: "unsubscribe", state: "active" });
  const untouched = h.db.checkpoint();
  assert.equal((await h.enqueue()).state, "suppressed"); assert.deepEqual(h.db.checkpoint(), untouched);
  assert.equal((await h.db.get("request"))!.state, "preparing");
  await h.db.delete(suppression);
  const row = enqueued(await h.enqueue()), baseline = h.db.checkpoint();
  const frozen = plain((await h.db.get(row.id))!.mailbox);
  for (const change of [
    () => h.replaceTemplate("Changed canonical template"), () => h.db.patch(grant.grantId, { revokedAt: NOW }),
    () => h.db.patch("hot", { values: { ownerId: "owner", fullName: "Ada & <Lovelace>", email: "changed@example.test" } }),
    () => h.db.patch("membership-owner", { isActive: false }),
    () => h.db.patch("org", { outboundEmailPolicy: { postalAddress: "Changed address", recipientWeeklyCap: 3 } }),
    () => h.db.patch("org", { timezone: "not-a-zone" }),
    async () => { delete configuration.env.TOKEN_ENCRYPTION_KEY; }, async () => { now = NOW + DAY; },
    () => h.db.insert("suppressions", { orgId: "org", kind: "email", value: "ada@example.test", source: "unsubscribe", state: "active" }),
  ]) {
    h.db.rollback(baseline); now = NOW; configuration.env.TOKEN_ENCRYPTION_KEY = "sq1-preparation-fixture-only"; await change();
    const before = h.db.checkpoint(), result = await h.enqueue();
    assert.ok(result.state === "refused" || result.state === "suppressed"); assert.deepEqual(h.db.checkpoint(), before);
    now = Math.max(now, NOW + 1000); assert.equal((await h.claim()).length, 0);
    assert.equal(h.db.rows("emailSends").length, 0); assert.equal((await h.db.get("launch"))!.reservedRequests, 0);
    assert.deepEqual(plain((await h.db.get(row.id))!.mailbox), frozen);
  }
});

test("reserved cause prefix refuses before generic idempotency and malformed mailbox rows cannot poison a healthy claim", async () => {
  const h = await deliveryWorld(); await h.create(); const row = enqueued(await h.enqueue()), saved = (await h.db.get(row.id))!;
  await assert.rejects(queue.enqueue(h.ctx as never, { orgId: id<"organizations">("org"), module: { id: MODULE, title: "Sequences", outbound: undefined }, cause: port.sq1RequestCause(id<"outboxRequests">("request")), index: 0,
    channel: "email", kind: "notice", from: "workspace", to: { address: "ada@example.test" }, target: "address:ada@example.test", rendered: { ok: true, rendered: { text: "collision" } } }));
  for (const [key, mailbox] of [["missing-ref", { kind: "sq1.email.v1", prepared: (saved.mailbox as { prepared: unknown }).prepared }], ["incomplete", { kind: "sq1.email.v1", prepared: {} }], ["no-metadata", undefined]] as const) {
    await h.db.insert("outboundMessages", { ...saved, _id: key, idempotencyKey: key, cause: `canon:sq1.email.v1:${key}`, mailbox });
  }
  now += 1000; assert.equal((await h.claim()).length, 1);
  for (const key of ["missing-ref", "incomplete", "no-metadata"]) assert.equal((await h.db.get(key))!.state, "refused");
  assert.equal((await h.db.get(row.id))!.state, "sending"); assert.equal(h.db.rows("emailSends").length, 1);
});

test("hours, immutable floor and all capacity deadlines combine by maximum while held SQ1 pairs remain uncharged", async () => {
  const h = await deliveryWorld(); await h.create({ expiresAt: NOW + 20 * DAY });
  now = NOW + 2 * DAY + 7 * 3_600_000;
  const floor = NOW + 6 * DAY;
  await h.db.patch("request", { requestedNotBefore: floor });
  const p = prepared(await h.prepare());
  for (let i = 0; i < 100; i++) await h.db.insert("emailSends", { orgId: "org", accountId: "mail", userId: "owner", contactId: "con_other", to: "other@example.test", subject: "Legacy", state: "unknown", at: now - 1000 });
  for (let i = 0; i < 3; i++) await h.db.insert("outboundMessages", { orgId: "org", module: MODULE, cause: `history-${i}`, fromUserId: "owner", channel: "email", kind: "automated", to: { address: p.prepared.recipient.address }, target: `address:${p.prepared.recipient.address}`,
    rendered: { subject: p.prepared.delivery.subject, text: p.prepared.delivery.text }, mailbox: { kind: "sq1.email.v1", prepared: p.prepared, request: p.request }, state: "failed", claimedAt: now - 1000, notBefore: now, at: now, idempotencyKey: `history-${i}` });
  const row = enqueued(await h.enqueue()); assert.equal(row.state, "held");
  assert.equal((await h.db.get(row.id))!.notBefore, now - 1000 + 7 * DAY + 1);
  assert.equal((await h.db.get("launch"))!.reservedRequests, 0); assert.equal((await h.db.get("request"))!.state, "ready");
});

test("lease expiry records paired unknown after uninstall and stale or late results cannot reopen it", async () => {
  const h = await deliveryWorld(); await h.create(); const row = enqueued(await h.enqueue()); now += 1000; const [job] = await h.claim();
  const stale = { ...job, expected: { ...job.expected, attempt: 2 } };
  assert.equal((await h.settle(stale)).state, "refused"); assert.equal((await h.db.get(row.id))!.state, "sending");
  const sending = h.db.checkpoint();
  await h.settle(job, { ok: false, retry: true, error: "Definitive refusal" });
  assert.equal((await h.db.get(row.id))!.state, "failed"); assert.equal((await h.db.get("request"))!.state, "failed");
  assert.equal((await h.claim()).length, 0); h.db.rollback(sending);
  await h.db.delete("pkg"); await h.db.delete("projection"); await h.db.patch("launch", { state: "paused" }); await h.db.patch("enrollment", { state: "finished" });
  now += 120_001; await graph["outboundDispatch.ts"].tick.handler(h.ctx, {});
  assert.equal((await h.db.get(row.id))!.state, "unknown"); assert.equal((await h.db.get(job.expected.emailSendId))!.state, "unknown");
  assert.equal((await h.db.get("request"))!.state, "unknown"); assert.equal((await h.db.get("launch"))!.reservedRequests, 1);
  assert.equal((await h.settle(job)).state, "refused"); assert.equal((await h.claim()).length, 0);
});

test("post-insert bind, post-reservation claim and historical settlement storage errors escape for outer rollback", async () => {
  const h = await deliveryWorld(); await h.create();
  let before = h.db.checkpoint();
  const bindCtx = { ...h.ctx, db: { ...h.db, replace: async () => { throw new Error("storage-bind"); } } };
  await assert.rejects(h.atomic(() => mailboxQueue.enqueueSq1Email(bindCtx as never, id<"outboxRequests">("request"), h.causal)), /storage-bind/);
  assert.deepEqual(h.db.checkpoint(), before);
  const row = enqueued(await h.enqueue()); now += 1000; before = h.db.checkpoint();
  const claimCtx = { ...h.ctx, db: { ...h.db, patch: async (key: string, patch: Record<string, unknown>) => { if (key === row.id) throw new Error("storage-claim"); return h.db.patch(key, patch); } } };
  await assert.rejects(h.atomic(() => graph["outboundDispatch.ts"].claim.handler(claimCtx, {})), /storage-claim/);
  assert.deepEqual(h.db.checkpoint(), before);
  const [job] = await h.claim(); before = h.db.checkpoint();
  const resultCtx = { ...h.ctx, db: { ...h.db, patch: async (key: string, patch: Record<string, unknown>) => { if (key === "request") throw new Error("storage-history"); return h.db.patch(key, patch); } } };
  await assert.rejects(h.atomic(() => graph["outboundDispatch.ts"].settleMailbox.handler(resultCtx, { expected: job.expected, result: { ok: true, providerId: "confirmed" } })), /storage-history/);
  assert.deepEqual(h.db.checkpoint(), before);
});

test("owner and manager may cancel only before claim; approve and send-now never replace mailbox consent", async () => {
  const h = await deliveryWorld(); await h.create(); const row = enqueued(await h.enqueue()), baseline = h.db.checkpoint();
  for (const action of ["approve", "sendNow"]) await assert.rejects(graph["outbound.ts"].act.handler(h.ctx, { id: row.id, action }));
  for (const actor of ["owner", "manager", "admin"]) {
    h.db.rollback(baseline); h.as(actor); await graph["outbound.ts"].act.handler(h.ctx, { id: row.id, action: "cancel" });
    assert.equal((await h.db.get(row.id))!.state, "cancelled");
  }
  h.db.rollback(baseline); h.as("owner"); now += 1000; await h.claim();
  await assert.rejects(graph["outbound.ts"].act.handler(h.ctx, { id: row.id, action: "cancel" }));
});

async function editRecipient(h: Awaited<ReturnType<typeof deliveryWorld>>, values: Record<string, unknown>) {
  const row = (await h.db.get("hot"))!, version = Number(row.version) + 1;
  await h.db.insert("ledgerEntries", { orgId: "org", streamId: "stream", object: "contact", version });
  await h.db.patch("hot", { version, values: { ...(row.values as Record<string, unknown>), ...values } });
}

test("one manifest logical effect refuses destination drift before reminting after queue, claim, terminal result or a legacy row", async () => {
  const h = await manifestWorld(), row = enqueued(await h.manifest()), baseline = h.db.checkpoint();
  assert.equal(row.state, "queued");
  for (const state of ["queued", "sending", "sent", "unknown", "legacy"] as const) {
    h.db.rollback(baseline);
    if (state === "legacy") await h.db.patch(row.id, { mailboxEffectKey: undefined });
    else if (state !== "queued") {
      const [job] = await h.claim();
      if (state !== "sending") await h.settle(job, state === "sent" ? { ok: true, providerId: "confirmed" } : { ok: false, unknown: true, retry: false, error: "Unknown" });
    }
    await editRecipient(h, { email: "changed@example.test" });
    const before = h.db.checkpoint();
    assert.equal((await h.manifest()).state, "refused"); assert.deepEqual(h.db.checkpoint(), before);
    assert.equal(h.db.rows("outboundMessages").length, 1);
    assert.equal(h.db.rows("emailSends").length, state === "queued" || state === "legacy" ? 0 : 1);
  }
});

test("manifest address idempotency refuses incompatible canonical contacts sharing one normalized email and generic reentry", async () => {
  const h = await manifestWorld(); enqueued(await h.manifest());
  await h.db.insert("canonExternalIds", { orgId: "org", provider: "record:contact", externalId: "con_shared", entityId: "shared-stream" });
  await h.db.insert("canonEntities", { _id: "shared-stream", orgId: "org", entityType: "contact" });
  await h.db.insert("recordRows", { orgId: "org", streamId: "shared-stream", object: "contact", version: 1, lifecycle: { status: "active" }, values: { ownerId: "owner", fullName: "Another Contact", email: " ADA@EXAMPLE.TEST " } });
  await h.db.insert("ledgerEntries", { orgId: "org", streamId: "shared-stream", object: "contact", version: 1 });
  const before = h.db.checkpoint();
  assert.equal((await h.manifest({ contactId: "con_shared" })).state, "refused"); assert.deepEqual(h.db.checkpoint(), before);
  await assert.rejects(queue.enqueue(h.ctx as never, { orgId: h.input.orgId, module: { id: MODULE, title: "Sequences", outbound: undefined }, cause: "trusted-manifest", index: 0,
    channel: "email", kind: "notice", from: "workspace", to: { address: "ada@example.test" }, target: "address:ada@example.test", rendered: { ok: true, rendered: { text: "Generic fallback" } } }));
  assert.equal(h.db.rows("outboundMessages").length, 1); assert.equal((await h.claim()).length, 1);
});

test("proven manifest suppression and ordinary preparation refusal persist stable unrendered history that cannot become delivery", async () => {
  for (const state of ["suppressed", "refused"] as const) {
    const h = await manifestWorld();
    const block = state === "suppressed" ? await h.db.insert("suppressions", { orgId: "org", kind: "email", value: "ada@example.test", source: "unsubscribe", state: "active" }) : null;
    if (state === "refused") await h.db.patch("org", { outboundEmailPolicy: { postalAddress: "", recipientWeeklyCap: 3 } });
    const first = enqueued(await h.manifest()), stored = (await h.db.get(first.id))!;
    assert.equal(first.state, state); assert.equal(stored.fromUserId, "owner"); assert.deepEqual(plain(stored.rendered), { text: "" });
    assert.equal(stored.mailbox, undefined); assert.equal((stored.mailboxRefusal as { kind: string }).kind, "manifest.refusal.v1");
    assert.equal(JSON.stringify(stored.mailboxRefusal).includes("grantId"), false);
    if (block) await h.db.delete(block);
    await h.db.patch("org", { outboundEmailPolicy: { postalAddress: "123 Main St", recipientWeeklyCap: 3 } });
    const repeated = enqueued(await h.manifest()); assert.equal(repeated.id, first.id); assert.equal(repeated.state, state); assert.equal(repeated.created, false);
    assert.equal((await h.claim()).length, 0); assert.equal(h.db.rows("outboundMessages").length, 1);
    await h.db.patch(first.id, { state: "held" });
    for (const action of ["approve", "sendNow"]) await assert.rejects(graph["outbound.ts"].act.handler(h.ctx, { id: first.id, action }));
    assert.equal((await h.claim()).length, 0); assert.equal((await h.db.get(first.id))!.state, "refused"); assert.equal(h.db.rows("emailSends").length, 0);
    await h.db.patch("permissions", { rules: [{ object: "contact", fields: [{ apiName: "email", level: "hidden" }] }] });
    const before = h.db.checkpoint(); assert.equal((await h.manifest({}, "another-effect")).state, "refused"); assert.deepEqual(h.db.checkpoint(), before);
  }
  const h = await manifestWorld(), channel = h.db.rows("outboundChannels")[0];
  await h.db.delete(channel._id); const first = enqueued(await h.manifest());
  assert.equal(first.state, "refused"); assert.equal(((await h.db.get(first.id))!.rendered as { text: string }).text.startsWith("Hello Ada"), true);
  await h.db.insert("outboundChannels", channel);
  const repeated = enqueued(await h.manifest()); assert.equal(repeated.id, first.id); assert.equal(repeated.state, "refused"); assert.equal(repeated.created, false);
  assert.equal((await h.claim()).length, 0); assert.equal(h.db.rows("emailSends").length, 0);
});

async function readBoth(h: Awaited<ReturnType<typeof deliveryWorld>>) {
  const ctx = { auth: h.ctx.auth, db: { get: h.db.get, query: h.db.query, normalizeId: h.db.normalizeId } };

  const settingsCtx = (await h.db.get("owner"))!.role === "admin" ? ctx : { ...ctx, auth: { getUserIdentity: async () => ({
    subject: "admin", tokenIdentifier: "session:admin", issuer: "https://clerk.test", org_id: "clerk-org",
  }) } };
  return [await graph["outbound.ts"].outbox.handler(ctx, { module: MODULE }) ?? [], (await graph["outbound.ts"].settings.handler(settingsCtx, {}))?.rows ?? []] as Array<Array<{ id: string; text: string }>>;
}

test("both public outbound readers recheck current mailbox contact fields, scope, tenant, sender and preview access", async () => {
  const h = await manifestWorld();
  await h.db.patch("owner", { role: "manager" }); await h.db.patch("membership-owner", { role: "manager" });
  await h.db.insert("accessPreviews", { orgId: "org", userId: "admin", asUserId: "owner", expiresAt: NOW + DAY });
  const row = enqueued(await h.manifest());
  const ordinary = await h.db.insert("outboundMessages", { orgId: "org", module: MODULE, cause: "ordinary", channel: "slack", kind: "notice", fromUserId: "owner",
    to: { slack: "safe-channel" }, target: "slack:safe-channel", rendered: { text: "Ordinary notice" }, state: "sent", notBefore: NOW, at: NOW, idempotencyKey: "ordinary" });
  for (const rows of await readBoth(h)) { assert.equal(rows.some((r) => r.id === row.id), true); assert.equal(rows.find((r) => r.id === row.id)!.text.startsWith("Hello Ada"), true); }
  const baseline = h.db.checkpoint();
  for (const change of [
    () => h.db.patch("manager-permissions", { rules: [{ object: "contact", fields: [{ apiName: "email", level: "hidden" }] }] }),
    () => h.db.patch("manager-permissions", { rules: [{ object: "contact", fields: [{ apiName: "fullName", level: "hidden" }] }] }),
    () => h.db.patch("manager-permissions", { rules: [{ object: "contact", read: false }] }),
    () => editRecipient(h, { ownerId: "admin" }), () => h.db.patch("membership-owner", { isActive: false }),
    () => h.db.patch("mapping", { orgId: "foreign" }), () => h.db.patch("mail", { orgId: "foreign" }),
    async () => { await h.db.patch("owner", { role: "admin" }); await h.db.patch("membership-owner", { role: "admin" }); await h.db.insert("accessPreviews", { orgId: "org", userId: "owner", asUserId: "manager", expiresAt: NOW + DAY }); await h.db.patch("manager-permissions", { rules: [{ object: "contact", read: false }] }); },
  ]) {
    h.db.rollback(baseline); await change();
    for (const rows of await readBoth(h)) assert.equal(rows.some((r) => r.id === row.id), false);
  }
  h.db.rollback(baseline); await h.db.patch("manager-permissions", { rules: [{ object: "contact", fields: [{ apiName: "email", level: "hidden" }] }] });
  for (const rows of await readBoth(h)) assert.equal(rows.find((r) => r.id === ordinary)?.text, "Ordinary notice");
  h.db.rollback(baseline); await h.db.patch(h.input.grantId, { revokedAt: NOW });
  for (const rows of await readBoth(h)) assert.equal(rows.some((r) => r.id === row.id), true);
});

test("email-only and unrendered mailbox history need no hidden name; revoked email access hides both public rows", async () => {
  const h = await manifestWorld(false);
  await h.db.patch("owner", { role: "manager" }); await h.db.patch("membership-owner", { role: "manager" });
  await h.db.insert("accessPreviews", { orgId: "org", userId: "admin", asUserId: "owner", expiresAt: NOW + DAY });
  const emailOnly = enqueued(await h.manifest());
  await h.db.insert("suppressions", { orgId: "org", kind: "email", value: "ada@example.test", source: "unsubscribe", state: "active" });
  const history = enqueued(await h.manifest({}, "suppressed-history"));
  await h.db.patch("manager-permissions", { rules: [{ object: "contact", fields: [{ apiName: "fullName", level: "hidden" }] }] });
  for (const rows of await readBoth(h)) { assert.equal(rows.some((r) => r.id === emailOnly.id), true); assert.equal(rows.some((r) => r.id === history.id), true); }
  const metadata = plain((await h.db.get(emailOnly.id))!.mailbox) as Record<string, unknown>;
  await h.db.patch(emailOnly.id, { mailbox: { ...metadata, recipientMergeFields: undefined } });
  for (const rows of await readBoth(h)) { assert.equal(rows.some((r) => r.id === emailOnly.id), false); assert.equal(rows.some((r) => r.id === history.id), true); }
  await h.db.patch(emailOnly.id, { mailbox: metadata });
  await h.db.patch("manager-permissions", { rules: [{ object: "contact", fields: [{ apiName: "email", level: "hidden" }] }] });
  for (const rows of await readBoth(h)) { assert.equal(rows.some((r) => r.id === emailOnly.id), false); assert.equal(rows.some((r) => r.id === history.id), false); }
});

test("SQ1 still refuses before history or readiness and historical settlement ignores current read revocation", async () => {
  const h = await deliveryWorld(); await h.create();
  const block = await h.db.insert("suppressions", { orgId: "org", kind: "email", value: "ada@example.test", source: "unsubscribe", state: "active" });
  const before = h.db.checkpoint(); assert.equal((await h.enqueue()).state, "suppressed"); assert.deepEqual(h.db.checkpoint(), before);
  assert.equal(h.db.rows("outboundMessages").length, 0); assert.equal((await h.db.get("request"))!.state, "preparing");
  await h.db.delete(block); const row = enqueued(await h.enqueue()); now += 1000;
  const good = h.db.checkpoint(); await h.db.patch(row.id, { mailboxEffectKey: "not-an-sq1-key" });
  assert.equal((await h.enqueue()).state, "refused"); assert.equal((await h.claim()).length, 0); assert.equal((await h.db.get("launch"))!.reservedRequests, 0);
  h.db.rollback(good); const [job] = await h.claim();
  await h.db.patch("permissions", { rules: [{ object: "contact", fields: [{ apiName: "email", level: "hidden" }] }] });
  assert.equal((await graph["outbound.ts"].outbox.handler(h.ctx, { module: MODULE })).length, 0);
  await h.db.delete("pkg"); assert.equal((await h.settle(job)).state, "recorded");
  assert.equal((await h.db.get("request"))!.state, "sent"); assert.equal((await h.db.get(job.expected.emailSendId))!.state, "sent");
});
