import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { z } from "zod/v4";
import { getFunctionName } from "convex/server";
import { canonTools } from "../src/app/mcp/_canonTools.ts";

/** Records which Convex functions a tool calls, and how. */
function fakeConvex(recordRefs?: boolean) {
  const calls: Array<{ kind: string; name: string; args: unknown }> = [];
  const rec = (kind: string) => async (ref: unknown, args: unknown) => {
    calls.push({ kind, name: getFunctionName(ref as never), args });
    if (kind === "query" && getFunctionName(ref as never) === "modules:describe") return recordRefs === undefined ? {} : { recordRefs };
    if (kind === "query" && getFunctionName(ref as never) === "modules:list") return [];
    if (getFunctionName(ref as never) === "records:bulkRegister") return { results: [{ streamId: "acc_1", result: { status: "applied" } }], unprocessed: [] };
    return kind === "query" && getFunctionName(ref as never) === "deals:list"
      ? [{ _id: "d1", name: "Acme renewal", amount: 5, secret: "x" }, { _id: "d2", name: "Globex", amount: 7 }]
      : { ok: true };
  };
  return { calls, client: { query: rec("query"), mutation: rec("mutation"), action: rec("action") } as never };
}

const SAMPLE_ARGS: Record<string, Record<string, unknown>> = {
  canon_get_deal: { dealId: "d1" },
  canon_field_receipts: { dealId: "d1", attribute: "nextStep" },
  canon_propose_facts: { agentId: "a", sourceKind: "call", title: "t", facts: [{ dealId: "d1", attribute: "nextStep", value: "x" }] },
  canon_fact_batch_status: { batchId: "p1" },
  canon_find_entity: { entityType: "account", domain: "acme.com" },
  canon_entity_receipts: { entityId: "e1", attribute: "custom.ehr_vendor" },
  canon_describe_object: { object: "lead" },
  canon_list_records: { object: "account" },
  canon_search_records: { q: "acme" },
  canon_get_record: { streamId: "s1" },
};

// The action twins of reads a narrowed role cannot be judged by in a query (CP14) read only.
const READ_ACTIONS = new Set(["objects:list", "objects:search", "records:get", "canonGate:entityReceiptsScoped", "canonGate:myBatchStatusScoped", "canonGate:reviewQueueScoped"]);

test("record updates accept typed splits while fact proposals retain their scalar input contract", () => {
  const splits = [{ userId: "users:ada", percentage: 100, kind: "revenue" }];
  const update = canonTools.find((t) => t.name === "canon_update_record")!;
  assert.equal(z.object(update.inputSchema).safeParse({ object: "deal", id: "deal", values: { splitAllocations: splits }, expectedVersion: 2 }).success, true);
  const propose = canonTools.find((t) => t.name === "canon_propose_facts")!;
  assert.equal(z.object(propose.inputSchema).safeParse({ agentId: "a", sourceKind: "call", title: "Proposal", facts: [{ dealId: "d1", attribute: "splitAllocations", value: splits }] }).success, false);
});

test("read tools only read; every write tool is marked, and only record removals and edits are destructive", async () => {
  for (const tool of canonTools.filter((t) => !t.writes)) {
    const f = fakeConvex();
    await tool.run(f.client, SAMPLE_ARGS[tool.name] ?? {});
    for (const c of f.calls) {
      assert.ok(c.kind === "query" || (c.kind === "action" && READ_ACTIONS.has(c.name)), `${tool.name} is read-only but called ${c.kind} ${c.name}`);
    }
  }
  assert.deepEqual(canonTools.filter((t) => t.destructive).map((t) => t.name), ["canon_update_record", "canon_delete_record", "canon_review", "canon_duplicates"]);
});

test("update_record edits accounts through the register and other objects with a version check", async () => {
  const tool = canonTools.find((t) => t.name === "canon_update_record")!;
  const account = fakeConvex();
  await tool.run(account.client, { object: "account", id: "r1", values: { industry: "Software" } });
  const [edit] = account.calls as Array<{ kind: string; name: string; args: Record<string, unknown> }>;
  assert.equal(edit.name, "records:edit");
  assert.deepEqual({ ...edit.args, idempotencyKey: typeof edit.args.idempotencyKey }, { object: "account", id: "r1", patch: { industry: "Software" }, idempotencyKey: "string" });
  const deal = fakeConvex();
  await tool.run(deal.client, { object: "deal", id: "s1", values: { stage: "Won" }, expectedVersion: 3 });
  assert.deepEqual(deal.calls, [{ kind: "action", name: "objects:writeScoped", args: { object: "deal", streamId: "s1", values: { stage: "Won" }, expectedVersion: 3 } }]);
});

test("upserts keep a caller's idempotency key so a retried batch is not added twice", async () => {
  const f = fakeConvex();
  const accounts = [{ domain: "acme.com", name: "Acme" }];
  await canonTools.find((t) => t.name === "canon_upsert_accounts")!.run(f.client, { accounts, idempotencyKey: "k1" });
  assert.deepEqual(f.calls, [{ kind: "action", name: "records:upsert", args: { object: "account", accounts, idempotencyKey: "k1" } }]);
});

test("propose passes the batch through to canonGate.proposeScoped unchanged", async () => {
  const f = fakeConvex();
  await canonTools.find((t) => t.name === "canon_propose_facts")!.run(f.client, SAMPLE_ARGS.canon_propose_facts);
  assert.deepEqual(f.calls, [{ kind: "action", name: "canonGate:proposeScoped", args: SAMPLE_ARGS.canon_propose_facts }]);
});

test("list_deals filters by name and returns compact deals", async () => {
  const f = fakeConvex();
  const out = await canonTools.find((t) => t.name === "canon_list_deals")!.run(f.client, { nameContains: "acme" });
  assert.deepEqual(out, [{ _id: "d1", name: "Acme renewal", amount: 5 }]);
});

test("grouped tools dispatch a named action to its function and refuse unknown ones", async () => {
  const research = canonTools.find((t) => t.name === "canon_research")!;
  const f = fakeConvex();
  await research.run(f.client, { action: "claim", args: { token: "t1" } });
  assert.deepEqual(f.calls, [{ kind: "mutation", name: "researchSessions:claim", args: { token: "t1" } }]);
  await assert.rejects(() => research.run(fakeConvex().client, { action: "drop_everything" }), /Unknown action/);
  assert.equal(canonTools.find((t) => t.name === "canon_signals")!.writes, true);
});

test("every grouped action calls its Convex function as the kind it is registered as", async () => {
  const kinds = new Map<string, string>();
  for (const tool of canonTools) {
    const options = (tool.inputSchema.action as { options?: string[] } | undefined)?.options;
    for (const action of options ?? []) {
      const f = fakeConvex();
      await tool.run(f.client, { action, args: {} });
      for (const c of f.calls) kinds.set(c.name, c.kind);
    }
  }
  for (const [name, kind] of kinds) {
    const [file, fn] = name.split(":");
    const source = readFileSync(new URL(`../convex/${file}.ts`, import.meta.url), "utf8");
    const actual = new RegExp(`export const ${fn} = (query|mutation|action)\\(`).exec(source)?.[1] ?? "missing";
    assert.equal(kind, actual, `${name} is a ${actual} but an MCP tool calls it as a ${kind}`);
  }
});

test("module writes preserve the legacy mutation until the backend advertises record refs", async () => {
  const tool = canonTools.find((t) => t.name === "canon_module")!;
  const args = { module: "visit-log", op: "visits.update", key: "visit", expect: 2, data: { title: "Updated" } };
  for (const recordRefs of [undefined, true]) {
    const f = fakeConvex(recordRefs);
    await tool.run(f.client, { action: "op", args });
    assert.deepEqual(f.calls, [
      { kind: "query", name: "modules:describe", args: { module: "visit-log" } },
      { kind: recordRefs ? "action" : "mutation", name: recordRefs ? "modules:writeOp" : "modules:op", args },
    ]);
  }
});


test("MCP line-item CRUD schemas admit the object and forward versioned writes to Canon", async () => {
  for (const [name, args, fn] of [
    ["canon_create_record", { object: "lineItem", values: { dealId: "d1", productId: "p1", quantity: 1, totalPrice: 999 } }, "objects:writeScoped"],
    ["canon_update_record", { object: "lineItem", id: "s1", values: { totalPrice: 777 }, expectedVersion: 2 }, "objects:writeScoped"],
    ["canon_delete_record", { object: "lineItem", streamId: "s1", expectedVersion: 3 }, "objects:remove"],
    ["canon_delete_record", { object: "lineItem", streamId: "s1", restore: true, expectedVersion: 4 }, "objects:restore"],
    // A company or person archives as its own page does, not through objects.remove (which refuses them).
    ["canon_delete_record", { object: "account", streamId: "acc_1" }, "records:bulkRegister"],
  ] as const) {
    const tool = canonTools.find((t) => t.name === name)!;
    assert.equal(z.object(tool.inputSchema).safeParse(args).success, true);
    const f = fakeConvex();
    await tool.run(f.client, args);
    assert.equal(f.calls[0].name, fn);
    if ("expectedVersion" in args) assert.equal((f.calls[0].args as { expectedVersion: number }).expectedVersion, args.expectedVersion);
  }
});
