/**
 * An admin turns a custom field unique (convex/uniqueFields.ts), through the
 * real Convex functions in process: duplicates refuse it and release every
 * claim; without them the field becomes unique and the writer refuses a
 * second record the value. Which field types may be unique is the builder's.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadConvex, memoryDb } from "./convexHandlers.ts";
import { updateField } from "../convex/lib/objects/fieldBuilder.ts";
import type { OrgObjectExtension } from "../convex/lib/objects/registry.ts";

const ORG = "organizations:org";
const ADMIN = { _id: "users:ada", orgId: ORG, role: "admin", name: "Ada", email: "ada@acme.example", isActive: true, clerkUserId: "user_ada" };
const KIT: OrgObjectExtension & { apiName: string } = {
  apiName: "custom_kit", registryVersion: 1,
  object: { label: "Kit", pluralLabel: "Kits", icon: "box", titleField: "custom.name" },
  customFields: [
    { fieldId: "custom.name", apiName: "custom.name", label: "Name", type: "text", required: true },
    { fieldId: "custom.code", apiName: "custom.code", label: "Code", type: "text" },
    { fieldId: "custom.stage", apiName: "custom.stage", label: "Stage", type: "picklist", options: [{ value: "plan", label: "Plan", active: true }] },
  ] as never,
};

const M = loadConvex(["objects.ts", "records.ts", "dataModel.ts", "uniqueFields.ts", "backgroundJobs.ts", "permissions.ts", "ledgerFeed.ts"], {
  "lib.ts": (real) => ({ ...real, getCurrentUser: async () => ADMIN, requireUser: async () => ADMIN }),
});
const db = memoryDb({
  organizations: [{ _id: ORG, name: "Acme" }],
  users: [ADMIN],
  objectDefs: [{ _id: "objectDefs:kit", orgId: ORG, ...KIT, updatedAt: 1 }],
});
type Kind = "query" | "mutation" | "action";
const call = (kind: Kind) => async (path: string, args: unknown): Promise<any> => {
  const [file, name] = path.split(":");
  const fn = M[`${file}.ts`]?.[name!];
  if (!fn) throw new Error(`no in-process handler for ${path}`);
  const via = (as: Kind) => (ref: unknown, a: unknown) => {
    const parts = String(ref).split(".");
    return call(as)(`${parts.slice(1, -1).join("/")}:${parts.at(-1)}`, a);
  };
  return fn.handler({ db, scheduler: { runAfter: async () => null }, auth: { getUserIdentity: async () => null }, runQuery: via("query"), runMutation: via("mutation"), runAction: via("action") }, args);
};

const write = (values: Record<string, unknown>, streamId?: string) => call("mutation")("objects:write", { object: "custom_kit", values, ...(streamId ? { streamId } : {}) });
const codeField = () => (db.rows("objectDefs")[0]!.customFields as Array<{ fieldId: string; unique?: boolean; uniqueClaiming?: number }>).find((f) => f.fieldId === "custom.code")!;
const claims = () => db.rows("canonExternalIds").filter((r) => String(r.provider).startsWith("unique:custom_kit.custom.code"));

/** Turn uniqueness on or off, then run the job it started, as the scheduler would. */
async function setUnique(on: boolean) {
  await call("mutation")("dataModel:updateFieldDef", { object: "custom_kit", fieldId: "custom.code", unique: on });
  const job = db.rows("backgroundJobs").at(-1)!;
  await call("action")("uniqueFields:run", { orgId: ORG, object: "custom_kit", fieldId: "custom.code", userId: ADMIN._id, jobId: job._id, ...(on ? { claimingSince: codeField().uniqueClaiming } : {}) });
  return db.rows("backgroundJobs").at(-1)!;
}

test("only text, number, email, phone and link fields can be unique", () => {
  assert.throws(() => updateField("custom_kit", KIT, "custom.stage", { unique: { claimingSince: 1 } }), /only text, number, email, phone and link/);
  const on = updateField("custom_kit", KIT, "custom.code", { unique: { claimingSince: 7 } });
  assert.deepEqual(on.customFields.find((f) => f.fieldId === "custom.code"), { fieldId: "custom.code", apiName: "custom.code", label: "Code", type: "text", uniqueClaiming: 7 });
  assert.equal(updateField("custom_kit", on, "custom.code", { unique: false }).customFields.find((f) => f.fieldId === "custom.code")!.uniqueClaiming, undefined);
});

test("turning a field unique is refused while two records share a value, and holds after they stop", async () => {
  await write({ "custom.name": "First", "custom.code": "K-1" });
  const second = await write({ "custom.name": "Second", "custom.code": "k-1" });

  const refused = await setUnique(true);
  assert.equal(refused.status, "failed");
  assert.match(String(refused.error), /"k-1": (First, Second|Second, First)/i);
  assert.deepEqual([codeField().unique, codeField().uniqueClaiming, claims().length], [undefined, undefined, 0]);

  await write({ "custom.code": "K-2" }, second.streamId);
  assert.equal((await setUnique(true)).status, "completed");
  assert.deepEqual([codeField().unique, claims().length], [true, 2]);
  const taken = await write({ "custom.name": "Third", "custom.code": " k-2 " });
  assert.deepEqual([taken.status, taken.errors?.[0]?.field], ["invalid", "custom.code"]);

  assert.equal((await setUnique(false)).status, "completed");
  assert.deepEqual([codeField().unique, claims().length], [undefined, 0]);
  assert.equal((await write({ "custom.name": "Third", "custom.code": "K-2" })).status, "applied");
});
