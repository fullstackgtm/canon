import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const ORG = "org";
const MODULE = "@test/mailbox-consent";
const plain = (x: unknown) => JSON.parse(JSON.stringify(x));
const manifest = {
  id: MODULE, title: "Follow-ups", outbound: { email: { from: ["member_mailbox"], kinds: ["automated"] } },
  templates: {
    hello: { channel: "email", subject: "Hello {$to.firstName}", body: "Hello {$to.name},\nWe can reach you at {$to.email}." },
    fixed: { channel: "email", subject: "A fixed subject", body: "A fixed message." },
    doc: { channel: "email", subject: "Hello", body: "{$doc.note}" },
    vars: { channel: "email", subject: "Hello", body: "{$vars.text}" },
    unknown: { channel: "email", subject: "Hello", body: "{$to.title}" },
    format: { channel: "email", subject: "Hello", body: "{$to.name|json}" },
    malformed: { channel: "email", subject: "Hello", body: "{$to.name" },
    slack: { channel: "slack", text: "Hello" },
  },
};
function world() {
  let now = NOW;
  let actor = "rep";
  let service = false;
  const configuration = { env: { TOKEN_ENCRYPTION_KEY: "mailbox-test-fixture-only", CANON_SERVICE_JWT_ISSUER: "https://service.test" } as Record<string, string> };
  const loaded = loadConvex(["mailboxGrants.ts", "lib/outbound/mailboxGrants.ts"], {}, {
    process: configuration, Date: class extends Date { static now() { return now; } },
  });
  const functions = loaded["mailboxGrants.ts"];
  const policy = loaded["lib/outbound/mailboxGrants.ts"] as unknown as typeof import("../convex/lib/outbound/mailboxGrants.ts");
  const db = memoryDb({
    organizations: [{ _id: ORG }],
    users: ["rep", "boss", "admin"].map((id) => ({ _id: id, clerkUserId: `session:${id}`, orgId: ORG, role: id === "boss" ? "manager" : id,
      name: id, email: `${id}@example.com`, isActive: true })),
    teamGroups: [{ _id: "team", orgId: ORG, managerId: "boss", memberIds: ["rep"] }],
    emailAccounts: [...["rep", "boss", "admin"].map((id) => ({ _id: `mail-${id}`, orgId: ORG, userId: id, address: `${id}@example.com`, provider: "google", status: "ok", unipileAccountId: `private-link-${id}`, connectedAt: NOW - DAY })),
      { _id: "foreign", orgId: "elsewhere", userId: "rep", address: "foreign@example.com", provider: "google", status: "ok", unipileAccountId: "private-foreign", connectedAt: NOW - DAY }],
    modulePackages: [{ _id: "pkg", orgId: ORG, moduleId: MODULE, slug: "mailbox-consent", status: "installed", manifest: JSON.stringify(manifest), manifestHash: "initial" }],
    recipeEnablements: [{ _id: "on", orgId: ORG, point: "module", recipeId: MODULE, contributionKey: "nav", enabled: true }],
  });
  const ctx = { db, auth: { getUserIdentity: async () => ({ subject: actor, tokenIdentifier: `session:${actor}`, issuer: service ? "https://service.test" : "https://clerk.test" }) } };
  const call = (name: string, args: Record<string, unknown> = {}) => functions[name].handler(ctx, name === "mine" ? { scope: { orgId: ORG, userId: actor }, ...args } : args);
  const options = () => call("mine");
  const create = async (over: Record<string, unknown> = {}) => {
    const data = await options();
    const template = data?.modules[0]?.templates.find((t: { name: string }) => t.name === "hello");
    const account = data?.accounts.find((a: { id: string }) => a.id === `mail-${actor}`);
    return call("createManifest", { senderId: `mail-${actor}`, moduleId: MODULE, template: "hello", expectTemplateHash: template?.hash ?? "unavailable", expectMailboxLinkHash: account?.mailboxLinkHash ?? "unavailable", maxPerDay: 10, expiresAt: now + DAY, ...over });
  };
  const read = (grantId: string, over: Record<string, unknown> = {}) => policy.readManifestMailboxGrant(ctx as never, { grantId, orgId: ORG, moduleId: MODULE, senderId: "mail-rep", ...over } as never);
  const changeManifest = async (edit: (m: typeof manifest) => void) => {
    const m = JSON.parse(JSON.stringify(manifest)) as typeof manifest;
    edit(m);
    const text = JSON.stringify(m);
    await db.patch("pkg", { manifest: text, manifestHash: createHash("sha256").update(text).digest("hex") });
  };
  return { db, call, options, create, read, changeManifest, as: (id: string, agent = false) => { actor = id; service = agent; },
    time: (at: number) => { now = at; }, signerOff: () => { delete configuration.env.TOKEN_ENCRYPTION_KEY; } };
}

test("grant pagination refuses stale session scopes before reading another owner's page", async () => {
  const h = world();
  await h.create();
  h.as("boss");
  assert.equal(await h.call("mine", { scope: { orgId: ORG, userId: "rep" }, cursor: "previous-owner-cursor" }), null);
  assert.equal((await h.options()).owner.id, "boss");
  assert.equal(await h.call("mine", { scope: { orgId: "elsewhere", userId: "boss" } }), null);
});

test("a human mailbox owner creates, reads and revokes exact manifest consent without exposing private linkage", async () => {
  const h = world();
  const options = await h.options();
  assert.deepEqual(plain(options.accounts.map((a: { id: string }) => a.id)), ["mail-rep"]);
  assert.deepEqual(plain(options.modules[0].templates.map((t: { name: string }) => t.name)), ["hello", "fixed"]);
  const { grantId } = await h.create();
  const checked = await h.read(grantId);
  assert.ok(checked);
  assert.equal(checked.terms.ownerId, "rep");
  assert.deepEqual(plain(checked.preview), { subject: manifest.templates.hello.subject, body: manifest.templates.hello.body });
  const mine = await h.options();
  assert.equal(mine.grants[0].state, "live");
  assert.equal(mine.grants[0].maxPerDay, 10);
  for (const value of [mine, checked]) {
    const text = JSON.stringify(value);
    assert.equal(text.includes("private-link"), false);
    assert.equal(text.includes("signature"), false);
    assert.equal(text.includes("mailbox-test-fixture-only"), false);
  }
  await h.call("revoke", { grantId });
  await h.call("revoke", { grantId });
  assert.equal(await h.read(grantId), null);
  assert.equal((await h.options()).grants[0].state, "revoked");
  assert.equal(h.db.rows("outboundMessages").length, 0);
  assert.equal(h.db.rows("outboundChannels").length, 0);
});

test("manager, admin, service, preview and inactive sessions cannot impersonate a mailbox owner", async () => {
  const h = world();
  const { grantId } = await h.create();
  for (const id of ["boss", "admin"]) {
    h.as(id);
    assert.deepEqual(plain((await h.options()).grants), []);
    await assert.rejects(h.create({ senderId: "mail-rep" }));
    await assert.rejects(h.call("revoke", { grantId }));
  }
  const { grantId: adminGrant } = await h.create();
  await h.db.insert("accessPreviews", { userId: "admin", orgId: ORG, asUserId: "rep", expiresAt: NOW + DAY });
  assert.equal(await h.options(), null);
  await assert.rejects(h.create());
  await assert.rejects(h.call("revoke", { grantId: adminGrant }));
  h.as("rep", true);
  assert.equal(await h.options(), null);
  await assert.rejects(h.create());
  await assert.rejects(h.call("revoke", { grantId }));
  h.as("rep");
  await assert.rejects(h.create({ senderId: "foreign" }));
  await h.db.insert("orgMemberships", { orgId: ORG, userId: "rep", role: "rep", isActive: false });
  assert.equal(await h.options(), null);
  assert.equal(await h.read(grantId), null);
  await assert.rejects(h.create());
  await assert.rejects(h.call("revoke", { grantId }));
});

test("canonical consent refuses signature, identity, template, connection and expiry drift", async () => {
  const h = world();
  const { grantId } = await h.create();
  const baseline = h.db.checkpoint();
  for (const mutate of [
    () => h.db.patch(grantId, { signature: "0".repeat(64) }),
    () => h.db.patch(grantId, { maxPerDay: 11 }),
    () => h.db.patch("mail-rep", { userId: "boss" }),
    () => h.db.patch("mail-rep", { orgId: "elsewhere" }),
    () => h.db.patch("mail-rep", { address: "new@example.com" }),
    () => h.db.patch("mail-rep", { unipileAccountId: "replacement-link" }),
    () => h.db.patch("mail-rep", { connectedAt: NOW }),
    () => h.db.patch("mail-rep", { status: "disconnected" }),
    () => h.db.patch("rep", { isHidden: true }),
    () => h.db.delete(ORG),
    () => h.db.patch("on", { enabled: false }),
    () => h.db.delete("pkg"),
    () => h.changeManifest((m) => { m.templates.hello.body = "Changed text"; }),
  ]) {
    await mutate();
    assert.equal(await h.read(grantId), null);
    h.db.rollback(baseline);
  }
  for (const over of [{ orgId: "elsewhere" }, { moduleId: "@test/other" }, { senderId: "mail-boss" }]) assert.equal(await h.read(grantId, over), null);
  await h.db.insert("mailboxSendGrants", { ...await h.db.get(grantId), _id: "copied-grant" });
  assert.equal(await h.read("copied-grant"), null);
  h.time(NOW + DAY);
  assert.equal(await h.read(grantId), null);
  assert.equal((await h.options()).grants.find((g: { grantId: string }) => g.grantId === grantId).state, "expired");
});

test("creation requires eligible current template consent, bounded terms and an available signer", async () => {
  const h = world();
  for (const name of ["doc", "vars", "unknown", "format", "malformed", "slack", "missing"]) await assert.rejects(h.create({ template: name }));
  for (const maxPerDay of [0, 1.5, 101]) await assert.rejects(h.create({ maxPerDay }));
  for (const expiresAt of [NOW, NOW - 1, NOW + 90 * DAY + 1, NaN]) await assert.rejects(h.create({ expiresAt }));
  const reviewedHash = (await h.options()).modules[0].templates[0].hash;
  await h.changeManifest((m) => { m.templates.hello.subject = "Updated subject"; });
  await assert.rejects(h.create({ expectTemplateHash: reviewedHash }));
  const reviewedLink = (await h.options()).accounts[0].mailboxLinkHash;
  await h.db.patch("mail-rep", { unipileAccountId: "reconnected" });
  await assert.rejects(h.create({ expectMailboxLinkHash: reviewedLink }));
  const { grantId } = await h.create({ maxPerDay: 100, expiresAt: NOW + 90 * DAY });
  await h.db.patch("mail-rep", { status: "paused" });
  await assert.rejects(h.create());
  await h.call("revoke", { grantId });
  await h.db.patch("mail-rep", { status: "ok" });
  const { grantId: live } = await h.create();
  h.signerOff();
  await assert.rejects(h.create());
  assert.equal(await h.read(live), null);
  assert.equal((await h.options()).signingReady, false);
  await h.call("revoke", { grantId: live });
});
