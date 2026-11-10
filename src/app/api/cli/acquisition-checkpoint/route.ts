import { api } from "../../../../../convex/_generated/api.js";
import { ConvexError } from "convex/values";
import { publicGtmApi, readJsonBody } from "../../gtm/_lib.ts";
import { agentTokenRejection } from "../../agents/_lib.ts";
import { bearerToken, invalidCliTokenResponse, plainConvexClient } from "../_lib.ts";

function auth(request: Request): { cliToken: string } | { response: Response } {
  const cliToken = bearerToken(request);
  const rejection = agentTokenRejection(cliToken, request);
  if (rejection) return { response: rejection };
  if (!cliToken?.startsWith("fsgtm_")) {
    return { response: Response.json({ error: "Missing CLI token" }, { status: 401 }) };
  }
  return { cliToken };
}

function validKey(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function validCheckpoint(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const allowed = new Set(["queryFingerprint", "cursor", "offset", "exhausted"]);
  return (
    Object.keys(item).every((key) => allowed.has(key)) &&
    validKey(item.queryFingerprint, 128) &&
    typeof item.exhausted === "boolean" &&
    (item.cursor === undefined ||
      item.cursor === null ||
      validKey(item.cursor, 4096)) &&
    (item.offset === undefined ||
      item.offset === null ||
      (typeof item.offset === "number" &&
        Number.isSafeInteger(item.offset) &&
        item.offset >= 0))
  );
}

export const GET = publicGtmApi(async (request) => {
  const authorized = auth(request);
  if ("response" in authorized) return authorized.response;
  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  if (!validKey(key, 256)) {
    return Response.json({ error: "key is required" }, { status: 400 });
  }
  try {
    const checkpoint = await plainConvexClient().action(api.acquisitionCheckpointActions.get, {
      cliToken: authorized.cliToken,
      key,
    });
    if (!checkpoint) return Response.json({ error: "Checkpoint not found" }, { status: 404 });
    return Response.json(checkpoint);
  } catch (error) {
    const unauthorized = invalidCliTokenResponse(error);
    if (unauthorized) return unauthorized;
    throw error;
  }
});

export const POST = publicGtmApi(async (request) => {
  const authorized = auth(request);
  if ("response" in authorized) return authorized.response;
  const body = await readJsonBody(request);
  if (!validKey(body.key, 256)) {
    return Response.json({ error: "key is required" }, { status: 400 });
  }
  const optionalNonnegativeInteger = (value: unknown): value is number | undefined =>
    value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
  if (
    !validCheckpoint(body.checkpoint) ||
    JSON.stringify(body.checkpoint).length > 16_384 ||
    !optionalNonnegativeInteger(body.expectedVersion)
  ) {
    return Response.json({ error: "Invalid checkpoint payload" }, { status: 400 });
  }
  try {
    const result = await plainConvexClient().action(api.acquisitionCheckpointActions.upsert, {
      cliToken: authorized.cliToken,
      key: body.key,
      checkpoint: body.checkpoint,
      expectedVersion: body.expectedVersion,
    });
    return Response.json(result);
  } catch (error) {
    const unauthorized = invalidCliTokenResponse(error);
    if (unauthorized) return unauthorized;
    if (error instanceof ConvexError) {
      const data = error.data as { code?: string; current?: unknown };
      if (data?.code === "CHECKPOINT_CONFLICT") {
        return Response.json({ current: data.current ?? null }, { status: 409 });
      }
    }
    throw error;
  }
});
