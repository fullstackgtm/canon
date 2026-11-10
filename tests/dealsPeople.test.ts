import assert from "node:assert/strict";
import test from "node:test";
import { loadConvex, memoryDb } from "./convexHandlers.ts";
import { accessOf } from "../convex/lib/access.ts";
import { createFakeRecordClient, createMemoryRecordStore } from "../convex/lib/recordClient.ts";
import { readRecord, type RecordReadPorts, type RecordReadSpec } from "../convex/lib/modules/recordReads.ts";
import { scopedRecordClient } from "../convex/lib/scopedRecordClient.ts";

// deals.people (PA3, docs/module-plans/attribution.md §10): the people on each deal, as the caller sees them.
const modules = loadConvex(["lib/modules/canonReads.ts"]);
const plan = (modules["lib/modules/canonReads.ts"] as unknown as { planRecordRead: (...args: unknown[]) => Promise<RecordReadSpec> }).planRecordRead;
const ORG = "organizations:org";
const manifest = { reads: { deals: ["name"], people: ["name", "title"] } };
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v));

const db = () => memoryDb({
  organizations: [{ _id: ORG }],
  deals: [
    { _id: "deals:d1", orgId: ORG, name: "Atlas", primaryRepId: "users:rep1" },
    { _id: "deals:d2", orgId: ORG, name: "Birch", primaryRepId: "users:rep2" },
    { _id: "deals:d3", orgId: ORG, name: "Cobalt (legacy roles)", primaryRepId: "users:rep1" },
    { _id: "deals:d4", orgId: ORG, name: "Archived", primaryRepId: "users:rep1", archivedAt: 1 },
    { _id: "deals:other", orgId: "organizations:other", name: "Elsewhere", primaryRepId: "users:rep1" },
  ],
  canonEntities: [
    { _id: "canonEntities:s1", orgId: ORG, projectionId: "deals:d1", projectionTable: "deals" },
    { _id: "canonEntities:s2", orgId: ORG, projectionId: "deals:d2", projectionTable: "deals" },
    { _id: "canonEntities:s3", orgId: ORG, projectionId: "deals:d3", projectionTable: "deals" },
  ],
  associations: [
    { _id: "associations:e1", orgId: ORG, association: "deal_contact", fromId: "canonEntities:s1", toId: "con_ana", label: "champion", primary: false, active: true, createdAt: 2, streamId: "x" },
    { _id: "associations:e2", orgId: ORG, association: "deal_contact", fromId: "canonEntities:s1", toId: "con_ben", label: "economic_buyer", primary: false, active: true, createdAt: 1, streamId: "x" },
    { _id: "associations:e3", orgId: ORG, association: "deal_contact", fromId: "canonEntities:s1", toId: "con_gone", label: "other", primary: false, active: false, createdAt: 3, streamId: "x" },
    { _id: "associations:e4", orgId: ORG, association: "deal_contact", fromId: "canonEntities:s2", toId: "con_ana", label: "influencer", primary: false, active: true, createdAt: 1, streamId: "x" },
  ],
  dealContacts: [{ _id: "dealContacts:l1", orgId: ORG, dealId: "deals:d3", contactId: "con_cy", slot: "champion", contactName: "Cy", setBy: "users:rep1", updatedAt: 1 }],
});

test("planning names each deal's people by its edges (active, oldest first) or its legacy roles, only on deals the caller sees", async () => {
  const ctx = { db: db() };
  const ids = ["deals:d1", "deals:d2", "deals:d3", "deals:d4", "deals:other", "nonsense"];
  const all = plain(await plan(ctx, ORG, null, manifest, "deals.people", { ids }, 100));
  assert.deepEqual(all.members, {
    con_ben: [{ dealId: "deals:d1", role: "economic_buyer" }],
    con_ana: [{ dealId: "deals:d1", role: "champion" }, { dealId: "deals:d2", role: "influencer" }],
    con_cy: [{ dealId: "deals:d3", role: "champion" }],
  });
  assert.deepEqual(all.ids, ["con_ben", "con_ana", "con_cy"]);
  assert.deepEqual(all.fields, ["name", "title"]);
  // A rep who sees only their own deals: Birch's people aren't asked about.
  const rep = accessOf({ userId: "users:rep1", role: "rep", rules: [{ object: "deal", visibility: "own", unowned: false }] });
  assert.deepEqual(plain(await plan(ctx, ORG, rep, manifest, "deals.people", { ids }, 100)).members, {
    con_ben: [{ dealId: "deals:d1", role: "economic_buyer" }], con_ana: [{ dealId: "deals:d1", role: "champion" }], con_cy: [{ dealId: "deals:d3", role: "champion" }],
  });
  // No deal read at all: nothing.
  const blind = accessOf({ userId: "users:rep1", role: "rep", rules: [{ object: "deal", read: false } as never] });
  assert.deepEqual(plain(await plan(ctx, ORG, blind, manifest, "deals.people", { ids }, 100)).ids, []);
});

test("reading: a row per deal and person the caller can see, with the deal and the role", async () => {
  const store = createMemoryRecordStore();
  await store.putContacts("org1", [
    { id: "con_ana", fullName: "Ana Ruiz", title: "VP Marketing", email: "ana@atlas.example", ownerId: "users:rep1", status: "active", updatedAt: 1 },
    { id: "con_ben", fullName: "Ben Okafor", title: "CFO", email: "ben@atlas.example", ownerId: "users:rep2", status: "active", updatedAt: 1 },
  ] as never);
  const base = createFakeRecordClient({ store });
  const ports: RecordReadPorts = { edgesTo: async () => [], dealsOf: async () => ({}), addedTo: async () => [], snapshot: async () => { throw new Error("no"); } };
  const spec: RecordReadSpec = { read: "deals.people", ids: ["con_ben", "con_ana", "con_cy"], since: null, limit: 100, fields: ["name", "title"],
    members: { con_ben: [{ dealId: "d1", role: "economic_buyer" }], con_ana: [{ dealId: "d1", role: "champion" }, { dealId: "d2", role: "influencer" }], con_cy: [{ dealId: "d3", role: "champion" }] } };
  const rows = (got: Array<Record<string, unknown>>) => got.map(({ id, name, dealId, role }) => [id, name, dealId, role]);
  // Canon's own: every person the register still has (Cy's is gone), each on each of their deals.
  assert.deepEqual(rows(await readRecord(base, "org1", ports, spec)), [
    ["con_ben", "Ben Okafor", "d1", "economic_buyer"], ["con_ana", "Ana Ruiz", "d1", "champion"], ["con_ana", "Ana Ruiz", "d2", "influencer"],
  ]);
  // A rep who sees only their own people: Ben isn't read, and no field past the grant is.
  const rep = scopedRecordClient(base, [accessOf({ userId: "users:rep1", role: "rep", rules: [{ object: "contact", visibility: "own", unowned: false }] })], async () => null);
  const seen = await readRecord(rep, "org1", ports, spec);
  assert.deepEqual(rows(seen), [["con_ana", "Ana Ruiz", "d1", "champion"], ["con_ana", "Ana Ruiz", "d2", "influencer"]]);
  assert.equal(seen[0]!.email, undefined);
  await assert.rejects(readRecord(base, "org1", ports, { ...spec, limit: 2 }), /more than 2 records/);
});

test("Forecast's deal insights list the people on the deal, with their roles and when activity last named them", async () => {
  const { calls } = await import("../modules/examples/forecast/server.ts");
  const deal = [{ id: "d1", name: "Atlas", amount: 100, isClosed: false, isWon: false, forecastCategory: "commit" }];
  const acts = [{ id: "a1", at: 5_000, kind: "call", personId: "con_ana" }, { id: "a2", at: 9_000, kind: "meeting", personId: "con_ana" }, { id: "a3", at: 7_000, kind: "note", personId: "con_zed" }];
  const team = [{ id: "con_ben", name: "Ben Okafor", title: "CFO", role: "economic_buyer", dealId: "d1" }, { id: "con_ana", name: "Ana Ruiz", title: null, role: "champion", dealId: "d1" }];
  const out = await calls.insights!({ now: 10_000, caller: { userId: "u", role: "rep" }, args: { deal: "d1" } }, { deal, acts, team });
  const v = out.value as Record<string, unknown>;
  assert.deepEqual([v.people, v.onDeal, v.engaged], [2, 2, 1]);
  assert.deepEqual(v.team, [
    { id: "con_ben", name: "Ben Okafor", title: "CFO", role: "economic buyer", lastAt: null },
    { id: "con_ana", name: "Ana Ruiz", title: null, role: "champion", lastAt: 9_000 },
  ]);
});
