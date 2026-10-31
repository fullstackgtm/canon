import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { ManifestPreparationResult, ManifestRevalidationResult, P4PreparedManifestEmail } from "../convex/lib/outbound/manifestPreparation.ts";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const NOW = 1_800_000_000_000, DAY = 86_400_000, MODULE = "@test/frozen-email";
const configuration = { env: {} as Record<string, string> };
let now = NOW;
const loaded = loadConvex(["lib/outbound/manifestPreparation.ts", "mailboxGrants.ts", "lib/outbound/mailboxGrants.ts", "lib/outbound/unsubscribe.ts"], {}, {
  process: configuration, Date: class extends Date { static now() { return now; } },
});
const preparation = loaded["lib/outbound/manifestPreparation.ts"] as unknown as typeof import("../convex/lib/outbound/manifestPreparation.ts");
const grants = loaded["lib/outbound/mailboxGrants.ts"] as unknown as typeof import("../convex/lib/outbound/mailboxGrants.ts");
const unsubscribe = loaded["lib/outbound/unsubscribe.ts"] as unknown as typeof import("../convex/lib/outbound/unsubscribe.ts");
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const baseManifest = {
  id: MODULE, title: "Follow-up", outbound: { email: { from: ["member_mailbox"], kinds: ["automated"] } },
  templates: {
    hello: { channel: "email", subject: "Hello {$to.firstName}", body: "Hi {$to.name},\nA < B & C. Reach {$to.email}." },
    addressOnly: { channel: "email", subject: "An update", body: "To {$to.email}." },
    bodyName: { channel: "email", subject: "An update", body: "Hello {$to.name}" },
  },
};
const manifestFields = (value: typeof baseManifest) => { const manifest = JSON.stringify(value); return { manifest, manifestHash: createHash("sha256").update(manifest).digest("hex") }; };
function world() {
  now = NOW;
  configuration.env = { TOKEN_ENCRYPTION_KEY: "manifest-preparation-fixture-only", CONVEX_SITE_URL: "https://fixture.convex.site" };
  const db = memoryDb({
    organizations: [{ _id: "org", clerkOrgId: "clerk-org", timezone: "UTC", outboundEmailPolicy: { postalAddress: "123 Main St\nTown, NY 10001", recipientWeeklyCap: 3, updatedAt: NOW, updatedBy: "owner" } }],
    users: ["owner", "manager", "outsider"].map((id) => ({ _id: id, orgId: "org", clerkUserId: `session:${id}`, role: id === "manager" ? "manager" : "rep", isActive: true })),
    orgMemberships: ["owner", "manager"].map((id) => ({ _id: `member-${id}`, orgId: "org", userId: id, role: id === "manager" ? "manager" : "rep", isActive: true })),
    rolePermissions: [{ _id: "rep-policy", orgId: "org", role: "rep", rules: [{ object: "contact", visibility: "own", unowned: false }] },
      { _id: "manager-policy", orgId: "org", role: "manager", rules: [{ object: "contact", visibility: "team", unowned: false }] }],
    teamGroups: [{ _id: "team", orgId: "org", managerId: "manager", memberIds: ["owner"] }],
    emailAccounts: [{ _id: "mail", orgId: "org", userId: "owner", address: "Owner@Example.test", displayName: "Mailbox Owner", status: "ok", provider: "google", unipileAccountId: "private-provider-link", connectedAt: NOW - DAY }],
    modulePackages: [{ _id: "pkg", orgId: "org", moduleId: MODULE, slug: "frozen-email", status: "installed", ...manifestFields(baseManifest) }],
    recipeEnablements: [{ _id: "enabled", orgId: "org", point: "module", recipeId: MODULE, contributionKey: "nav", enabled: true }],
    canonExternalIds: [{ _id: "mapping", orgId: "org", provider: "record:contact", externalId: "con_person", entityId: "stream" }],
    canonEntities: [{ _id: "stream", orgId: "org", entityType: "contact", projectionTable: "recordContacts", projectionId: "con_person" }],
    recordRows: [{ _id: "hot", orgId: "org", streamId: "stream", object: "contact", version: 1, lifecycle: { status: "active" }, values: { ownerId: "owner", email: "Person@Example.test", fullName: "Ada & <Lovelace>" } }],
    ledgerEntries: [{ _id: "entry", orgId: "org", streamId: "stream", object: "contact", version: 1 }],
  });
  const ctx = { db, auth: { getUserIdentity: async () => ({ subject: "owner", tokenIdentifier: "session:owner", issuer: "https://clerk.test", org_id: "clerk-org" }) } };
  const grant = async (template = "hello") => {
    const options = await loaded["mailboxGrants.ts"].mine.handler(ctx, { scope: { orgId: "org", userId: "owner" } });
    return (await loaded["mailboxGrants.ts"].createManifest.handler(ctx, { senderId: "mail", moduleId: MODULE, template,
      expectTemplateHash: options.modules[0].templates.find((t: { name: string }) => t.name === template).hash,
      expectMailboxLinkHash: options.accounts[0].mailboxLinkHash, maxPerDay: 10, expiresAt: NOW + DAY })).grantId as string;
  };
  const input = (grantId: string, over: Record<string, unknown> = {}) => ({ orgId: "org", moduleId: MODULE, preparedBy: "manager", contactId: "con_person", senderId: "mail", grantId, requestedNotBefore: NOW + 60_000, ...over });
  const prepare = (grantId: string, over: Record<string, unknown> = {}) => preparation.prepareManifestEmail(ctx as never, input(grantId, over) as never);
  const validate = (p: P4PreparedManifestEmail) => preparation.revalidateManifestEmail(ctx as never, p);
  const edit = async (values: Record<string, unknown>) => {
    const row = (await db.get("hot"))!;
    const version = Number(row.version) + 1;
    await db.insert("ledgerEntries", { orgId: "org", streamId: "stream", object: "contact", version });
    await db.patch("hot", { version, values: { ...(row.values as Record<string, unknown>), ...values } });
  };
  const manifest = async (change: (m: typeof baseManifest) => void) => { const value = plain(baseManifest); change(value); await db.patch("pkg", manifestFields(value)); };
  return { db, ctx, input, grant, prepare, validate, edit, manifest };
}
function prepared(result: ManifestPreparationResult) {
  assert.equal(result.state, "prepared");
  if (result.state !== "prepared") throw new Error("Expected a prepared email");
  return plain(result.prepared);
}
function refused(result: ManifestPreparationResult | ManifestRevalidationResult) {
  assert.equal(result.state, "refused");
  if (result.state !== "refused") throw new Error("Expected refusal");
  assert.match(result.code, /^outbound\.preparation\./);
}

test("trusted preparation freezes exact escaped delivery, footer and RFC8058 material without writes", async () => {
  const h = world(), grantId = await h.grant();
  const checkpoint = h.db.checkpoint();
  const p = prepared(await h.prepare(grantId));
  const url = `https://fixture.convex.site/outbound/unsubscribe?token=${p.unsubscribe.token}`;
  assert.deepEqual(p.delivery, { subject: "Hello Ada", text: `Hi Ada & <Lovelace>,\nA < B & C. Reach person@example.test.\n\n--\n123 Main St\nTown, NY 10001\nUnsubscribe: ${url}`,
    html: `<p>Hi Ada &amp; &lt;Lovelace&gt;,<br>A &lt; B &amp; C. Reach person@example.test.</p>\n<p>123 Main St<br>Town, NY 10001</p>\n<p><a href="${url}">Unsubscribe</a></p>`,
    headers: { listUnsubscribe: `<${url}>`, listUnsubscribePost: "List-Unsubscribe=One-Click", inReplyTo: null, references: [] } });
  const { mailboxLinkHash, ...sender } = p.sender;
  assert.deepEqual(sender, { id: "mail", ownerId: "owner", name: "Mailbox Owner", address: "owner@example.test" });
  assert.match(mailboxLinkHash, /^[a-f0-9]{64}$/);
  assert.equal(p.purpose, "automated_outreach");
  assert.equal(p.validUntil, NOW + DAY);
  assert.equal(p.requestedNotBefore, NOW + 60_000);
  assert.equal(p.thread, null);
  const token = await unsubscribe.verifyUnsubscribeToken(p.unsubscribe.token);
  assert.deepEqual(plain(token?.terms), { version: 1, orgId: "org", address: "person@example.test", issuedAt: NOW, expiresAt: NOW + DAY });
  assert.equal(JSON.stringify(p).includes("private-provider-link"), false);
  assert.equal((await h.validate(p)).state, "valid");
  assert.equal((await h.validate({ ...p, recipient: { address: p.recipient.address, streamId: p.recipient.streamId, contactId: p.recipient.contactId },
    template: { hash: p.template.hash, name: p.template.name, kind: "manifest" } })).state, "valid");
  assert.deepEqual(h.db.checkpoint(), checkpoint);
});

test("preparer and mailbox owner must both retain live recipient and sender scope", async () => {
  const h = world(), grantId = await h.grant(), p = prepared(await h.prepare(grantId));
  const baseline = h.db.checkpoint();
  for (const change of [
    () => h.db.patch("member-owner", { isActive: false }), () => h.db.patch("member-manager", { isActive: false }),
    () => h.db.patch("owner", { isHidden: true }), () => h.db.patch("manager", { isActive: false }),
    () => h.db.patch("team", { memberIds: [] }),
    () => h.db.patch("rep-policy", { rules: [{ object: "contact", fields: [{ apiName: "email", level: "hidden" }] }] }),
    () => h.db.patch("manager-policy", { rules: [{ object: "contact", read: false }] }),
  ]) {
    await change(); refused(await h.prepare(grantId)); refused(await h.validate(p)); h.db.rollback(baseline);
  }
  refused(await h.prepare(grantId, { preparedBy: "outsider" }));
  await h.db.patch("manager-policy", { rules: [{ object: "contact", visibility: "all" }] });
  await h.db.patch("team", { memberIds: [] });
  refused(await h.prepare(grantId));
});

test("grant, enabled automated manifest and mailbox identity drift refuse frozen delivery", async () => {
  const h = world(), grantId = await h.grant(), p = prepared(await h.prepare(grantId));
  const baseline = h.db.checkpoint();
  for (const change of [
    () => h.db.patch(grantId, { revokedAt: NOW }), () => h.db.patch(grantId, { signature: "0".repeat(64) }),
    () => h.db.patch("mail", { address: "changed@example.test" }), () => h.db.patch("mail", { unipileAccountId: "reconnected" }),
    () => h.db.patch("mail", { status: "disconnected" }), () => h.db.patch("mail", { userId: "manager" }),
    () => h.db.patch("enabled", { enabled: false }), () => h.db.delete("pkg"),
    () => h.manifest((m) => { m.templates.hello.body = "Changed template"; }),
    () => h.manifest((m) => { m.outbound.email.kinds = ["personal"]; }),
  ]) {
    await change(); refused(await h.prepare(grantId)); refused(await h.validate(p)); h.db.rollback(baseline);
  }
  await h.db.patch("mail", { displayName: "New From name" });
  refused(await h.validate(p));
  assert.equal(prepared(await h.prepare(grantId)).sender.name, "New From name");
});

test("freshness advances do not freeze unrelated fields, but selected values and canonical identity do", async () => {
  const h = world(), grantId = await h.grant(), p = prepared(await h.prepare(grantId));
  await h.edit({ title: "Unrelated edit" });
  assert.equal((await h.validate(p)).state, "valid");
  assert.equal(prepared(await h.prepare(grantId)).canonicalMergeHash, p.canonicalMergeHash);
  await h.edit({ fullName: "Grace Hopper" });
  refused(await h.validate(p));
  const emailOnly = prepared(await h.prepare(await h.grant("addressOnly")));
  await h.db.patch("rep-policy", { rules: [{ object: "contact", fields: [{ apiName: "fullName", level: "hidden" }] }] });
  await h.edit({ fullName: "Hidden name changed" });
  assert.equal((await h.validate(emailOnly)).state, "valid");
  await h.edit({ email: "edited@example.test" });
  refused(await h.validate(emailOnly));
  const remap = prepared(await h.prepare(emailOnly.grantId));
  await h.db.insert("canonEntities", { _id: "new-stream", orgId: "org", entityType: "contact", projectionTable: "recordRows", projectionId: "new-hot" });
  await h.db.insert("recordRows", { ...h.db.rows("recordRows")[0], _id: "new-hot", streamId: "new-stream", version: 1 });
  await h.db.insert("ledgerEntries", { orgId: "org", streamId: "new-stream", object: "contact", version: 1 });
  await h.db.patch("mapping", { entityId: "new-stream" });
  refused(await h.validate(remap));
  await h.db.delete("new-hot");
  refused(await h.prepare(emailOnly.grantId));
});

test("canonical footer, suppression and deployment authority are reread without refreshing compliance material", async () => {
  const h = world(), grantId = await h.grant(), p = prepared(await h.prepare(grantId));
  const baseline = h.db.checkpoint();
  for (const postalAddress of ["A different postal address", ""]) {
    await h.db.patch("org", { outboundEmailPolicy: { postalAddress, recipientWeeklyCap: 3, updatedAt: NOW, updatedBy: "owner" } });
    if (!postalAddress) refused(await h.prepare(grantId));
    refused(await h.validate(p)); h.db.rollback(baseline);
  }
  await h.db.patch("org", { outboundEmailPolicy: { postalAddress: p.postalAddress, recipientWeeklyCap: 1, updatedAt: NOW, updatedBy: "owner" } });
  assert.equal((await h.validate(p)).state, "valid");
  h.db.rollback(baseline);
  await h.db.insert("suppressions", { orgId: "org", kind: "email", value: "person@example.test", source: "unsubscribe", state: "active", addedAt: NOW, updatedAt: NOW });
  refused(await h.prepare(grantId)); refused(await h.validate(p)); h.db.rollback(baseline);
  for (const site of ["", "http://external.test", "https://user:pass@fixture.convex.site", "https://fixture.convex.site/path", "https://fixture.convex.site?query=1", "https://fixture.convex.site/#hash", "http://127.0.0.1:1234"]) {
    configuration.env.CONVEX_SITE_URL = site; refused(await h.prepare(grantId)); refused(await h.validate(p));
  }
  configuration.env.CONVEX_SITE_URL = "http://127.0.0.1:1234";
  configuration.env.CANONCRM_LOCAL_STACK = "true"; configuration.env.FSGTM_ENABLE_DEMO_DATA = "true";
  assert.match(prepared(await h.prepare(grantId)).unsubscribe.url, /^http:\/\/127\.0\.0\.1:1234\/outbound\/unsubscribe\?/);
  configuration.env.CONVEX_SITE_URL = "https://fixture.convex.site";
  configuration.env.TOKEN_ENCRYPTION_KEY = "rotated-fixture-only";
  const row = (await h.db.get(grantId))!;
  const key = await grants.mailboxGrantKey(); assert.ok(key);
  await h.db.patch(grantId, { signature: await grants.signMailboxGrant(grants.mailboxGrantTerms(row as never), key) });
  refused(await h.validate(p));
  assert.equal((await h.prepare(grantId)).state, "prepared");
  delete configuration.env.TOKEN_ENCRYPTION_KEY;
  refused(await h.prepare(grantId)); refused(await h.validate(p));
});

test("closed preparation refuses caller payloads, stale projections and unsafe post-substitution content", async () => {
  const h = world(), grantId = await h.grant();
  for (const over of [{ address: "override@example.test" }, { text: "Authored text" }, { purpose: "personal" }, { timezone: "UTC" }, { requestedNotBefore: NaN }, { requestedNotBefore: NOW + DAY }]) refused(await h.prepare(grantId, over));
  const baseline = h.db.checkpoint();
  await h.db.insert("ledgerEntries", { orgId: "org", streamId: "stream", object: "contact", version: 2 });
  refused(await h.prepare(grantId)); h.db.rollback(baseline);
  await h.db.patch("mail", { displayName: "Unsafe\r\nHeader" });
  refused(await h.prepare(grantId)); h.db.rollback(baseline);
  await h.edit({ email: "not<a>safe@example.test" });
  refused(await h.prepare(grantId)); h.db.rollback(baseline);
  await h.manifest((m) => { m.templates.hello.subject = "Hello {$to.name}"; });
  const headerGrant = await h.grant();
  await h.edit({ fullName: "Ada\r\nBcc: other@example.test" });
  refused(await h.prepare(headerGrant));
  await h.edit({ fullName: "x".repeat(20_001) });
  refused(await h.prepare(await h.grant("bodyName")));
});

test("frozen binding tampering and expiry refuse, never change requested time or refresh delivery", async () => {
  const h = world(), grantId = await h.grant(), p = prepared(await h.prepare(grantId));
  const checkpoint = h.db.checkpoint(), original = plain(p);
  now += 1000;
  assert.equal((await h.validate(p)).state, "valid");
  for (const changed of [{ ...p, requestedNotBefore: NOW + 120_000 }, { ...p, purpose: "manual_action" }, { ...p, delivery: { ...p.delivery, text: "Changed" } }, { ...p, thread: { providerId: "not-an-rfc-id" } }]) refused(await h.validate(changed as never));
  now = p.validUntil;
  refused(await h.validate(p));
  assert.deepEqual(p, original);
  assert.deepEqual(h.db.checkpoint(), checkpoint);
  const failure = new Error("Storage unavailable");
  const db = new Proxy(h.db, { get: (target, key) => key === "query" ? () => { throw failure; } : Reflect.get(target, key) });
  now = NOW;
  await assert.rejects(preparation.prepareManifestEmail({ ...h.ctx, db } as never, h.input(grantId) as never), (error) => error === failure);
});
