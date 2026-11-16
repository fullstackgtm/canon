import assert from "node:assert/strict";
import test from "node:test";
import { getFunctionName } from "convex/server";
import { schemaActions } from "../src/app/mcp/_canonSchemaTools.ts";
import { canonTools } from "../src/app/mcp/_canonTools.ts";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const modules = loadConvex(["dataModel.ts", "customObjects.ts", "pipelines.ts"]);

test("schema write args text has exactly the registered validator's top-level names", () => {
  for (const step of Object.values(schemaActions).filter((s) => s.kind === "mutation")) {
    const [file, name] = getFunctionName(step.ref).split(":");
    // loadConvex registers definitions unchanged: .args is the input to exportArgs(), before serialization.
    const registered = modules[`${file}.ts`][name] as unknown as { args: Record<string, unknown> };
    let depth = 0;
    const top = [...step.args].map((c) => {
      if (c === "{" || c === "(") { depth++; return " "; }
      if (c === "}" || c === ")") { depth--; return " "; }
      return depth === 1 ? c : " ";
    }).join("");
    const names = [...top.matchAll(/(?:^|,)\s*(\w+)\??:/g)].map((m) => m[1]);
    assert.deepEqual(names.sort(), Object.keys(registered.args).sort(), getFunctionName(step.ref));
  }
});

test("all eight schema mutations log once, service JWT attribution, history access and isolation", async () => {
  const previous = process.env.CANON_SERVICE_JWT_ISSUER;
  process.env.CANON_SERVICE_JWT_ISSUER = "https://schema.test/service";
  try {
    const db = memoryDb({ users: [
      { _id: "admin", clerkUserId: "admin", orgId: "org", role: "admin", name: "Ada", isActive: true },
      { _id: "rep", clerkUserId: "rep", orgId: "org", role: "rep", name: "Rex", isActive: true },
    ] });
    let subject = "admin";
    let service = false;
    const ctx = { db, auth: { getUserIdentity: async () => ({ subject, issuer: service ? process.env.CANON_SERVICE_JWT_ISSUER : "https://person.test", ...(service ? { azp: "paired-cli" } : {}) }) }, scheduler: { runAfter: async () => null } };
    const call = async (file: string, name: string, args: unknown) => {
      const before = db.rows("dataModelChanges").length;
      const result = await modules[file][name].handler(ctx, args);
      assert.equal(db.rows("dataModelChanges").length, before + 1, `${file}:${name}`);
      return result;
    };
    const { apiName } = await call("customObjects.ts", "create", { label: "Commitment", pluralLabel: "Commitments", icon: "box", titleLabel: "Name" });
    await call("customObjects.ts", "edit", { apiName, label: "Promise" });
    await call("customObjects.ts", "setArchived", { apiName, archived: true });
    await call("customObjects.ts", "setArchived", { apiName, archived: false });
    await call("dataModel.ts", "relabel", { object: "task", label: "Action", pluralLabel: "Actions" });
    const { fieldId } = await call("dataModel.ts", "createField", { object: apiName, label: "Status", type: "picklist", options: [{ label: "Open" }] });
    await call("dataModel.ts", "updateFieldDef", { object: apiName, fieldId, label: "State" });
    await call("dataModel.ts", "setArchived", { object: apiName, fieldId, archived: true });
    await call("dataModel.ts", "setArchived", { object: apiName, fieldId, archived: false });
    service = true;
    await call("pipelines.ts", "save", { pipelineId: null, name: "Enterprise", stages: [{ value: null, label: "Discovery", probability: 20, forecastCategory: "pipeline" }] });
    const rows = await modules["dataModel.ts"].history.handler(ctx, {});
    assert.equal(rows[0].agent, "paired-cli");
    assert.equal(rows[0].memberName, "Ada");
    assert.ok(rows.slice(1).every((r: { agent?: string }) => r.agent === undefined));
    await db.insert("dataModelChanges", { orgId: "other", userId: "admin", at: Date.now() + 1, object: "deal", kind: "pipeline_saved", summary: "Private" });
    assert.equal((await modules["dataModel.ts"].history.handler(ctx, {})).length, 10);
    subject = "rep";
    await assert.rejects(modules["dataModel.ts"].history.handler(ctx, {}));
    for (const [file, name, args] of [["customObjects.ts", "edit", { apiName, label: "Wrong" }], ["dataModel.ts", "createField", { object: apiName, label: "Wrong", type: "text" }], ["pipelines.ts", "save", { pipelineId: null, name: "Wrong", stages: [] }]] as const) {
      await assert.rejects(modules[file][name].handler(ctx, args));
    }
    assert.equal(db.rows("dataModelChanges").length, 11);
  } finally {
    if (previous === undefined) delete process.env.CANON_SERVICE_JWT_ISSUER;
    else process.env.CANON_SERVICE_JWT_ISSUER = previous;
  }
});

test("members tool returns only compact public member fields", async () => {
  const result = await canonTools.find((t) => t.name === "canon_members")!.run({ query: async () => [{ _id: "u", name: "Ada", email: "a@test", role: "admin", isActive: true, clerkUserId: "secret", title: "Owner" }] } as never, {});
  assert.deepEqual(result, [{ id: "u", name: "Ada", email: "a@test", role: "admin", isActive: true, title: "Owner" }]);
});
