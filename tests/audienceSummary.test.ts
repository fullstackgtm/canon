import assert from "node:assert/strict";
import * as capabilities from "../convex/lib/capabilities.ts";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { loadConvex } from "./convexHandlers.ts";

const require = createRequire(import.meta.url);
const internal = { audiences: { refreshSummaries: "page" }, audienceActions: { refreshSummary: "refresh" } };
const user = { orgId: "org", _id: "user" };
const register = (definition: unknown) => definition;
const stubs: Record<string, unknown> = {
  "./_generated/server": { query: register, mutation: register, internalQuery: register, internalMutation: register },
  "./_generated/api": { internal },
  "./lib/capabilities": capabilities,
  "./lib": { getCurrentUser: async () => user, requireUser: async () => user },
  "./permissions": { accessFor: async () => ({ userId: "user", role: "admin", teamOwners: ["user"], rules: {} }) },
  "./savedViews": { listedDef: async () => ({}) },
  "./lib/objects/listSpec": { compileListRequest: () => ({}) },
  "./lib/objects/validators": { listFilter: require("convex/values").v.any() },
  "./lib/tokenHelpers": {},
  "./lib/outbound/audience": {},
  "./lib/outbound/sequencers": {},
  "./icpFills": { scheduleAudienceIcpGaps: async () => {} },
  "./lib/icpsInterface": loadConvex(["lib/icpsInterface.ts"])["lib/icpsInterface.ts"],
};
const exports: Record<string, { handler: (ctx: any, args: any) => Promise<any> }> = {};
const { outputText } = ts.transpileModule(readFileSync(new URL("../convex/audiences.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
});
runInNewContext(outputText, { exports, require: (id: string) => Object.hasOwn(stubs, id) ? stubs[id] : require(id) });
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

test("summary publication rejects another tenant, changed filters, and older calculations", async () => {
  const summary = { total: 4, withEmail: 3, customVariables: [], computedAt: 10 };
  const audience = { _id: "audience", orgId: "org", filter: [], summary };
  const writes: unknown[] = [];
  const ctx = { db: { get: async () => audience, patch: async (...args: unknown[]) => writes.push(args) } };
  const args = { audienceId: "audience", orgId: "org", filter: [], summary: { ...summary, computedAt: 11 } };
  await exports.storeSummary.handler(ctx, { ...args, orgId: "other" });
  await exports.storeSummary.handler(ctx, { ...args, filter: [{ field: "title", op: "eq", value: "CEO" }] });
  await exports.storeSummary.handler(ctx, { ...args, summary: { ...summary, computedAt: 9 } });
  assert.equal(writes.length, 0);
  await exports.storeSummary.handler(ctx, args);
  assert.deepEqual(plain(writes), [["audience", { summary: args.summary }]]);
});

test("cadence refresh pages existing audiences, and editing a filter invalidates and schedules its summary", async () => {
  const scheduled: unknown[] = [];
  const writes: unknown[] = [];
  const ctx = {
    scheduler: { runAfter: async (...args: unknown[]) => scheduled.push(args) },
    db: {
      query: () => ({ paginate: async (opts: unknown) => {
        assert.deepEqual(plain(opts), { numItems: 50, cursor: null });
        return { page: [{ _id: "audience", orgId: "org" }], isDone: false, continueCursor: "next" };
      } }),
      get: async () => ({ _id: "audience", orgId: "org", createdBy: "user" }),
      patch: async (_id: string, patch: unknown) => writes.push(patch),
    },
  };
  await exports.refreshSummaries.handler(ctx, {});
  assert.deepEqual(plain(scheduled), [[0, "refresh", { audienceId: "audience", orgId: "org" }], [0, "page", { cursor: "next" }]]);
  scheduled.length = 0;
  await exports.update.handler(ctx, { audienceId: "audience", filter: [] });
  assert.ok(Object.hasOwn(writes[0]!, "summary"));
  assert.equal((writes[0] as { summary?: unknown }).summary, undefined);
  assert.deepEqual(plain(scheduled), [[0, "refresh", { audienceId: "audience", orgId: "org" }]]);
});

test("an audience is its creator's until shared; admins and managers see and change every one", () => {
  const { canSee, canChange } = exports as unknown as Record<string, (viewer: object, audience: object) => boolean>;
  const rep = { _id: "rep", orgId: "org", role: "rep" };
  const manager = { _id: "boss", orgId: "org", role: "manager" };
  const own = { orgId: "org", createdBy: "rep", shared: false };
  const others = { orgId: "org", createdBy: "peer", shared: false };
  const team = { orgId: "org", createdBy: "peer", shared: true };
  const legacy = { orgId: "org", createdBy: "peer" };
  assert.deepEqual([own, others, team, legacy].map((a) => canSee(rep, a)), [true, false, true, true]);
  assert.deepEqual([own, others, team, legacy].map((a) => canChange(rep, a)), [true, false, false, false]);
  assert.deepEqual([own, others, team].map((a) => canChange(manager, a)), [true, true, true]);
  assert.equal(canSee(manager, { ...others, orgId: "elsewhere" }), false);
});
