import assert from "node:assert/strict";
import test from "node:test";
import { loadConvex, memoryDb } from "./convexHandlers.ts";
import { accessOf, type Access } from "../convex/lib/access.ts";
import { scopedRecordClient } from "../convex/lib/scopedRecordClient.ts";
import { createFakeRecordClient, createMemoryRecordStore } from "../convex/lib/recordClient.ts";
import { csvOf } from "../convex/lib/outbound/audience.ts";

const user = { _id: "u", orgId: "ws", role: "rep" };
let access: Access = accessOf({ userId: "u", role: "rep" });
const store = createMemoryRecordStore();
const base = createFakeRecordClient({ store });
const files = loadConvex(["audiences.ts", "audienceActions.ts", "linkedinCadences.ts", "objects.ts"], {
  "lib.ts": (real) => ({ ...real, getCurrentUser: async () => user }),
  "permissions.ts": (real) => ({ ...real, accessFor: async () => access }),
  "records.ts": (real) => ({ ...real, clientFor: () => base, callerClient: (_ctx: unknown, who: { access: Access }) => scopedRecordClient(base, [who.access], async () => null) }),
  "lib/objects/orgDefs.ts": (real) => ({ ...real, loadOrgObject: async () => ({ fields: ["custom.visible", "custom.secret"].map((apiName) => ({ apiName, fieldId: apiName, type: "text" })) }) }),
  "lib/objects/write.ts": (real) => ({ ...real, materialize: async () => ({ state: {} }) }),
  "lib/objects/fold.ts": (real) => ({ ...real, project: () => ({ values: { "custom.visible": "hello", "custom.secret": "private" } }) }),
});
const summary = { total: 2, withEmail: 2, customVariables: ["secret"], computedAt: 1 };
const db = memoryDb({
  audiences: [{ _id: "aud", orgId: "ws", createdBy: "u", name: "People", shared: true, filter: [], summary }],
  users: [user],
  canonEntities: [{ _id: "stream", orgId: "ws", entityType: "contact" }],
  linkedinAccounts: [{ _id: "sender", orgId: "ws", userId: "u", tier: "premium", status: "connected" }],
  linkedinCadences: [{ _id: "cad", orgId: "ws", senderAccountId: "sender", status: "active", steps: [{ kind: "invite" }] }],
});
async function seedPeople() {
  await store.putContacts("ws", ["u", "peer"].map((ownerId) => ({ id: `con_${ownerId}`, accountId: "", fullName: ownerId, ownerId, status: "new", updatedAt: 1, email: `${ownerId}@example.com`, stream: ownerId === "u" ? "stream" : undefined, linkedinUrl: `https://linkedin.com/in/person-${ownerId}` })));
}
const writes: unknown[] = [];
const ctx = { db, runQuery: async (ref: unknown, args: unknown): Promise<unknown> => {
  const [module, name] = String(ref).replace(/^internal\./, "").split(".");
  return files[`${module}.ts`][name].handler(ctx, args);
}, runMutation: async (_ref: unknown, args: unknown) => { writes.push(args); return { inserted: 1, raced: [] }; } };

test("audience list hides system summaries from visibility and field restricted viewers", async () => {
  for (const rules of [[{ object: "contact", visibility: "own" as const, unowned: false }], [{ object: "contact", fields: [{ apiName: "custom.secret", level: "hidden" as const }] }], []]) {
    access = accessOf({ ...user, userId: "u", rules });
    const rows = await files["audiences.ts"].list.handler(ctx, {});
    assert.equal(rows.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(rows[0].summary ?? null)), rules.length ? null : summary);
  }
});

test("LinkedIn preview and enrollment resolve only people visible to the enrolling member", async () => {
  await seedPeople();
  for (const restricted of [true, false]) {
    access = accessOf({ ...user, userId: "u", rules: restricted ? [{ object: "contact", visibility: "own", unowned: false }] : [] });
    const preview = await files["linkedinCadences.ts"].previewEnroll.handler(ctx, { cadenceId: "cad", audienceId: "aud" });
    assert.equal(preview.total, restricted ? 1 : 2);
    writes.length = 0;
    await files["linkedinCadences.ts"].enroll.handler(ctx, { cadenceId: "cad", audienceId: "aud", expectToEnroll: preview.enroll });
    const candidates = writes.flatMap((w: any) => w.candidates);
    assert.deepEqual(candidates.map((c: any) => c.contactId).sort(), restricted ? ["con_u"] : ["con_peer", "con_u"]);
  }
});

test("outbound custom projection removes fields hidden by any principal, preserving visible CSV columns", async () => {
  const restricted = accessOf({ ...user, userId: "u", rules: [{ object: "contact", fields: [{ apiName: "custom.secret", level: "hidden" }] }] });
  const full = accessOf({ ...user, userId: "u" });
  for (const accesses of [[restricted], [full, restricted], [full], []]) {
    const values = await files["objects.ts"].customFieldValues.handler(ctx, { orgId: "ws", streamIds: ["stream"], accesses });
    assert.equal(values.stream["custom.visible"], "hello");
    assert.equal(values.stream["custom.secret"], accesses.includes(restricted) ? undefined : "private");
    const csv = csvOf([{ id: "con_u", fullName: "U", email: null, title: null, company: null, phone: null, linkedinUrl: null, custom: values.stream }]);
    assert.equal(csv.includes("secret"), !accesses.includes(restricted));
  }
});


test("audience preview and CSV use caller field limits through the outbound resolver", async () => {
  await seedPeople();
  for (const restricted of [true, false]) {
    access = accessOf({ ...user, userId: "u", rules: restricted ? [{ object: "contact", fields: [{ apiName: "custom.secret", level: "hidden" }] }] : [] });
    const preview = await files["audienceActions.ts"].preview.handler(ctx, { audienceId: "aud" });
    assert.equal(preview.total, 2);
    assert.equal(preview.withEmail, 2);
    assert.equal(preview.customVariables.includes("secret"), !restricted);
    assert.ok(preview.customVariables.includes("visible"));
    const result = await files["audienceActions.ts"].exportCsv.handler(ctx, { audienceId: "aud" });
    assert.equal(result.count, 2);
    assert.equal(result.csv.includes("private"), !restricted);
    assert.ok(result.csv.includes("hello"));
  }
});
