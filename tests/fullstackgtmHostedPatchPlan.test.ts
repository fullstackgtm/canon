import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { storeCredential } from "../engine/src/credentials.ts";
import { claimHostedPlanApply, hostedPlanDigest, readHostedPatchPlan, releaseHostedPlanApply, reportHostedPlanLifecycle, uploadHostedPatchPlan } from "../engine/src/hostedPatchPlan.ts";
import type { StoredPlan } from "../engine/src/planStore.ts";

const stored: StoredPlan = {
  plan: {
    id: "patch_plan_acq_test", title: "Acquire leads", createdAt: "2026-07-10T00:00:00.000Z",
    status: "needs_approval", dryRun: true, summary: "one lead", findings: [{ id: "private", title: "omit", summary: "PII", recommendation: "omit", severity: "info", objectType: "contact", objectId: "c1", ruleId: "r", freshness: { state: "unknown", checkedAt: "2026-07-10" } }],
    evidence: [{ id: "secret-evidence", sourceSystem: "web", sourceObjectType: "contact", sourceObjectId: "x", observedAt: "2026-07-10", text: "omit me", freshness: { state: "unknown", checkedAt: "2026-07-10" } }],
    operations: [{ id: "op_1", objectType: "contact", objectId: "create:x", operation: "create_record", beforeValue: null, afterValue: { properties: { firstname: "Ada" }, matchKey: "email", matchValue: "ada@example.test", source: "linkedin" }, reason: "new", riskLevel: "medium", approvalRequired: true }],
  },
  status: "needs_approval", approvedOperationIds: [], valueOverrides: {}, revision: 1, runs: [],
  createdAt: "2026-07-10T00:00:00.000Z", updatedAt: "2026-07-10T00:00:00.000Z",
  approvalDigests: { op_1: "must-never-upload" },
  applyAttempts: [{ id: "attempt", claimedAt: "now", provider: "hubspot", source: "cli", status: "uncertain", note: "must-never-upload" }],
};

function isolated(run: (requests: Request[]) => Promise<void>) {
  return async () => {
    const previous = process.env.FSGTM_HOME;
    const home = mkdtempSync(join(tmpdir(), "fsgtm-plan-sync-"));
    process.env.FSGTM_HOME = home;
    const requests: Request[] = [];
    try { await run(requests); } finally {
      if (previous === undefined) delete process.env.FSGTM_HOME; else process.env.FSGTM_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  };
}

test("hosted plan sync is inert unless paired", isolated(async () => {
  assert.deepEqual(await uploadHostedPatchPlan(stored), { status: "unpaired" });
  assert.deepEqual(await readHostedPatchPlan(stored.plan.id), { status: "unpaired" });
}));

test("plan upload is bounded to review data, omits local security state, and returns an exact deep link", isolated(async (requests) => {
  storeCredential("broker", { kind: "broker", accessToken: "pair-secret", baseUrl: "https://app.example.test", createdAt: "now", updatedAt: "now" });
  const result = await uploadHostedPatchPlan(stored, { fetchImpl: async (input, init) => {
    requests.push(new Request(input, init));
    return Response.json({ patchPlanId: "hosted_123", status: "pending_approval", created: true });
  } });
  assert.equal(result.status, "saved");
  if (result.status === "saved") assert.equal(result.state.url, "https://app.example.test/dashboard/patch-plans?plan=hosted_123");
  const body = await requests[0]!.json() as Record<string, any>;
  assert.equal(requests[0]!.headers.get("authorization"), "Bearer pair-secret");
  assert.equal(body.documentSha256, hostedPlanDigest(stored.plan));
  assert.equal(body.document.findings, undefined);
  assert.equal(body.document.evidence, undefined);
  assert.equal(body.approvalDigests, undefined);
  assert.equal(body.applyAttempts, undefined);
  assert.equal(body.operations[0].afterValue.properties.firstname, "Ada");
}));

test("hosted decision reads and lifecycle reports retain immutable identity", isolated(async (requests) => {
  storeCredential("broker", { kind: "broker", accessToken: "pair-secret", baseUrl: "https://app.example.test", createdAt: "now", updatedAt: "now" });
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init); requests.push(request);
    if (request.method === "GET") return Response.json({ patchPlanId: "hosted_123", externalPlanId: stored.plan.id, documentSha256: hostedPlanDigest(stored.plan), status: "approved", approvedOperationIds: ["op_1"], valueOverrides: {}, updatedAt: 1 });
    return Response.json({ patchPlanId: "hosted_123", status: "approved" });
  };
  const read = await readHostedPatchPlan(stored.plan.id, { fetchImpl });
  assert.equal(read.status, "found");
  const approved = { ...stored, status: "approved" as const, approvedOperationIds: ["op_1"] };
  assert.equal((await reportHostedPlanLifecycle(approved, { fetchImpl })).status, "saved");
  assert.deepEqual(await requests[1]!.json(), { action: "lifecycle", externalPlanId: stored.plan.id, documentSha256: hostedPlanDigest(stored.plan), status: "approved", approvedOperationIds: ["op_1"] });
}));

test("applied lifecycle sends receipts for the exact approved subset, not locally audited exclusions", isolated(async (requests) => {
  storeCredential("broker", { kind: "broker", accessToken: "pair-secret", baseUrl: "https://app.example.test", createdAt: "now", updatedAt: "now" });
  const excluded = { ...stored.plan.operations[0]!, id: "op_excluded", objectId: "create:y" };
  const plan = { ...stored.plan, operations: [...stored.plan.operations, excluded] };
  const applied: StoredPlan = {
    ...stored, plan, status: "applied", approvedOperationIds: ["op_1"],
    runs: [{
      planId: plan.id, provider: "hubspot", startedAt: "2026-07-10T00:00:00.000Z",
      finishedAt: "2026-07-10T00:00:01.000Z", status: "applied",
      results: [
        { operationId: "op_1", status: "applied" },
        { operationId: "op_excluded", status: "skipped", detail: "Operation was not approved." },
      ],
    }],
  };
  const result = await reportHostedPlanLifecycle(applied, {
    claimId: "cli:claim-1",
    fetchImpl: async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({ patchPlanId: "hosted_123", status: "applied" });
    },
  });
  assert.equal(result.status, "saved");
  const body = await requests[0]!.json() as Record<string, any>;
  assert.deepEqual(body.approvedOperationIds, ["op_1"]);
  assert.deepEqual(body.operationReceipts.map((receipt: any) => receipt.packageOpId), ["op_1"]);
  assert.equal(body.runRecord.results.length, 2, "the complete local audit trail remains available in the run record");
}));

test("immutable content conflicts and insecure broker URLs fail closed", isolated(async () => {
  storeCredential("broker", { kind: "broker", accessToken: "pair-secret", baseUrl: "http://app.example.test", createdAt: "now", updatedAt: "now" });
  assert.deepEqual(await uploadHostedPatchPlan(stored), { status: "unpaired" });
  storeCredential("broker", { kind: "broker", accessToken: "pair-secret", baseUrl: "https://app.example.test", createdAt: "now", updatedAt: "now" });
  assert.deepEqual(await uploadHostedPatchPlan(stored, { fetchImpl: async () => Response.json({}, { status: 409 }) }), { status: "conflict", reason: "hosted mirror has different immutable content" });
}));

test("shared apply claims and preflight releases retain immutable identity", isolated(async (requests) => {
  storeCredential("broker", { kind: "broker", accessToken: "pair-secret", baseUrl: "https://app.example.test", createdAt: "now", updatedAt: "now" });
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init); requests.push(request);
    const body = await request.clone().json() as Record<string, unknown>;
    return body.action === "claim"
      ? Response.json({ status: "claimed", claimId: "cli:claim-1" })
      : Response.json({ released: true });
  };
  assert.deepEqual(await claimHostedPlanApply(stored, { fetchImpl }), { status: "claimed", claimId: "cli:claim-1" });
  assert.deepEqual(
    await releaseHostedPlanApply(stored, "cli:claim-1", "Preflight integrity check failed before provider I/O.", { fetchImpl }),
    { status: "released" },
  );
  const claimBody = await requests[0]!.json() as Record<string, unknown>;
  const releaseBody = await requests[1]!.json() as Record<string, unknown>;
  assert.equal(claimBody.documentSha256, hostedPlanDigest(stored.plan));
  assert.equal(releaseBody.documentSha256, hostedPlanDigest(stored.plan));
  assert.equal(releaseBody.claimId, "cli:claim-1");
  assert.equal(requests[1]!.headers.get("authorization"), "Bearer pair-secret");
}));
