import assert from "node:assert/strict";
import test from "node:test";
import { loadConvex, memoryDb } from "./convexHandlers.ts";
import { emptySpec } from "../convex/lib/icps.ts";
import { fieldsAsOf, fitAsOf } from "../convex/lib/scoreHistory.ts";

const saas = { ...emptySpec(), market: { industries: ["software development"], employeeBands: ["51-200"], countries: ["us"] } };
const plain = (x: unknown) => JSON.parse(JSON.stringify(x));
const icp = (name: string, extra: Record<string, unknown> = {}) => ({ orgId: "org", name, spec: saas, active: true, isDefault: false, source: "manual", createdAt: 1, updatedAt: 2, ...extra });

test("the Canon ICP reader keeps strategy.edit for Save as ICP, including workspace roles", async () => {
  let user: { orgId: string; role: string; capabilities?: string[] } | null = { orgId: "org", role: "admin" };
  const files = loadConvex(["icpsInterface.ts"], {
    "lib.ts": (r) => ({ ...r, getCurrentUser: async () => user }),
    "lib/recipes.ts": (r) => ({ ...r, modelSettings: async () => ({ buyerLevels: ["vp"] }) }),
  });
  const db = memoryDb({ icps: [{ _id: "icps:a", ...icp("SaaS") }] });
  const list = () => files["icpsInterface.ts"].list.handler({ db }, {});
  assert.equal((await list()).canEdit, true);
  user = { orgId: "org", role: "rep" };
  assert.equal((await list()).canEdit, false);
  user = { orgId: "org", role: "role_strategy", capabilities: ["strategy.edit"] };
  const result = await list();
  assert.equal(result.canEdit, true);
  assert.deepEqual(plain(result.buyerLevels), ["vp"]);
  assert.equal(result.icps[0].key, "icps:a");
  user = null;
  assert.equal(await list(), null);
});

test("icps.v1 and icpNodes.v1: keyed by today's ids, default first, only the interface's fields", async () => {
  const { "lib/icpsInterface.ts": lib } = loadConvex(["lib/icpsInterface.ts"]);
  const db = memoryDb({
    icps: [{ _id: "icps:b", ...icp("Banks") }, { _id: "icps:a", ...icp("SaaS", { isDefault: true, pointOfView: "Pipeline leaks", gapCheck: { key: "k" } }) }, { _id: "icps:x", ...icp("Other org", { orgId: "org2" }) }],
    icpNodes: [{ _id: "icpNodes:1", orgId: "org", icpId: "icps:a", kind: "persona", name: "RevOps", query: "level:manager dept:revenue-operations", role: "Champion", createdAt: 3, updatedAt: 4 }],
  });
  const read = lib.bridgedIcpsRead as unknown as (ctx: unknown, orgId: string, provide: string) => Promise<unknown>;
  assert.deepEqual(plain(await read({ db }, "org", "icps.v1")), [
    { key: "icps:a", version: 2, owner: null, parentKey: null, createdAt: 1, updatedAt: 2,
      data: { name: "SaaS", spec: saas, query: "industry:software-development size:51-200 country:us", active: true, isDefault: true, source: "manual", pointOfView: "Pipeline leaks" } },
    { key: "icps:b", version: 2, owner: null, parentKey: null, createdAt: 1, updatedAt: 2,
      data: { name: "Banks", spec: saas, query: "industry:software-development size:51-200 country:us", active: true, isDefault: false, source: "manual" } },
  ]);
  assert.deepEqual(plain(await read({ db }, "org", "icpNodes.v1")), [{ key: "icpNodes:1", version: 4, owner: null, parentKey: null, createdAt: 3, updatedAt: 4,
    data: { icp: "icps:a", kind: "persona", name: "RevOps", query: "level:manager dept:revenue-operations", role: "Champion" } }]);
  assert.equal(await read({ db }, "org", "icps.v2"), null);
});

test("turning off the last active ICP clears its gates, so no account stays in an ICP that is off", async () => {
  const sent: unknown[] = [];
  const files = loadConvex(["icps.ts", "icpVersions.ts", "fitReconciler.ts"], {
    "records.ts": (r) => ({ ...r, clientFor: () => ({ contractVersion: async () => "1.41.0", rescore: async (...a: unknown[]) => (sent.push(a.slice(1)), { rescored: 3 }) }) }),
    "lib.ts": (r) => ({ ...r, getCurrentUser: async () => ({ orgId: "org" }) }),
  });
  const weights = { base: 10, industries: { "software development": 30 }, countries: {}, employeeBands: [] };
  const db = memoryDb({ icps: [{ _id: "icps:a", ...icp("SaaS", { active: false, isDefault: true }) }], icpVersions: [{ _id: "icpVersions:1", orgId: "org", version: 1, acceptedAt: 1, weights, gates: [{ id: "icps:a" }] }] });
  const ctx = { db, scheduler: { runAfter: async () => null },
    runMutation: (ref: unknown, args: object): Promise<unknown> => {
      const [, file, name] = String(ref).split(".");
      return files[`${file}.ts`][name].handler(ctx, args);
    } };
  await files["icps.ts"].rescore.handler(ctx, { orgId: "org" });
  assert.deepEqual(plain(sent), [[weights, 2, []]]);
  await files["icps.ts"].rescore.handler(ctx, { orgId: "org" });
  assert.equal(sent.length, 1, "already clear: nothing to send");
  const versions = await files["icpVersions.ts"].list.handler({ db }, {});
  const cleared = versions.at(-1);
  assert.equal(cleared.gates, undefined);
  assert.deepEqual(plain(fitAsOf(fieldsAsOf({ industry: "software development", fieldUpdatedAt: { domain: 1, industry: 1 } }, [], Date.now()), cleared)), { known: true, fit: 40 });
});
