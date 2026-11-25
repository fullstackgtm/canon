import assert from "node:assert/strict";
import test from "node:test";
import { signWebhook, verifyWebhook } from "../convex/lib/agents/webhook.ts";
import { plainObjectDef, resolveObjectDef, STANDARD_OBJECTS } from "../convex/lib/objects/registry.ts";
import type { EntryBody } from "../convex/lib/objects/fold.ts";
import { allowLoopbackWebhooks, backoffMs, destinationProblem, planShard, privateAddress, type EventEntry } from "../convex/lib/recordWebhooks.ts";
import type { deliverPinnedWebhook as DeliverPinnedWebhook } from "../convex/moduleWebActions.ts";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const def = plainObjectDef(resolveObjectDef(STANDARD_OBJECTS.lead));
const defs = new Map([["lead", def]]);
const field = (apiName: string) => def.fields.find((f) => f.apiName === apiName)!.fieldId;
const entry = (seq: number, version: number, body: EntryBody, object = "lead"): EventEntry => ({ object, version, seq, shard: 3, observedAt: 1_800_000_000_000, body });
const assertBody = (status: "accepted" | "proposed", company: string): EntryBody => ({ kind: "assert", status, assertions: [{ fieldId: field("company"), value: company }] });

test("ledger entries become record events; each endpoint gets each entry once, and its cursor moves past what it skipped", () => {
  const entries = [
    entry(1, 1, assertBody("accepted", "Acme")),
    entry(2, 2, assertBody("accepted", "Acme Inc")),
    entry(3, 3, assertBody("proposed", "Acme Corp")),
    entry(4, 3, { kind: "lifecycle", op: "delete" }),
    entry(5, 4, { kind: "lifecycle", op: "restore" }),
    entry(6, 1, { kind: "lifecycle", op: "create" }, "task"),
  ];
  const all = { id: "all", objects: [], events: ["record.created", "record.updated", "record.deleted", "record.restored"], cursors: { "3": 0 } };
  const deletes = { id: "del", objects: ["lead"], events: ["record.deleted"], cursors: { "3": 1 } };
  const plan = planShard([all, deletes], 3, entries, defs, () => "rec_1");

  const sent = plan.deliveries.filter((d) => d.endpointId === "all").map((d) => [d.body.event, d.body.seq]);
  assert.deepEqual(sent, [["record.created", 1], ["record.updated", 2], ["record.deleted", 4], ["record.restored", 5]]);
  assert.deepEqual(plan.deliveries.find((d) => d.body.seq === 2)?.body, {
    event: "record.updated", object: "lead", id: "rec_1", changedFields: ["company"], values: { company: "Acme Inc" }, version: 2,
    at: "2027-01-15T08:00:00.000Z", seq: 2, shard: 3, eventId: "3.2",
  });
  assert.deepEqual(plan.deliveries.filter((d) => d.endpointId === "del").map((d) => d.body.seq), [4]);
  assert.deepEqual(plan.cursors, { all: 6, del: 6 });

  // Planning again from the stored cursors enqueues nothing: no entry is delivered twice.
  const again = planShard([{ ...all, cursors: { "3": 6 } }, { ...deletes, cursors: { "3": 6 } }], 3, entries, defs, () => "rec_1");
  assert.deepEqual(again, { deliveries: [], cursors: {} });
});

test("a delivery is signed like an agent webhook: a replay past the window or a changed body is refused", async () => {
  const body = '{"event":"record.created","eventId":"3.1"}';
  const now = 1_800_000_000_000;
  const ts = String(now / 1000);
  const signature = await signWebhook("whsec_abc", ts, body);
  const check = (o: object) => verifyWebhook({ secret: "whsec_abc", body, timestamp: ts, signature, nowMs: now, ...o }).then((v) => (v.ok ? "ok" : v.reason));
  assert.equal(await check({}), "ok");
  assert.equal(await check({ nowMs: now + 10 * 60_000 }), "stale");
  assert.equal(await check({ body: body.replace("3.1", "3.2") }), "bad_signature");
  assert.deepEqual([1, 2, 7, 8].map(backoffMs), [30_000, 120_000, 21_600_000, null]);
});

test("destinations: https and public names only, loopback only on a local stack", () => {
  const refused = [
    "http://example.com/hook", "https://127.0.0.1/hook", "https://localhost/hook", "https://10.1.2.3/x", "https://192.168.0.5/x",
    "https://169.254.169.254/latest/meta-data", "https://2130706433/x", "https://0x7f.1/x", "https://[::1]/x", "https://[fd00::1]/x",
    "https://[::ffff:10.0.0.1]/x", "https://db.internal/x", "https://printer.local/x", "https://intranet/x", "https://user:pw@example.com/x", "not a url",
  ];
  for (const url of refused) assert.notEqual(destinationProblem(url), null, url);
  assert.equal(destinationProblem("https://hooks.example.com/canon?x=1"), null);
  assert.equal(destinationProblem("http://127.0.0.1:9000/hook", true), null);
  assert.notEqual(destinationProblem("http://10.0.0.1/hook", true), null);
  assert.notEqual(destinationProblem("http://127.0.0.1:9000/hook"), null);
  for (const ip of ["::ffff:0:127.0.0.1", "::ffff:0:93.184.216.34", "fec0::1", "64:ff9b::127.0.0.1", "64:ff9b::93.184.216.34", "64:ff9b:1::1"]) {
    assert.equal(privateAddress(ip), true, ip);
  }
  assert.equal(privateAddress("2606:4700:4700::1111"), false);
});

test("loopback webhooks stay disabled when CONVEX_SITE_URL is loopback without explicit opt-in", async (t) => {
  const prevSite = process.env.CONVEX_SITE_URL;
  const prevAllow = process.env.CANON_ALLOW_LOOPBACK_WEBHOOKS;
  t.after(() => {
    if (prevSite === undefined) delete process.env.CONVEX_SITE_URL; else process.env.CONVEX_SITE_URL = prevSite;
    if (prevAllow === undefined) delete process.env.CANON_ALLOW_LOOPBACK_WEBHOOKS; else process.env.CANON_ALLOW_LOOPBACK_WEBHOOKS = prevAllow;
  });
  assert.equal(allowLoopbackWebhooks({ CONVEX_SITE_URL: "http://127.0.0.1:3211" }), false);
  assert.equal(allowLoopbackWebhooks({ CONVEX_SITE_URL: "http://localhost:3211" }), false);
  assert.equal(allowLoopbackWebhooks({ CONVEX_SITE_URL: "http://127.0.0.1:3211", CANON_ALLOW_LOOPBACK_WEBHOOKS: "true" }), true);

  const admin = { _id: "u1", orgId: "org1", role: "admin", isActive: true };
  const loaded = loadConvex(["recordWebhooks.ts"], {
    "lib.ts": (r) => ({ ...r, getCurrentUser: async () => admin, requireUser: async () => admin }),
    "ledgerFeed.ts": (r) => ({ ...r, orgObjectDefs: async () => [def], shardHeads: async () => ({ "0": 0 }) }),
  });
  const db = memoryDb({ organizations: [{ _id: "org1" }], users: [admin] });
  process.env.CONVEX_SITE_URL = "http://127.0.0.1:3211";
  delete process.env.CANON_ALLOW_LOOPBACK_WEBHOOKS;

  await assert.rejects(
    loaded["recordWebhooks.ts"].insertEndpoint.handler({ db }, {
      url: "http://127.0.0.1:8787/internal", objects: [], events: ["record.created"], secret: { v: 1, iv: "a", ct: "b" },
    }),
  );
  assert.equal((await loaded["recordWebhooks.ts"].list.handler({ db }, {})).local, false);

  process.env.CANON_ALLOW_LOOPBACK_WEBHOOKS = "true";
  const id = await loaded["recordWebhooks.ts"].insertEndpoint.handler({ db }, {
    url: "http://127.0.0.1:9000/hook", objects: [], events: ["record.created"], secret: { v: 1, iv: "a", ct: "b" },
  });
  assert.ok(id);
});

test("recordWebhooks.deliver routes through the DNS-pinned Node action instead of unpinned fetch", async (t) => {
  const prevSite = process.env.CONVEX_SITE_URL;
  const prevAllow = process.env.CANON_ALLOW_LOOPBACK_WEBHOOKS;
  t.after(() => {
    if (prevSite === undefined) delete process.env.CONVEX_SITE_URL; else process.env.CONVEX_SITE_URL = prevSite;
    if (prevAllow === undefined) delete process.env.CANON_ALLOW_LOOPBACK_WEBHOOKS; else process.env.CANON_ALLOW_LOOPBACK_WEBHOOKS = prevAllow;
  });
  process.env.CONVEX_SITE_URL = "http://127.0.0.1:3211";
  delete process.env.CANON_ALLOW_LOOPBACK_WEBHOOKS;

  const loaded = loadConvex(["recordWebhooks.ts", "moduleWebActions.ts"], {
    "lib/tokenHelpers.ts": (r) => ({ ...r, decryptFromStorage: async () => "whsec_test" }),
  }, {
    fetch: async () => { throw new Error("unpinned fetch must not be called"); },
  });
  const rw = loaded["recordWebhooks.ts"];
  const deliverPinned = loaded["moduleWebActions.ts"].deliverPinnedWebhook as unknown as typeof DeliverPinnedWebhook;
  const db = memoryDb({
    users: [{ _id: "u1", orgId: "org1", role: "admin", isActive: true }],
    recordWebhookEndpoints: [{
      _id: "ep1", orgId: "org1", url: "https://hooks.example.com/canon", objects: [], events: ["record.created"],
      secret: "enc", enabled: true, cursors: {}, createdBy: "u1", createdAt: 1, updatedAt: 1,
    }],
    recordWebhookDeliveries: [{
      _id: "del1", orgId: "org1", endpointId: "ep1", shard: 0, seq: 1, event: "record.created", object: "lead",
      payload: '{"event":"record.created"}', status: "pending", attempts: 0, nextAttemptAt: 0, createdAt: 1,
    }],
  });

  const actionCalls: Array<{ ref: string; args: Record<string, unknown> }> = [];
  let lookups = 0;
  const ctx = {
    runMutation: (ref: unknown, args: unknown) => rw[String(ref).split(".").pop()!].handler({ db, scheduler: { runAfter: async () => {} } }, args),
    runAction: async (ref: unknown, args: Record<string, unknown>) => {
      actionCalls.push({ ref: String(ref), args });
      return deliverPinned(args as Parameters<typeof DeliverPinnedWebhook>[0], {
        lookup: async () => {
          lookups++;
          return lookups === 1 ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "127.0.0.1", family: 4 }];
        },
        requestHop: async (_url, addresses, headers) => {
          assert.deepEqual(addresses, [{ address: "93.184.216.34", family: 4 }]);
          assert.match(headers["x-canon-signature"], /^v1=[0-9a-f]{64}$/);
          return { status: 200, headers: new Headers(), body: new Uint8Array() };
        },
      });
    },
  };
  await rw.deliver.handler(ctx, { deliveryId: "del1" });
  assert.equal(actionCalls.length, 1);
  assert.equal(actionCalls[0].ref, "internal.moduleWebActions.postWebhook");
  assert.equal(lookups, 1);
  assert.equal((await db.get("del1"))?.status, "delivered");

  // Private DNS answer fails without retrying.
  const ssrf = await deliverPinned({ url: "https://rebind.example/hook", headers: {}, body: "{}" }, {
    lookup: async () => [{ address: "169.254.169.254", family: 4 }],
  });
  assert.equal(ssrf.ok, false);
  if (!ssrf.ok) assert.equal(ssrf.retry, false);
});
