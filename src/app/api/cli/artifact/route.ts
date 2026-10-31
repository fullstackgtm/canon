import { ConvexError } from "convex/values";
import { api } from "../../../../../convex/_generated/api.js";
import { publicGtmApi, readJsonBody } from "../../gtm/_lib.ts";
import { agentTokenRejection } from "../../agents/_lib.ts";
import { bearerToken, invalidCliTokenResponse, plainConvexClient } from "../_lib.ts";

const clean = (value: unknown, max: number) => typeof value === "string" && value.trim().length <= max ? value.trim() : "";
const validKind = (value: unknown): value is "icp" | "signal_run" | "lead_run" => value === "icp" || value === "signal_run" || value === "lead_run";

function auth(request: Request): { cliToken: string } | { response: Response } {
  const cliToken = bearerToken(request);
  const rejection = agentTokenRejection(cliToken, request);
  if (rejection) return { response: rejection };
  if (!cliToken?.startsWith("fsgtm_")) return { response: Response.json({ error: "Missing CLI token" }, { status: 401 }) };
  return { cliToken };
}

export const GET = publicGtmApi(async (request) => {
  const authorized = auth(request);
  if ("response" in authorized) return authorized.response;
  const url = new URL(request.url);
  const kind = url.searchParams.get("kind");
  const key = clean(url.searchParams.get("key"), 256);
  if (!validKind(kind) || !key) return Response.json({ error: "kind and key are required" }, { status: 400 });
  try {
    const result = await plainConvexClient().action(api.cliArtifactActions.get, { cliToken: authorized.cliToken, kind, key });
    return result ? Response.json(result) : Response.json({ error: "Artifact not found" }, { status: 404 });
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
  if (!validKind(body.kind) || !clean(body.key, 256) || !clean(body.label, 200)) return Response.json({ error: "Invalid artifact metadata" }, { status: 400 });
  const encoded = JSON.stringify(body.document);
  if (!body.document || encoded.length > 500_000) return Response.json({ error: "Invalid artifact document" }, { status: 400 });
  if (body.expectedRevision !== undefined && (typeof body.expectedRevision !== "number" || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0)) return Response.json({ error: "Invalid expectedRevision" }, { status: 400 });
  try {
    const result = await plainConvexClient().action(api.cliArtifactActions.upsert, {
      cliToken: authorized.cliToken, kind: body.kind, key: clean(body.key, 256), label: clean(body.label, 200),
      domain: clean(body.domain, 253) || undefined, document: body.document,
      sourceVersion: clean(body.sourceVersion, 40) || undefined, expectedRevision: body.expectedRevision,
      changeSummary: clean(body.changeSummary, 500) || undefined,
    });
    return Response.json(result);
  } catch (error) {
    const unauthorized = invalidCliTokenResponse(error);
    if (unauthorized) return unauthorized;
    if (error instanceof ConvexError) {
      const data = error.data as { code?: string; currentRevision?: number; documentSha256?: string };
      if (data?.code === "ARTIFACT_CONFLICT") return Response.json({ error: "Artifact revision conflict", currentRevision: data.currentRevision, documentSha256: data.documentSha256 }, { status: 409 });
    }
    throw error;
  }
});
