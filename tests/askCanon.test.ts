import assert from "node:assert/strict";
import test from "node:test";
import { ask, MAX_ROUNDS, type ToolCaller } from "../convex/lib/ask/askLoop.ts";
import { askTools, recordAskData, type AskData, type ObjectInfo } from "../convex/lib/ask/tools.ts";
import { createFakeRecordClient, createMemoryRecordStore, type RecordClient } from "../convex/lib/recordClient.ts";
import { resolveObjectDef, STANDARD_OBJECTS } from "../convex/lib/objects/registry.ts";
import { registerListDef } from "../convex/lib/objects/listSpec.ts";

const READ_METHODS = new Set(["get", "getContact", "listRegister", "listObjects", "searchObjects"]);

/** Two orgs in one record store; the client records every method the tools call. */
async function twoOrgs() {
  const inner = createFakeRecordClient({ store: createMemoryRecordStore(), now: () => 1_000 });
  await inner.upsertAccounts("orgA", { records: [{ domain: "acme.example", name: "Acme" }], source: "pdl", idempotencyKey: "a" });
  await inner.upsertAccounts("orgB", { records: [{ domain: "globex.example", name: "Globex" }], source: "pdl", idempotencyKey: "b" });
  await inner.upsertContacts("orgA", { records: [{ accountDomain: "acme.example", fullName: "Ada Acme", title: "CRO" }], source: "pipe0", idempotencyKey: "ca" });
  await inner.upsertContacts("orgB", { records: [{ accountDomain: "globex.example", fullName: "Gus Globex" }], source: "pipe0", idempotencyKey: "cb" });
  const called = new Set<string>();
  const client = new Proxy(inner, {
    get: (target, key: string) => {
      const member = (target as Record<string, unknown>)[key];
      return typeof member === "function" ? (...args: unknown[]) => (called.add(key), (member as (...a: unknown[]) => unknown).apply(target, args)) : member;
    },
  }) as RecordClient;
  const idOf = async (ws: string, object: "account" | "contact") => (await inner.listRegister(ws, object, {})).rows[0].id;
  return { client, called, a: { account: await idOf("orgA", "account"), contact: await idOf("orgA", "contact") }, b: { account: await idOf("orgB", "account"), contact: await idOf("orgB", "contact") } };
}

const describeObject: AskData["describe"] = async (object): Promise<ObjectInfo | null> => {
  if (object !== "account" && object !== "contact") return null;
  const def = registerListDef(object, resolveObjectDef(STANDARD_OBJECTS[object]));
  return { object, label: def.label, fields: def.fields.map((f) => ({ fieldId: f.fieldId, apiName: f.apiName, label: f.label, type: f.type })) };
};
const noLedger = { describe: describeObject, facts: async () => null, receipts: async () => null };

/** A model that plays back a script of steps and records each prompt. */
function scripted(steps: Array<Record<string, unknown>>) {
  const prompts: string[] = [];
  const schemas: Array<{ properties: { action: { enum: string[] } } }> = [];
  const call: ToolCaller = async (prompt, _tool, schema) => {
    prompts.push(prompt);
    schemas.push(schema as never);
    return steps[Math.min(prompts.length - 1, steps.length - 1)];
  };
  return { call, prompts, schemas };
}

test("tools only ever read the caller's org, whatever ids the model names", async () => {
  const org = await twoOrgs();
  const tools = new Map(askTools(recordAskData(org.client, "orgA", noLedger)).map((t) => [t.name, t]));
  const run = (name: string, args: Record<string, unknown>) => tools.get(name)!.run(args, new Map()) as Promise<Record<string, unknown>>;

  const own = await run("get_record", { object: "account", id: org.a.account });
  assert.equal((own.contacts as unknown[]).length, 1, "reads its own account with its contacts");

  // Org B's ids, named directly: nothing comes back, and nothing of B appears in any listing or search.
  assert.deepEqual(await run("get_record", { object: "account", id: org.b.account }), { error: "No such record in this workspace." });
  assert.deepEqual(await run("get_record", { object: "contact", id: org.b.contact }), { error: "No such record in this workspace." });
  assert.equal(JSON.stringify(await run("search_records", { q: "globex" })).includes("Globex"), false);
  const listed = JSON.stringify(await run("list_records", { object: "account", limit: 25 }));
  assert.ok(listed.includes("Acme") && !listed.includes("Globex"));

  assert.ok(org.called.size > 0 && [...org.called].every((m) => READ_METHODS.has(m)), `only read methods: ${[...org.called]}`);
});

test("a turn searches, reads, and cites only records the tools showed it", async () => {
  const org = await twoOrgs();
  const model = scripted([
    { action: "call", tool: "search_records", args: { q: "acme" } },
    { action: "call", tool: "get_record", args: { object: "account", id: org.a.account } },
    {
      action: "answer",
      answer: `[Acme](/dashboard/records/account/${org.a.account}) has one contact. See [Globex](/dashboard/records/account/${org.b.account}) and [site](https://evil.example/x).`,
      citations: [{ object: "account", id: org.a.account }, { object: "account", id: org.b.account }],
    },
  ]);
  const result = await ask({ tools: askTools(recordAskData(org.client, "orgA", noLedger)), call: model.call }, [], "Who is at Acme?");
  assert.equal(result.rounds, 2);
  assert.equal(result.answer, `[Acme](/dashboard/records/account/${org.a.account}) has one contact. See Globex and site.`);
  assert.deepEqual(result.sources.map((s) => s.href), [`/dashboard/records/account/${org.a.account}`]);
  assert.ok(model.prompts[1].includes("Acme"), "the next call sees the tool result");
});

test("the loop is capped: after MAX_ROUNDS the model may only answer, and a bad tool call comes back as an error", async () => {
  const org = await twoOrgs();
  const model = scripted([{ action: "call", tool: "list_records", args: { object: "account", filters: [{ field: "nope", op: "bogus" }] } }]);
  const result = await ask({ tools: askTools(recordAskData(org.client, "orgA", noLedger)), call: model.call }, [], "loop forever");
  assert.equal(model.prompts.length, MAX_ROUNDS + 1);
  assert.deepEqual(model.schemas.at(-1)!.properties.action.enum, ["answer"]);
  assert.ok(model.prompts[1].includes('"error"'), "the model is told what went wrong");
  assert.match(result.answer, /couldn't work out/);
});
