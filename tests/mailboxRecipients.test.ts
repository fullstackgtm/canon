import assert from "node:assert/strict";
import { test } from "node:test";
import type { CanonicalRecipientResult } from "../convex/lib/outbound/recipients.ts";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const source = loadConvex(["lib/outbound/recipients.ts"])["lib/outbound/recipients.ts"] as unknown as typeof import("../convex/lib/outbound/recipients.ts");
function world() {
  const db = memoryDb({
    organizations: [{ _id: "org" }, { _id: "foreign-org" }],
    users: [
      ...["owner", "peer", "boss", "admin"].map((id) => ({ _id: id, orgId: "org", role: id === "boss" ? "manager" : id === "admin" ? "admin" : "rep", isActive: true })),
      { _id: "foreign-user", orgId: "foreign-org", role: "admin", isActive: true },
    ],
    orgMemberships: [{ _id: "membership", orgId: "org", userId: "owner", role: "rep", isActive: true }],
    rolePermissions: [
      { _id: "rep-policy", orgId: "org", role: "rep", rules: [{ object: "contact", visibility: "own", unowned: false }] },
      { _id: "manager-policy", orgId: "org", role: "manager", rules: [{ object: "contact", visibility: "team", unowned: false }] },
    ],
    teamGroups: [{ _id: "team", orgId: "org", managerId: "boss", memberIds: ["owner"] }],
    canonExternalIds: [{ _id: "mapping", orgId: "org", provider: "record:contact", externalId: "con_person", entityId: "stream" }],

    canonEntities: [{ _id: "stream", orgId: "org", entityType: "contact", projectionTable: "recordContacts", projectionId: "con_person", label: "Private cached label" }],
    recordRows: [{ _id: "hot", orgId: "org", streamId: "stream", object: "contact", version: 1, lifecycle: { status: "active" },
      values: { ownerId: "owner", email: " Person@Example.com ", fullName: "  Ada Lovelace  ", title: "Private title" } }],
    ledgerEntries: [{ _id: "entry-1", orgId: "org", streamId: "stream", object: "contact", version: 1 }],
  });
  const read = async (over: Record<string, unknown> = {}) => plain(await source.readCanonicalMailboxRecipient({ db } as never,
    { orgId: "org", contactId: "con_person", principalIds: ["owner"], mergeFields: ["name", "firstName", "email"], ...over } as never));
  const edit = async (values: Record<string, unknown>) => {
    const row = await db.get("hot");
    const version = Number(row?.version) + 1;
    await db.insert("ledgerEntries", { orgId: "org", streamId: "stream", object: "contact", version });
    await db.patch("hot", { version, values: { ...(row?.values as Record<string, unknown>), ...values } });
  };
  const policy = (rules: Array<Record<string, unknown>>) => db.patch("rep-policy", { rules });
  return { db, read, edit, policy };
}
function allowed(result: CanonicalRecipientResult) {
  assert.equal(result.allowed, true);
  if (!result.allowed) throw new Error("Expected an allowed recipient");
  return result.binding;
}
function refused(result: CanonicalRecipientResult, code: string) {
  assert.equal(result.allowed, false);
  if (result.allowed) throw new Error("Expected a refused recipient");
  assert.equal(result.refused.code, code);
  assert.equal(typeof result.refused.text, "string");
}

test("a worked owned contact supplies only selected canonical merge data without writes", async () => {
  const h = world();
  const before = h.db.checkpoint();
  assert.deepEqual(allowed(await h.read()), { contactId: "con_person", streamId: "stream", version: 1, address: "person@example.com",
    merge: { name: "Ada Lovelace", firstName: "Ada", email: "person@example.com" } });
  assert.deepEqual(allowed(await h.read({ mergeFields: ["email"] })).merge, { email: "person@example.com" });
  assert.deepEqual(allowed(await h.read({ mergeFields: [] })).merge, {});
  assert.deepEqual(h.db.checkpoint(), before);
});

test("each invocation rereads destination and selected values while unrelated edits only advance freshness", async () => {
  const h = world();
  const initial = allowed(await h.read());
  await h.edit({ title: "An unrelated edit" });
  const unrelated = allowed(await h.read());
  assert.equal(unrelated.version, 2);
  assert.deepEqual({ ...unrelated, version: initial.version }, initial);
  await h.edit({ email: "new@example.com", fullName: "Grace Hopper" });
  const current = allowed(await h.read());
  assert.equal(current.version, 3);
  assert.equal(current.address, "new@example.com");
  assert.deepEqual(current.merge, { name: "Grace Hopper", firstName: "Grace", email: "new@example.com" });
  assert.equal(initial.address, "person@example.com");
});

test("causal principals must remain live nonhidden workspace members on every read", async () => {
  const h = world();
  allowed(await h.read());
  const baseline = h.db.checkpoint();
  for (const change of [
    () => h.db.patch("membership", { isActive: false }),
    () => h.db.patch("owner", { isActive: false }),
    () => h.db.patch("owner", { isHidden: true }),
    () => h.db.delete("owner"),
  ]) {
    await change();
    refused(await h.read(), "principal_unavailable");
    h.db.rollback(baseline);
  }
  for (const principalIds of [["missing"], ["foreign-user"], ["owner", "foreign-user"]]) {
    refused(await h.read({ principalIds }), "principal_unavailable");
  }
  refused(await h.read({ principalIds: [] }), "invalid_request");
});

test("record ownership and live team scope apply to every principal without admin expansion", async () => {
  const h = world();
  allowed(await h.read({ principalIds: ["boss"] }));
  refused(await h.read({ principalIds: ["owner", "peer", "admin"] }), "contact_forbidden");
  await h.db.patch("team", { memberIds: [] });
  refused(await h.read({ principalIds: ["boss"] }), "contact_forbidden");
  await h.edit({ ownerId: "peer" });
  refused(await h.read(), "contact_forbidden");
  allowed(await h.read({ principalIds: ["peer"] }));
});

test("live object read permission and membership role changes revoke recipient access", async () => {
  const h = world();
  allowed(await h.read());
  await h.policy([{ object: "contact", read: false }]);
  refused(await h.read(), "contact_forbidden");
  await h.policy([{ object: "contact", read: true }]);
  allowed(await h.read());
  await h.db.patch("membership", { role: "restricted" });
  await h.db.insert("rolePermissions", { orgId: "org", role: "restricted", rules: [{ object: "contact", read: false }] });
  refused(await h.read(), "contact_forbidden");
});

test("hidden email always refuses and hidden name never leaks into email-only results", async () => {
  const h = world();
  await h.policy([{ object: "contact", fields: [{ apiName: "fullName", level: "hidden" }] }]);
  assert.deepEqual(allowed(await h.read({ mergeFields: ["email"] })), {
    contactId: "con_person", streamId: "stream", version: 1, address: "person@example.com", merge: { email: "person@example.com" },
  });
  for (const field of ["name", "firstName"]) refused(await h.read({ mergeFields: [field] }), "field_unavailable");
  await h.policy([{ object: "contact", fields: [{ apiName: "email", level: "hidden" }] }]);
  for (const mergeFields of [[], ["name"], ["email"]]) refused(await h.read({ mergeFields }), "field_unavailable");
});

test("missing or malformed canonical destination and requested names cannot use cached metadata", async () => {
  const h = world();
  await h.edit({ fullName: " " });
  refused(await h.read(), "field_unavailable");
  allowed(await h.read({ mergeFields: ["email"] }));
  for (const email of [null, "", "invalid", "person@localhost"]) {
    await h.edit({ email });
    refused(await h.read({ mergeFields: [] }), "field_unavailable");
  }
});

test("a hot row must match the latest actual ledger head, including its tenant and object", async () => {
  const h = world();
  const baseline = h.db.checkpoint();
  for (const change of [
    () => h.db.insert("ledgerEntries", { orgId: "org", streamId: "stream", object: "contact", version: 2 }),
    () => h.db.patch("hot", { version: 2 }),
    () => h.db.patch("hot", { version: 0 }),
    () => h.db.patch("hot", { version: 1.5 }),
    () => h.db.patch("hot", { version: Number.MAX_SAFE_INTEGER + 1 }),
    () => h.db.patch("entry-1", { orgId: "foreign-org" }),
    () => h.db.patch("entry-1", { object: "account" }),
    () => h.db.delete("entry-1"),
    () => h.db.insert("ledgerEntries", { orgId: "org", streamId: "stream", object: "contact", version: 1 }),
  ]) {
    await change();
    refused(await h.read(), "projection_unavailable");
    h.db.rollback(baseline);
  }
});

test("unworked, deferred, deleted, merged or ambiguous projections never fold or promote during reads", async () => {
  const h = world();
  const baseline = h.db.checkpoint();
  for (const change of [
    () => h.db.delete("hot"),
    () => h.db.patch("hot", { lifecycle: { status: "deleted" } }),
    () => h.db.patch("hot", { lifecycle: { status: "merged", into: "elsewhere" } }),
    () => h.db.patch("hot", { object: "account" }),
    () => h.db.patch("hot", { orgId: "foreign-org" }),
    () => h.db.insert("recordRows", { ...h.db.rows("recordRows")[0], _id: "duplicate-hot" }),
  ]) {
    await change();
    const before = h.db.checkpoint();
    refused(await h.read(), "projection_unavailable");
    assert.deepEqual(h.db.checkpoint(), before);
    h.db.rollback(baseline);
  }
});

test("record aliases resolve their current unique canonical stream, never email or projection pointers", async () => {
  const h = world();
  const baseline = h.db.checkpoint();
  for (const change of [
    () => h.db.patch("mapping", { provider: "email", externalId: "person@example.com" }),
    () => h.db.patch("mapping", { orgId: "foreign-org" }),
    () => h.db.patch("mapping", { entityId: "missing" }),
    () => h.db.patch("stream", { orgId: "foreign-org" }),
    () => h.db.patch("stream", { entityType: "account" }),
    () => h.db.patch("stream", { mergedInto: "other-stream" }),
    () => h.db.insert("canonExternalIds", { orgId: "org", provider: "record:contact", externalId: "con_person", entityId: "stream" }),
  ]) {
    await change();
    refused(await h.read(), "contact_unavailable");
    h.db.rollback(baseline);
  }
  await h.db.insert("canonEntities", { _id: "new-stream", orgId: "org", entityType: "contact", projectionTable: "recordRows", projectionId: "new-hot" });
  await h.db.insert("recordRows", { ...h.db.rows("recordRows")[0], _id: "new-hot", streamId: "new-stream", values: { ownerId: "owner", email: "remapped@example.com", fullName: "New Person" } });
  await h.db.insert("ledgerEntries", { orgId: "org", streamId: "new-stream", object: "contact", version: 1 });
  await h.db.patch("mapping", { entityId: "new-stream" });
  const remapped = allowed(await h.read());
  assert.equal(remapped.streamId, "new-stream");
  assert.equal(remapped.address, "remapped@example.com");
  await h.db.insert("canonExternalIds", { orgId: "org", provider: "record:contact", externalId: "con_person", entityId: "stream" });
  refused(await h.read(), "contact_unavailable");
});

test("unknown merge fields, malformed ids and supplied address or access snapshots cannot bypass canonical reads", async () => {
  const h = world();
  for (const over of [
    { contactId: "person@example.com" }, { contactId: "con_" }, { contactId: "con_has space" },
    { mergeFields: ["company"] }, { mergeFields: ["title"] }, { mergeFields: [null] },
    { email: "caller@example.com" }, { address: "caller@example.com" }, { name: "Caller supplied" },
    { access: { role: "admin" } }, { principalIds: [null] },
  ]) refused(await h.read(over), "invalid_request");
  refused(await h.read({ contactId: "con_missing" }), "contact_unavailable");
  await h.edit({ email: null });
  refused(await h.read({ email: "caller@example.com" }), "invalid_request");
  refused(await h.read(), "field_unavailable");
});
