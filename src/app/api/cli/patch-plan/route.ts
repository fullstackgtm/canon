import { createHash } from "node:crypto";
import { ConvexError } from "convex/values";
import { api } from "../../../../../convex/_generated/api.js";
import { publicGtmApi, readJsonBody } from "../../gtm/_lib.ts";
import { agentTokenRejection } from "../../agents/_lib.ts";
import { bearerToken, invalidCliTokenResponse, plainConvexClient } from "../_lib.ts";

const MAX_BODY_BYTES = 750_000;
const MAX_OPERATIONS = 2_000;

function auth(request: Request): { token: string } | { response: Response } {
  const token = bearerToken(request);
  const rejection = agentTokenRejection(token, request);
  if (rejection) return { response: rejection };
  if (!token?.startsWith("fsgtm_")) return { response: Response.json({ error: "Missing CLI token" }, { status: 401 }) };
  return { token };
}

function safeString(value: unknown, max = 10_000): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validRisk(value: unknown): value is "low" | "medium" | "high" {
  return value === "low" || value === "medium" || value === "high";
}

function boundedValue(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= 50_000;
  if (Array.isArray(value)) return value.length <= 2_000 && value.every((item) => boundedValue(item, depth + 1));
  if (!value || typeof value !== "object") return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length <= 500 && entries.every(([key, item]) => safeString(key, 200) && boundedValue(item, depth + 1));
}

function validOperation(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const op = value as Record<string, unknown>;
  return safeString(op.packageOpId, 200) && safeString(op.objectType, 100) &&
    (op.objectId === undefined || safeString(op.objectId, 500)) && safeString(op.fieldOrAction, 200) &&
    boundedValue(op.beforeValue) && boundedValue(op.afterValue) &&
    (op.reason === undefined || safeString(op.reason, 10_000)) &&
    (op.sourceRuleOrPolicy === undefined || safeString(op.sourceRuleOrPolicy, 500)) &&
    (op.riskLevel === "low" || op.riskLevel === "medium" || op.riskLevel === "high") &&
    typeof op.approvalRequired === "boolean" && (op.rollback === undefined || safeString(op.rollback, 10_000));
}

export const GET = publicGtmApi(async (request) => {
  const authorized = auth(request);
  if ("response" in authorized) return authorized.response;
  const externalPlanId = new URL(request.url).searchParams.get("externalPlanId");
  if (!safeString(externalPlanId, 200)) return Response.json({ error: "externalPlanId is required" }, { status: 400 });
  try {
    const result = await plainConvexClient().action(api.cliPatchPlanActions.get, { cliToken: authorized.token, externalPlanId });
    if (!result) return Response.json({ error: "Plan mirror not found" }, { status: 404 });
    return Response.json(result);
  } catch (error) {
    const unauthorized = invalidCliTokenResponse(error);
    if (unauthorized) return unauthorized;
    throw error;
  }
});

export const POST = publicGtmApi(async (request) => {
  const authorized = auth(request);
  if ("response" in authorized) return authorized.response;
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) return Response.json({ error: "Plan payload is too large" }, { status: 413 });
  const body = await readJsonBody(request);
  if (JSON.stringify(body).length > MAX_BODY_BYTES) return Response.json({ error: "Plan payload is too large" }, { status: 413 });
  const action = body.action === "lifecycle" ? "lifecycle" : body.action === "claim" ? "claim" : body.action === "release_claim" ? "release_claim" : "ingest";
  if (!safeString(body.externalPlanId, 200) || !safeString(body.documentSha256, 64) || !/^[a-f0-9]{64}$/.test(body.documentSha256)) {
    return Response.json({ error: "Invalid external plan identity" }, { status: 400 });
  }
  try {
    if (action === "release_claim") {
      if (!safeString(body.claimId, 500) || !safeString(body.reason, 2_000) || body.reason.trim().length < 10) {
        return Response.json({ error: "A valid claim and preflight release reason are required" }, { status: 400 });
      }
      return Response.json(await plainConvexClient().action(api.cliPatchPlanActions.releaseApplyClaim, {
        cliToken: authorized.token,
        externalPlanId: body.externalPlanId,
        documentSha256: body.documentSha256,
        claimId: body.claimId,
        reason: body.reason,
      }));
    }
    if (action === "claim") {
      return Response.json(await plainConvexClient().action(api.cliPatchPlanActions.claimApply, {
        cliToken: authorized.token,
        externalPlanId: body.externalPlanId,
        documentSha256: body.documentSha256,
      }));
    }
    if (action === "lifecycle") {
      if (body.status !== "approved" && body.status !== "rejected" && body.status !== "applied") {
        return Response.json({ error: "Invalid lifecycle status" }, { status: 400 });
      }
      const ids = Array.isArray(body.approvedOperationIds) ? body.approvedOperationIds : [];
      if (ids.length > MAX_OPERATIONS || !ids.every((id) => safeString(id, 200))) return Response.json({ error: "Invalid approved operations" }, { status: 400 });
      if (body.claimId !== undefined && !safeString(body.claimId, 500)) return Response.json({ error: "Invalid apply claim" }, { status: 400 });
      const receipts = Array.isArray(body.operationReceipts) ? body.operationReceipts : [];
      if (receipts.length > MAX_OPERATIONS || !receipts.every((receipt) => {
        if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return false;
        const row = receipt as Record<string, unknown>;
        return safeString(row.packageOpId, 200) && ["applied", "skipped", "failed", "conflict"].includes(String(row.status)) &&
          (row.error === undefined || safeString(row.error, 10_000)) && (row.providerData === undefined || boundedValue(row.providerData)) &&
          (row.updatedAt === undefined || finiteNumber(row.updatedAt));
      })) return Response.json({ error: "Invalid operation receipts" }, { status: 400 });
      if (body.runRecord !== undefined && !boundedValue(body.runRecord)) return Response.json({ error: "Invalid run record" }, { status: 400 });
      return Response.json(await plainConvexClient().action(api.cliPatchPlanActions.reportLifecycle, {
        cliToken: authorized.token, externalPlanId: body.externalPlanId, documentSha256: body.documentSha256,
        status: body.status, approvedOperationIds: ids, claimId: body.claimId,
        runRecord: body.runRecord, operationReceipts: receipts,
      }));
    }
    if (!nonnegativeInteger(body.externalRevision) || !safeString(body.title, 500) ||
      !safeString(body.summary, 10_000) || !validRisk(body.riskLevel) ||
      !boundedValue(body.document) || !Array.isArray(body.operations) || body.operations.length > MAX_OPERATIONS ||
      !body.operations.every(validOperation) || !finiteNumber(body.createdAt)) {
      return Response.json({ error: "Invalid plan payload" }, { status: 400 });
    }
    const computedDigest = createHash("sha256").update(JSON.stringify(body.document)).digest("hex");
    if (computedDigest !== body.documentSha256) {
      return Response.json({ error: "Plan document does not match its immutable content hash" }, { status: 400 });
    }
    const documentOperations = (body.document as { operations?: unknown }).operations;
    const documentIds = Array.isArray(documentOperations)
      ? documentOperations.map((operation) => operation && typeof operation === "object" ? (operation as { id?: unknown }).id : undefined)
      : [];
    const rowIds = body.operations.map((operation: { packageOpId: string }) => operation.packageOpId);
    if (documentIds.some((id) => typeof id !== "string") || new Set(documentIds).size !== documentIds.length ||
      new Set(rowIds).size !== rowIds.length || documentIds.length !== rowIds.length ||
      documentIds.some((id) => !rowIds.includes(id as string))) {
      return Response.json({ error: "Plan document and operation rows must contain the same unique operation ids" }, { status: 400 });
    }
    const result = await plainConvexClient().action(api.cliPatchPlanActions.ingest, {
      cliToken: authorized.token, externalPlanId: body.externalPlanId, documentSha256: body.documentSha256,
      externalRevision: body.externalRevision, title: body.title, summary: body.summary, riskLevel: body.riskLevel,
      document: body.document, operations: body.operations, createdAt: body.createdAt,
    });
    return Response.json(result);
  } catch (error) {
    const unauthorized = invalidCliTokenResponse(error);
    if (unauthorized) return unauthorized;
    if (error instanceof ConvexError) {
      const code = (error.data as { code?: string })?.code;
      if (code === "CLI_PLAN_CONFLICT" || code === "CLI_PLAN_DECISION_CONFLICT") {
        return Response.json({ error: code === "CLI_PLAN_CONFLICT" ? "Hosted plan content conflicts with this immutable plan id" : "Hosted and local plan decisions conflict" }, { status: 409 });
      }
    }
    throw error;
  }
});
