/**
 * A board on any object (docs/core-crm-parity.md, "Group-by and views on any object"): its columns, and moving a
 * card, which is the record page's own edit (src/components/records/board-move.ts).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadConvex, memoryDb } from "./convexHandlers.ts";
import { boardColumns } from "../convex/lib/objects/views.ts";
import { moveRecord, type MoveCalls } from "../src/components/records/board-move.ts";

const ORG = "organizations:org";
const ADMIN = { _id: "users:ada", orgId: ORG, role: "admin", name: "Ada", isActive: true };
const REP = { _id: "users:avery", orgId: ORG, role: "rep", name: "Avery", isActive: true };
let user: typeof ADMIN = ADMIN;
const M = loadConvex(["objects.ts", "dataModel.ts"], {
  "lib.ts": (real) => ({ ...real, getCurrentUser: async () => user, requireUser: async () => user, requireAdmin: async () => user }),
});
const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value ?? null));

function workspace() {
  const db = memoryDb({
    organizations: [{ _id: ORG }],
    users: [ADMIN, REP],
    // A rep sees only their own leads, and may not change a lead's source.
    rolePermissions: [{ _id: "rolePermissions:rep", orgId: ORG, role: "rep", rules: [{ object: "lead", visibility: "own", unowned: false, fields: [{ apiName: "leadSource", level: "readOnly" }] }] }],
  });
  const ctx = { db, scheduler: { runAfter: async () => {} } };
  const call = async (file: string, name: string, args: unknown) => {
    const checkpoint = db.checkpoint();
    try { return plain(await M[file]![name]!.handler(ctx as never, args as never)); } catch (error) { db.rollback(checkpoint); throw error; }
  };
  const calls: MoveCalls = { write: (args) => call("objects.ts", "write", args), edit: async () => { throw new Error("not a register object"); } };
  return { call, calls };
}

const move = (calls: MoveCalls, field: string, row: { id: string; version: number }, key: string | null) =>
  moveRecord(calls, { object: "lead", register: false, field }, row, key, "move-1");

test("a moved card is the mover's edit of that field, in the record's history", async () => {
  const { call, calls } = workspace();
  user = ADMIN;
  const created = await call("objects.ts", "write", { object: "lead", values: { lastName: "Lovelace", status: "new", ownerId: REP._id } });
  user = REP;
  const before = await call("objects.ts", "get", { streamId: created.streamId });
  const out = await move(calls, "status", { id: created.streamId, version: before.version }, "working");
  assert.equal(out.problem, null);
  assert.equal(out.saves.length, 1);
  assert.equal((await call("objects.ts", "get", { streamId: created.streamId })).values.status, "working");
  const history = await call("objects.ts", "history", { streamId: created.streamId, paginationOpts: { numItems: 10, cursor: null } });
  assert.deepEqual(history.page.map((e: { actor: { id: string }; body: { assertions: unknown[] } }) => [e.actor.id, e.body.assertions]), [
    [REP._id, [{ fieldId: "status", value: "working" }]],
    [ADMIN._id, [{ fieldId: "lastName", value: "Lovelace" }, { fieldId: "status", value: "new" }, { fieldId: "ownerId", value: REP._id }]],
  ]);
});

test("a refused move says why and changes nothing: a required field, a field the role can't write, a record the caller can't edit", async () => {
  const { call, calls } = workspace();
  user = ADMIN;
  const tier = await call("dataModel.ts", "createField", { object: "lead", label: "Tier", type: "picklist", options: [{ label: "Gold" }, { label: "Silver" }] });
  await call("dataModel.ts", "updateFieldDef", { object: "lead", fieldId: tier.fieldId, required: true });
  const desc = await call("objects.ts", "describe", { object: "lead" });
  const gold = desc.fields.find((f: { apiName: string }) => f.apiName === tier.apiName).options[0].value;
  const mine = await call("objects.ts", "write", { object: "lead", values: { lastName: "Mine", [tier.apiName]: gold, leadSource: "web", ownerId: REP._id } });
  const theirs = await call("objects.ts", "write", { object: "lead", values: { lastName: "Theirs", [tier.apiName]: gold, status: "new" } });
  const snapshot = async () => [await call("objects.ts", "get", { streamId: mine.streamId }), await call("objects.ts", "get", { streamId: theirs.streamId })];
  const versionOf = async (streamId: string) => (await call("objects.ts", "get", { streamId })).version;

  user = REP;
  const start = await snapshot();
  // Into "No tier" on a required field; into another source, which the rep's role keeps read-only; another rep's lead.
  const refusals = [
    await move(calls, tier.apiName, { id: mine.streamId, version: await versionOf(mine.streamId) }, null),
    await move(calls, "leadSource", { id: mine.streamId, version: await versionOf(mine.streamId) }, "event"),
    await move(calls, "status", { id: theirs.streamId, version: start[1] === null ? 1 : start[1].version }, "working"),
  ];
  // Each for its own reason, not one shared failure.
  refusals.forEach((r, i) => {
    assert.match(r.problem ?? "", [/required/, /read-only/, /not found/][i]!);
    assert.deepEqual(r.saves, []);
  });
  assert.deepEqual(await snapshot(), start);
  user = ADMIN;
  assert.equal((await call("objects.ts", "get", { streamId: theirs.streamId })).values.status, "new");
});

test("columns follow the field's order with a No value column; empty, inactive and former values keep a column", () => {
  const status = { type: "picklist", label: "Status", options: [{ value: "new", label: "New", active: true }, { value: "old", label: "Old", active: false }, { value: "won", label: "Won", active: true }] };
  // "lost" was an option once: its records keep a column, which takes no cards.
  assert.deepEqual(boardColumns(status, [], ["won", null, "lost"]), [
    { key: "new", label: "New", accepts: true },
    { key: "old", label: "Old (inactive)", accepts: false },
    { key: "won", label: "Won", accepts: true },
    { key: "lost", label: "lost", accepts: false },
    { key: null, label: "No status", accepts: true },
  ]);
  const members = [{ _id: "users:ada", name: "Ada" }, { _id: "users:bo", name: "Bo", isActive: false }, { _id: "users:cy", name: "Cy" }];
  assert.deepEqual(boardColumns({ type: "user", label: "Owner" }, members, ["users:bo", "users:gone"]).map((c) => [c.key, c.label, c.accepts]), [
    ["users:ada", "Ada", true], ["users:cy", "Cy", true], ["users:bo", "Bo (inactive)", false], ["users:gone", "Former member", false], [null, "No owner", true],
  ]);
  assert.deepEqual(boardColumns({ type: "checkbox", label: "Do not call" }, []).map((c) => c.label), ["Yes", "No", "Not set"]);
});
