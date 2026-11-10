import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadConvex, memoryDb } from "./convexHandlers.ts";
import { emptySpec } from "../convex/lib/icps.ts";

const files = loadConvex(["audiences.ts"]);
const manifest = JSON.parse(readFileSync("modules/examples/icps/module.json", "utf8"));
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const definition = { name: "Software buyers", spec: emptySpec(), query: "", active: true, isDefault: false, source: "manual", createdAt: 1, updatedAt: 2 };

function workspace(moduleOwned = false, key = "f3c68f95-6197-4866-b770-6e89142cc853", role = "rep") {
  let signedIn = true;
  let activeOrg = "clerk_org";
  const db = memoryDb({
    organizations: [{ _id: "org", clerkOrgId: "clerk_org" }, { _id: "other", clerkOrgId: "clerk_other" }],
    users: [{ _id: "rep", clerkUserId: "clerk_rep", orgId: "org", role, isActive: true }],
    orgRoles: [{ _id: "custom_role", orgId: "org", key: "custom", capabilities: [] }],
    icps: [{ _id: "icps:legacy", orgId: "org", ...definition }],
    modulePackages: [{ _id: "pkg", orgId: "org", moduleId: "@canon/icps", slug: "icps", status: "installed", version: manifest.version,
      manifest: JSON.stringify(manifest), manifestHash: "audiences-from-icp", source: { kind: "canon", id: "icps", ref: manifest.version, sha: "a".repeat(40) } }],
    recipeEnablements: [{ _id: "enabled", orgId: "org", point: "module", recipeId: "@canon/icps", contributionKey: "nav", enabled: true }],
    moduleInterfaceOwners: moduleOwned ? [{ _id: "owner", orgId: "org", moduleId: "@canon/icps", packageId: "pkg" }] : [],
    moduleDocs: [{ _id: "module_icp", orgId: "org", moduleId: "@canon/icps", collection: "icps", key, data: definition, version: 2, createdAt: 1, updatedAt: 2 }],
  });
  const scheduled: Array<{ ref: string; args: unknown }> = [];
  const ctx = { db,
    auth: { getUserIdentity: async () => signedIn ? { subject: "clerk_rep", tokenIdentifier: "token_rep", org_id: activeOrg } : null },
    scheduler: { runAfter: async (_delay: number, ref: unknown, args: unknown) => { scheduled.push({ ref: String(ref), args }); } },
  };
  return { db, scheduled, create: (icpId: string) => files["audiences.ts"].createFromIcp.handler(ctx, { icpId }),
    signOut: () => { signedIn = false; }, switchOrg: () => { activeOrg = "clerk_other"; } };
}

test("New audience preserves core and opaque module ICP keys, creator privacy and the existing refresh/gap jobs", async () => {
  for (const [owned, key, role] of [
    [false, "icps:legacy", "rep"],
    [true, "f3c68f95-6197-4866-b770-6e89142cc853", "manager"],
    [true, "imported ICP/key:unchanged", "custom"],
  ] as const) {
    const w = workspace(owned, key, role);
    const id = await w.create(key);
    const audience = await w.db.get(id);
    assert.deepEqual(plain({ org: audience?.orgId, owner: audience?.createdBy, shared: audience?.shared, name: audience?.name, filter: audience?.filter }), {
      org: "org", owner: "rep", shared: false, name: "Software buyers: people",
      filter: [{ field: "accountIcpIds", op: "hasAny", value: [key] }],
    });
    assert.deepEqual(plain(w.scheduled), [
      { ref: "internal.audienceActions.refreshSummary", args: { orgId: "org", audienceId: id } },
      { ref: "internal.icpFills.checkGap", args: { orgId: "org", icpId: key } },
    ]);
  }
});

test("New audience refuses absent, foreign, inactive, over-limit and unavailable definitions without writing or scheduling", async () => {
  for (const change of [
    async (w: ReturnType<typeof workspace>) => { await w.db.patch("module_icp", { key: "different" }); },
    async (w: ReturnType<typeof workspace>) => { await w.db.patch("module_icp", { orgId: "other" }); },
    async (w: ReturnType<typeof workspace>) => { await w.db.patch("module_icp", { data: { ...definition, active: false } }); },
    async (w: ReturnType<typeof workspace>) => { await w.db.patch("pkg", { pending: { version: "next" } }); },
    async (w: ReturnType<typeof workspace>) => { await w.db.patch("enabled", { enabled: false }); },
    async (w: ReturnType<typeof workspace>) => { await w.db.patch("pkg", { source: { kind: "github-public", owner: "third", repo: "icps" } }); },
    async (w: ReturnType<typeof workspace>) => { await w.db.patch("owner", { packageId: "missing" }); },
    async (w: ReturnType<typeof workspace>) => {
      for (let i = 0; i < 25; i++) await w.db.insert("moduleDocs", { orgId: "org", moduleId: "@canon/icps", collection: "icps", key: `extra:${i}`, data: definition, version: 1, createdAt: 1, updatedAt: 1 });
    },
  ]) {
    const w = workspace(true);
    await change(w);
    await assert.rejects(w.create("f3c68f95-6197-4866-b770-6e89142cc853"));
    assert.equal(w.db.rows("audiences").length, 0);
    assert.deepEqual(w.scheduled, []);
  }
  const owned = workspace(true);
  await assert.rejects(owned.create("icps:legacy"), "an owning provider never falls back to a retained core definition");
  assert.equal(owned.db.rows("audiences").length, 0);
  const core = workspace();
  await core.db.patch("icps:legacy", { orgId: "other" });
  await assert.rejects(core.create("icps:legacy"));
  assert.equal(core.db.rows("audiences").length, 0);
});

test("New audience retains authentication, active-workspace membership, preview refusal and the creator quota", async () => {
  const unauthenticated = workspace();
  unauthenticated.signOut();
  await assert.rejects(unauthenticated.create("icps:legacy"));
  assert.equal(unauthenticated.db.rows("audiences").length, 0);
  const foreign = workspace();
  foreign.switchOrg();
  await assert.rejects(foreign.create("icps:legacy"));
  assert.equal(foreign.db.rows("audiences").length, 0);
  const preview = workspace(false, "icps:legacy", "admin");
  await preview.db.insert("accessPreviews", { userId: "rep", orgId: "org", expiresAt: Date.now() + 60_000 });
  await assert.rejects(preview.create("icps:legacy"));
  assert.equal(preview.db.rows("audiences").length, 0);
  const full = workspace();
  for (let i = 0; i < 100; i++) await full.db.insert("audiences", { orgId: "org", createdBy: "rep", name: `Saved ${i}` });
  await assert.rejects(full.create("icps:legacy"));
  assert.equal(full.db.rows("audiences").length, 100);
  for (const w of [unauthenticated, foreign, preview, full]) assert.deepEqual(w.scheduled, []);
});
