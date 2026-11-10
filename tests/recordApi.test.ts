import assert from "node:assert/strict";
import test from "node:test";
import { getFunctionName } from "convex/server";
import { authenticate, toV1Error, type V1Client } from "../src/app/api/v1/_lib.ts";
import { createRecord, deleteRecord, listRecords, updateRecord } from "../src/app/api/v1/_records.ts";

const FIELDS = [
  { fieldId: "company", apiName: "company", type: "text" },
  { fieldId: "f_score", apiName: "score", type: "number" },
  { fieldId: "f_vip", apiName: "vip", type: "checkbox" },
];

/** Answers describe like the registry would, records every other call, and replies with `reply[name]`. */
function fake(reply: Record<string, unknown>, def: Record<string, unknown> = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const answer = async (ref: unknown, args: Record<string, unknown>) => {
    const name = getFunctionName(ref as never);
    if (name === "objects:describe") return args.object === "nope" ? null : { fields: FIELDS, register: false, canCreate: true, canDelete: true, writable: true, ...def };
    calls.push({ name, args });
    return reply[name];
  };
  return { calls, client: { query: answer, mutation: answer, action: answer } as unknown as V1Client };
}

const rejects = async (run: Promise<unknown>) => {
  try { await run; } catch (e) { return toV1Error(e); }
  assert.fail("expected a V1Error");
};

test("list turns the query string into the list view's filter and sort, and answers by apiName", async () => {
  const f = fake({ "objects:list": { rows: [{ id: "s1", object: "lead", version: 2, status: "active", title: "Acme", values: { f_score: 7 }, createdAt: 1, updatedAt: 2, deletedAt: null }], nextCursor: "c2", total: 9 } });
  const res = await listRecords(f.client, "lead", new URLSearchParams("filter=score:gte:5&filter=vip:eq:true&filter=company:in:a,b&filter=company:empty&sort=score:desc&limit=10&deleted=true"));
  assert.deepEqual(f.calls[0].args, {
    object: "lead", limit: 10, deleted: true, sort: { field: "score", dir: "desc" },
    filter: [{ field: "score", op: "gte", value: 5 }, { field: "vip", op: "eq", value: true }, { field: "company", op: "in", value: ["a", "b"] }, { field: "company", op: "empty" }],
  });
  assert.equal(res.status, 200);
  assert.deepEqual((res.body as { data: Array<{ values: unknown }>; total: number; nextCursor: string }).data[0].values, { score: 7 });
  assert.equal((res.body as { total: number; nextCursor: string }).nextCursor, "c2");
  assert.equal((await rejects(listRecords(f.client, "lead", new URLSearchParams("filter=score:like:5")))).code, "invalid_request");
  assert.equal((await rejects(listRecords(f.client, "nope", new URLSearchParams()))).code, "unknown_object");
});

test("update passes expectedVersion through and a stale one is a 409 with the current version", async () => {
  const f = fake({ "objects:write": { status: "conflict", streamId: "s1", version: 4, expectedVersion: 3 } });
  const err = await rejects(updateRecord(f.client, "lead", "s1", { values: { company: "X" }, expectedVersion: 3 }));
  assert.deepEqual(f.calls[0].args, { object: "lead", streamId: "s1", values: { company: "X" }, expectedVersion: 3 });
  assert.equal(err.code, "version_conflict");
  assert.deepEqual(err.details, { currentVersion: 4, expectedVersion: 3 });
});

test("an agent source goes to objects.write as a source kind and comes back 202 proposed", async () => {
  const f = fake({ "objects:write": { status: "proposed", streamId: "s1", version: 5, shard: 0, seq: 1 } });
  const res = await updateRecord(f.client, "lead", "s1", { values: { company: "X" }, source: "agent_run", evidence: "https://x.test", confidence: 0.5 });
  assert.deepEqual(f.calls[0].args, { object: "lead", streamId: "s1", values: { company: "X" }, sourceKind: "agent_run", evidence: "https://x.test", confidence: 0.5 });
  assert.deepEqual({ status: res.status, body: res.body }, { status: 202, body: { status: "proposed", id: "s1", version: 5 } });
});

test("bad input is rejected at the boundary before any write", async () => {
  const f = fake({});
  for (const body of [null, { values: { a: { nested: 1 } } }, { values: {}, source: "root" }, { values: {}, expectedVersion: -1 }, {}]) {
    assert.equal((await rejects(updateRecord(f.client, "lead", "s1", body))).code, "invalid_request");
  }
  assert.equal((await rejects(createRecord(f.client, "lead", { values: {}, expectedVersion: 1 }))).code, "invalid_request");
  assert.equal((await rejects(createRecord(f.client, "deal", { values: { name: "D" }, source: "agent_run" }))).code, "invalid_request");
  assert.deepEqual(f.calls, []);
});

test("objects that cannot be deleted say so; validation errors from the ledger are 422", async () => {
  const f = fake({ "objects:write": { status: "invalid", errors: [{ field: "x", message: "no field x" }] } }, { canDelete: false });
  assert.equal((await rejects(deleteRecord(f.client, "account", "acc_1", new URLSearchParams()))).code, "unsupported");
  const err = await rejects(createRecord(f.client, "lead", { values: { x: 1 } }));
  assert.equal(err.code, "validation_failed");
  assert.deepEqual(err.details, { errors: [{ field: "x", message: "no field x" }] });
});

test("auth: no token is refused in production and an agent token never reaches records", async () => {
  const env = { NEXT_PUBLIC_CONVEX_URL: "http://127.0.0.1:1" };
  const noToken = await rejects(authenticate(new Request("http://x/api/v1/records/lead"), { ...env, NODE_ENV: "production" }));
  assert.equal(noToken.code, "unauthorized");
  const agent = await rejects(authenticate(new Request("http://x/api/v1/records/lead", { headers: { authorization: "Bearer fsgtm_agent_abc" } }), env));
  assert.equal(agent.code, "forbidden");
});

test("company edits: a field the register does not edit, and a rule refusal, are 422 validation_failed", async () => {
  const { ConvexError } = await import("convex/values");
  const base = { fields: [{ fieldId: "name", apiName: "name", type: "text" }, { fieldId: "domain", apiName: "domain", type: "text" }], readOnlyFields: ["domain"], register: true, writable: true };
  const client = { query: async () => base, mutation: async () => null, action: async () => { throw new ConvexError("Name must not be blank"); } } as unknown as V1Client;
  for (const values of [{ domain: "x.test" }, { city: "Oslo" }]) {
    const err = await rejects(updateRecord(client, "account", "acc_1", { values }));
    assert.equal(err.code, "validation_failed");
    assert.equal((err.details?.errors as Array<{ field: string }>)[0].field, Object.keys(values)[0]);
  }
  assert.equal((await rejects(updateRecord(client, "account", "acc_1", { values: { name: "" } }))).code, "validation_failed");
});
