import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const NOW = 1_800_000_000_000;
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const configuration = { env: { CANON_SERVICE_JWT_ISSUER: "https://service.test" } as Record<string, string> };
const loaded = loadConvex(["outboundEmailPolicy.ts", "lib/outbound/emailPolicy.ts", "organizations.ts"], {}, {
  process: configuration, Date: class extends Date { static now() { return NOW; } },
});
const rules = loaded["lib/outbound/emailPolicy.ts"] as unknown as typeof import("../convex/lib/outbound/emailPolicy.ts");
function world(demo = false) {
  let actor: string | null = demo ? null : "admin", activeOrg = "clerk-org", service = false;
  configuration.env.FSGTM_ENABLE_DEMO_DATA = demo ? "true" : "false";
  const db = memoryDb({
    organizations: [{ _id: "org", clerkOrgId: "clerk-org", timezone: "America/New_York" }, { _id: "foreign", clerkOrgId: "clerk-foreign", timezone: "UTC" }],
    users: ["admin", "manager", "rep"].map((id) => ({ _id: id, orgId: "org", clerkUserId: demo && id === "admin" ? "dev_user_fullstackgtm" : `session:${id}`, role: id, isActive: true })),
    orgMemberships: ["admin", "manager", "rep"].map((id) => ({ _id: `membership-${id}`, userId: id, orgId: "org", role: id, isActive: true })),
  });
  const ctx = { db, auth: { getUserIdentity: async () => actor ? { subject: actor, tokenIdentifier: `session:${actor}`, issuer: service ? "https://service.test" : "https://clerk.test", org_id: activeOrg } : null } };
  const call = (name: string, args: Record<string, unknown> = {}) => loaded["outboundEmailPolicy.ts"][name].handler(ctx, args);
  const save = (over: Record<string, unknown> = {}) => call("save", { postalAddress: "123 Main St\nNew York, NY 10001", recipientWeeklyCap: 3, ...over });
  const preparation = async () => rules.policyForAutomatedEmail(await db.get("org") as never);
  const organization = (name: string) => loaded["organizations.ts"][name].handler(ctx, {});
  return { db, call, save, preparation, organization, as: (id: string | null, agent = false) => { actor = id; service = agent; }, org: (id: string) => { activeOrg = id; } };
}

test("a human admin configures normalized postal text and can lower then restore the bounded cap", async () => {
  const h = world();
  assert.deepEqual(plain(await h.call("get")), { postalAddress: "", recipientWeeklyCap: 3, timezone: "America/New_York", updatedAt: null });
  assert.equal((await h.preparation()).state, "refused");
  await h.save({ postalAddress: " 123 Main St \r\n New York, NY 10001 \r\n", recipientWeeklyCap: 1 });
  assert.deepEqual(plain((await h.db.get("org"))?.outboundEmailPolicy), {
    postalAddress: "123 Main St\nNew York, NY 10001", recipientWeeklyCap: 1, updatedAt: NOW, updatedBy: "admin",
  });
  assert.deepEqual(plain(await h.preparation()), { state: "allow", policy: { postalAddress: "123 Main St\nNew York, NY 10001", recipientWeeklyCap: 1, timezone: "America/New_York" } });
  await h.save({ recipientWeeklyCap: 3 });
  assert.equal((await h.call("get")).recipientWeeklyCap, 3);
  await h.save({ postalAddress: " \n " });
  assert.equal((await h.call("get")).postalAddress, "");
  assert.equal((await h.preparation()).state, "refused");
  assert.equal((await h.db.get("org"))?.timezone, "America/New_York");
});

test("inactive membership, hidden users, previews and service sessions cannot change policy", async () => {
  const h = world();
  const baseline = h.db.checkpoint();
  for (const change of [
    () => h.db.patch("membership-admin", { isActive: false }),
    () => h.db.patch("membership-admin", { role: "rep" }),
    () => h.db.patch("admin", { isActive: false }),
    () => h.db.patch("admin", { isHidden: true }),
    () => h.db.insert("accessPreviews", { orgId: "org", userId: "admin", asUserId: "rep", expiresAt: NOW + 1000 }),
  ]) {
    await change();
    const before = h.db.checkpoint();
    assert.equal(await h.call("get"), null);
    await assert.rejects(h.save());
    assert.deepEqual(h.db.checkpoint(), before);
    h.db.rollback(baseline);
  }
  for (const actor of ["manager", "rep", null]) {
    h.as(actor);
    assert.equal(await h.call("get"), null);
    await assert.rejects(h.save());
  }
  h.as("admin", true);
  assert.equal(await h.call("get"), null);
  await assert.rejects(h.save());
  assert.equal((await h.db.get("org"))?.outboundEmailPolicy, undefined);
});

test("canonical home membership and the explicit demo session can manage local policy without inventing membership", async () => {
  for (const demo of [false, true]) {
    const h = world(demo);
    await h.db.delete("membership-admin");
    await h.save();
    assert.equal((await h.call("get")).recipientWeeklyCap, 3);
    await h.db.insert("orgMemberships", { userId: "admin", orgId: "org", role: "admin", isActive: false });
    assert.equal(await h.call("get"), null);
    await assert.rejects(h.save());
  }
});

test("live workspace roles cannot inherit outbound admin authority from stored or custom capabilities", async () => {
  const h = world();
  await h.db.insert("orgRoles", { orgId: "org", key: "role_ops", name: "Ops", base: "manager", capabilities: ["strategy.edit", "outbound.manage"] });
  await h.db.patch("membership-admin", { role: "role_ops" });
  assert.equal(await h.call("get"), null);
  await assert.rejects(h.save());
  assert.equal((await h.db.get("org"))?.outboundEmailPolicy, undefined);
  await h.db.patch("admin", { role: "role_ops" });
  await h.db.patch("membership-admin", { role: "admin" });
  await h.save({ recipientWeeklyCap: 2 });
  assert.equal((await h.call("get")).recipientWeeklyCap, 2);
  await h.db.patch("membership-admin", { role: "rep" });
  const before = h.db.checkpoint();
  assert.equal(await h.call("get"), null);
  await assert.rejects(h.save());
  assert.deepEqual(h.db.checkpoint(), before);
});

test("policy writes follow only the live session workspace and its actual membership", async () => {
  const h = world();
  h.org("clerk-foreign");
  assert.equal(await h.call("get"), null);
  await assert.rejects(h.save());
  await h.db.insert("orgMemberships", { orgId: "foreign", userId: "admin", role: "admin", isActive: true });
  await h.save({ recipientWeeklyCap: 2 });
  assert.equal((await h.call("get")).timezone, "UTC");
  assert.equal((await h.db.get("org"))?.outboundEmailPolicy, undefined);
  assert.equal((await h.db.get("foreign"))?.outboundEmailPolicy !== undefined, true);
});

test("generic organization reads advertise availability without disclosing admin policy", async () => {
  const h = world();
  await h.save();
  h.as("rep");
  const context = await h.organization("context");
  assert.equal(context.features.outboundEmailPolicy, true);
  assert.equal(Object.hasOwn(context.organization, "outboundEmailPolicy"), false);
  assert.equal(Object.hasOwn(await h.organization("current"), "outboundEmailPolicy"), false);
  assert.equal(await h.call("get"), null);
});

test("cap bounds and plain-text limits refuse before policy writes", async () => {
  const h = world();
  const before = h.db.checkpoint();
  for (const recipientWeeklyCap of [0, 4, 1.5, NaN, Infinity, null]) await assert.rejects(h.save({ recipientWeeklyCap }));
  for (const postalAddress of ["x".repeat(501), "<b>Address</b>", "Street\u0000City"]) await assert.rejects(h.save({ postalAddress }));
  assert.deepEqual(h.db.checkpoint(), before);
  await h.save({ postalAddress: "x".repeat(500), recipientWeeklyCap: 2 });
  assert.equal((await h.call("get")).postalAddress.length, 500);
});
