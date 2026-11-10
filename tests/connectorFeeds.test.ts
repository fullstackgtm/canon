/**
 * Connector feeds (shared gap P5): a signed webhook's deliveries written through the real receiving mutation.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadConvex, memoryDb } from "./convexHandlers.ts";
import { webhookItem } from "../convex/lib/connectors/webhook.ts";

const M = loadConvex(["connectors.ts"]);
const receive = M["connectors.ts"].receiveWebhook;
const plain = (x: unknown) => JSON.parse(JSON.stringify(x));

function setup() {
  const db = memoryDb({
    organizations: [{ _id: "organizations:org" }],
    connectorLinks: [
      { _id: "connectorLinks:hook", orgId: "organizations:org", connector: "webhook", label: "Usage", status: "ok", secret: "s", createdAt: 0 },
      { _id: "connectorLinks:other", orgId: "organizations:org", connector: "webhook", label: "Forms", status: "ok", secret: "t", createdAt: 0 },
    ],
  });
  const deliver = async (payload: Record<string, unknown>, linkId = "connectorLinks:hook") => {
    const body = JSON.stringify(payload);
    const item = await webhookItem(payload, body);
    return plain(await receive.handler({ db }, { linkId, item: item.ok ? { id: item.id, ...(item.version !== undefined ? { version: item.version } : {}), data: item.data } : { error: item.error } }));
  };
  return { db, deliver };
}

test("the same webhook delivered twice is one feed change; a later version updates it and an older one is dropped", async () => {
  const { db, deliver } = setup();
  const event = { id: "evt_1", type: "usage.daily", version: 2, data: { seats: 14 }, account: { domain: "atlas.io" } };
  assert.deepEqual(await deliver(event), { status: "written", seq: 1 });
  assert.deepEqual(await deliver(event), { status: "unchanged" });
  // Convex returns a stored object's keys in its own order: a replay still matches.
  const [first] = db.rows("feedItems");
  first.data = Object.fromEntries(Object.entries(first.data as Record<string, unknown>).reverse());
  assert.deepEqual(await deliver(event), { status: "unchanged" });
  assert.deepEqual(await deliver({ ...event, version: 3, data: { seats: 15 } }), { status: "written", seq: 2 });
  assert.deepEqual(await deliver({ ...event, version: 1, data: { seats: 9 } }), { status: "stale" });

  const log = db.rows("feedLog").map((r) => [r.seq, (r.before as { data?: unknown } | null)?.data ?? null, (r.after as { data: unknown }).data]);
  assert.deepEqual(plain(log), [[1, null, { seats: 14 }], [2, { seats: 14 }, { seats: 15 }]]);
  // Another webhook's evt_1 is its own item.
  assert.deepEqual(await deliver({ ...event, version: 1 }, "connectorLinks:other"), { status: "written", seq: 3 });
  const [item] = db.rows("feedItems");
  assert.deepEqual(plain([item.itemId, item.version, item.data]), ["connectorLinks:hook:id:evt_1", 3, { type: "usage.daily", occurredAt: null, subject: { domain: "atlas.io" }, data: { seats: 15 } }]);
});

test("an item the feed can't take is refused onto its link, and writes nothing", async () => {
  const { db, deliver } = setup();
  assert.equal((await deliver({ id: "big", type: "usage.daily", data: { blob: "x".repeat(20_000) } })).status, "refused");
  assert.equal((await deliver({ id: "untyped", data: {} })).status, "refused");
  assert.equal(db.rows("feedLog").length, 0);
  const [link] = db.rows("connectorLinks");
  assert.equal(link.lastError, "The body needs a type.");
});


test("explicit webhook subjects preserve legacy routing fields and override their own fields", async () => {
  const subject = async (payload: Record<string, unknown>) => {
    const item = await webhookItem({ type: "usage.daily", account: { domain: "atlas.io" }, ...payload }, "body");
    assert.ok(item.ok);
    return item.data.subject;
  };
  assert.deepEqual(await subject({ subject: "Daily usage" }), { domain: "atlas.io" });
  assert.deepEqual(await subject({ subject: { email: "person@gmail.com" } }), { domain: "atlas.io", email: "person@gmail.com" });
  assert.deepEqual(await subject({ subject: { domain: "northwind.example" } }), { domain: "northwind.example" });
});
