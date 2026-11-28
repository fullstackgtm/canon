import assert from "node:assert/strict";
import test from "node:test";
import { accessOf, type ObjectRule } from "../convex/lib/access.ts";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const user = { _id: "u", orgId: "ws", role: "rep" };
const customFields = [
  { fieldId: "custom.fee", apiName: "custom.fee", label: "Fee", type: "formula", formula: "annualRevenue * 0.2", returns: "number" },
  { fieldId: "custom.total", apiName: "custom.total", label: "Total", type: "formula", formula: "", returns: "number", rollup: { object: "deal", via: "companyId", fn: "sum", field: "amount" } },
];
const spec = { filter: [{ field: "annualRevenue", op: "gt", value: 1 }, { field: "custom.fee", op: "gt", value: 1 }], sort: { field: "custom.total", dir: "desc" }, columns: ["name"], layout: "table" };
function fixture(rules: ObjectRule[]) {
  const access = accessOf({ userId: "u", role: "rep", rules });
  const modules = loadConvex(["objects.ts", "savedViews.ts", "audiences.ts", "lib/modules/recordSources.ts"], {
    "lib.ts": (real) => ({ ...real, getCurrentUser: async () => user, requireUser: async () => user }),
    "permissions.ts": (real) => ({ ...real, accessFor: async () => access }),
  });
  const db = memoryDb({ objectDefs: [{ _id: "def", orgId: "ws", apiName: "account", registryVersion: 1, customFields }], savedViews: [{ _id: "v", orgId: "ws", object: "account", name: "Shared", shared: true, createdBy: "other", spec, updatedAt: 1 }] });
  return { modules, access, ctx: { db } };
}
const rules: ObjectRule[] = [{ object: "account", fields: [{ apiName: "annualRevenue", level: "hidden" }] }, { object: "deal", visibility: "own" }];

test("object metadata omits computed fields withheld by dependencies just like directly hidden fields", async () => {
  const { modules, ctx } = fixture(rules);
  const desc = await modules["objects.ts"].describe.handler(ctx, { object: "account" });
  assert.equal(desc.fields.some((f: { apiName: string }) => ["annualRevenue", "custom.fee", "custom.total"].includes(f.apiName)), false);
});

test("shared saved views omit directly and dependency-hidden clauses and report omissions", async () => {
  const { modules, ctx } = fixture(rules);
  const [view] = await modules["savedViews.ts"].list.handler(ctx, { object: "account" });
  assert.equal(view.spec.filter.length, 0);
  assert.equal(view.spec.sort, undefined);
  assert.equal(view.omittedClauses, 3);
});

test("unrestricted metadata and saved views keep computed fields and all clauses", async () => {
  const { modules, ctx } = fixture([]);
  const desc = await modules["objects.ts"].describe.handler(ctx, { object: "account" });
  assert.equal(desc.fields.filter((f: { apiName: string }) => f.apiName.startsWith("custom.")).length, 2);
  const [view] = await modules["savedViews.ts"].list.handler(ctx, { object: "account" });
  assert.equal(JSON.stringify(view.spec), JSON.stringify(spec));
  assert.equal(view.omittedClauses ?? 0, 0);
});


test("module record sources omit dependency-withheld measures", async () => {
  const { modules, access, ctx } = fixture(rules);
  const { recordSourcePlan } = modules["lib/modules/recordSources.ts"] as unknown as typeof import("../convex/lib/modules/recordSources.ts");
  const plan = await recordSourcePlan(ctx as unknown as import("../convex/_generated/server.ts").QueryCtx, "ws" as import("../convex/_generated/dataModel.ts").Id<"organizations">, access, "account");
  assert.ok("fields" in plan);
  assert.equal(plan.fields.some((f) => ["custom.fee", "custom.total"].includes(f.name)), false);
});

test("audience edits refuse dependency-withheld fields before saving", async () => {
  const { modules, ctx } = fixture(rules);
  for (const field of ["annualRevenue", "custom.fee", "custom.total"]) {
    await assert.rejects(() => modules["audiences.ts"].create.handler(ctx, { name: "People", filter: [], related: [{ path: "company", filter: [{ field, op: "gt", value: 1 }] }] }), /hidden/);
  }
  assert.equal(ctx.db.rows("audiences").length, 0);
});
