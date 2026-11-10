import assert from "node:assert/strict";
import test from "node:test";
import { ConvexError } from "convex/values";
import { getFunctionName } from "convex/server";
import { toV1Error, type V1Client } from "../src/app/api/v1/_lib.ts";
import { changeAssociation, dismissDuplicates, logActivity, mergeRecords, setDealRole, undoMerge } from "../src/app/api/v1/_relations.ts";
import { canonTools } from "../src/app/mcp/_canonTools.ts";

/** Records each Convex call by function name; a name in `deny` throws the admin-only error the function throws. */
function fake(deny: string[] = []) {
  const calls: Array<{ name: string; args: unknown }> = [];
  const answer = async (ref: unknown, args: unknown) => {
    const name = getFunctionName(ref as never);
    if (deny.includes(name)) throw new ConvexError("Only admins and managers can merge records");
    calls.push({ name, args });
    return { ok: true };
  };
  return { calls, client: { query: answer, mutation: answer, action: answer } as unknown as V1Client };
}

test("MCP tools call the dashboard's functions with the arguments given", async () => {
  const f = fake();
  const run = (tool: string, action: string, args: Record<string, unknown>) =>
    canonTools.find((t) => t.name === tool)!.run(f.client as never, { action, args });
  await run("canon_duplicates", "merge", { object: "contact", survivorId: "a", loserIds: ["b"], picks: { title: "b" } });
  await run("canon_duplicates", "dismiss", { object: "account", ids: ["a", "b"] });
  await run("canon_associations", "make_primary", { contactId: "c1", accountId: "a1" });
  await run("canon_deal_roles", "set_role", { streamId: "s1", contactId: "c1", role: "champion" });
  await run("canon_activities", "log", { object: "note", values: { body: "hi" }, targets: [{ object: "deal", id: "s1" }] });
  assert.deepEqual(f.calls.map((c) => [c.name, (c.args as { object?: string }).object]), [
    ["recordMerges:merge", "contact"], ["duplicates:dismiss", "account"], ["associations:makePrimary", undefined],
    ["dealCommittee:setRole", undefined], ["activityTargets:logScoped", "note"],
  ]);
});

test("REST writes call the same functions, and a role refusal is a 403", async () => {
  const f = fake();
  await mergeRecords(f.client, "account", { survivorId: "a", loserIds: ["b"], picks: {} });
  await undoMerge(f.client, "m1");
  await dismissDuplicates(f.client, "account", { ids: ["a", "b"] });
  await changeAssociation(f.client, { op: "set_parent", accountId: "a", parentId: null });
  await setDealRole(f.client, "s1", { contactId: "c1", role: "signer", reason: "sent the order form" });
  const logged = await logActivity(f.client, { object: "call", values: {}, targets: [{ object: "contact", id: "c1" }] });
  assert.deepEqual(f.calls.map((c) => c.name), [
    "recordMerges:merge", "recordMerges:undo", "duplicates:dismiss", "associations:setParent", "dealCommittee:setRole", "activityTargets:logScoped",
  ]);
  assert.equal(logged.status, 201);
  const denied = fake(["recordMerges:merge"]);
  await assert.rejects(mergeRecords(denied.client, "account", { survivorId: "a", loserIds: ["b"] }), (e) => toV1Error(e).code === "forbidden");
});

test("canon_recipes, Customization's old tool name, still runs the same actions as canon_customization", async () => {
  const current = canonTools.find((t) => t.name === "canon_customization")!;
  const legacy = canonTools.find((t) => t.name === "canon_recipes")!;
  assert.equal(legacy.run, current.run);
  assert.equal(legacy.inputSchema, current.inputSchema);
  assert.equal(legacy.writes, current.writes);
  assert.equal(legacy.destructive, current.destructive);
  const f = fake();
  for (const tool of ["canon_customization", "canon_recipes"]) await canonTools.find((t) => t.name === tool)!.run(f.client as never, { action: "list_contributions", args: {} });
  assert.deepEqual(f.calls.map((c) => c.name), ["recipes:contributions", "recipes:contributions"]);
});
