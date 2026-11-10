/**
 * Record API plumbing: bearer auth and the JSON error envelope.
 *
 * Auth is the MCP route's, not a new scheme. A paired CLI token (`fsgtm_...`)
 * resolves to its user and runs through a short-lived service JWT; any other
 * bearer is handed to Convex as a Clerk JWT. Either way every Convex function
 * sees the caller's own user and org, so tenant isolation and role checks are
 * the ones the dashboard has. Self-registered agent tokens (`fsgtm_agent_`)
 * never reach org data.
 */
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../../../convex/_generated/api.js";
import { explainConvexError } from "../../../lib/convexErrorText.ts";
import { serviceJwtConfig, signServiceJwt } from "../../../lib/canonServiceJwt.ts";
import { AGENT_TOKEN_PREFIX } from "../agents/_lib.ts";

export type V1ErrorCode =
  | "unauthorized"
  | "forbidden"
  | "unknown_object"
  | "not_found"
  | "invalid_request"
  | "validation_failed"
  | "version_conflict"
  | "unsupported"
  | "not_configured"
  | "internal";

const STATUS: Record<V1ErrorCode, number> = {
  unauthorized: 401, forbidden: 403, unknown_object: 404, not_found: 404, invalid_request: 400,
  validation_failed: 422, version_conflict: 409, unsupported: 405, not_configured: 503, internal: 500,
};

export class V1Error extends Error {
  readonly code: V1ErrorCode;
  readonly details?: Record<string, unknown>;
  constructor(code: V1ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function errorResponse(error: V1Error): Response {
  return Response.json({ error: { code: error.code, message: error.message, ...error.details } }, { status: STATUS[error.code] });
}

/** The Convex functions the record API calls: a `ConvexHttpClient`, or a fake in tests. */
export type V1Client = Pick<ConvexHttpClient, "query" | "mutation" | "action">;

const bearer = (request: Request) => request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;

/** A client acting as the token's user, or a V1Error. A request without a token is the demo user on a local stack only. */
export async function authenticate(request: Request, env: Record<string, string | undefined> = process.env): Promise<V1Client> {
  const url = env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new V1Error("not_configured", "NEXT_PUBLIC_CONVEX_URL is not configured");
  const client = new ConvexHttpClient(url);
  const token = bearer(request);
  if (!token) {
    if (env.NODE_ENV === "production") throw new V1Error("unauthorized", "Pass a Bearer token in the Authorization header");
    return client;
  }
  if (token.startsWith(AGENT_TOKEN_PREFIX)) throw new V1Error("forbidden", "Self-registered agent tokens are read-only and never reach workspace records; pair a CLI token instead");
  if (token.startsWith("fsgtm_")) {
    const who = await client.action(api.agentIdentity.resolveCliToken, { cliToken: token });
    if (!who) throw new V1Error("unauthorized", "Unknown or revoked token");
    const config = serviceJwtConfig(env);
    if (!config) throw new V1Error("not_configured", "CLI tokens are not enabled on this deployment");
    client.setAuth(signServiceJwt(config, { clerkUserId: who.clerkUserId, clerkOrgId: who.clerkOrgId, clientId: "canon-record-api" }));
  } else {
    client.setAuth(token);
  }
  // Convex answers an unverifiable or user-less token with null, not an error.
  const me = await client.query(api.users.me, {}).catch(() => null);
  if (!me) throw new V1Error("unauthorized", "The token does not identify a workspace user");
  return client;
}

/** Map what Convex throws to a stable code. Messages from `ConvexError`s are written for callers; internal ones are not echoed. */
export function toV1Error(error: unknown): V1Error {
  if (error instanceof V1Error) return error;
  const e = explainConvexError(error);
  const requestId = e.requestId ? { requestId: e.requestId } : undefined;
  if (e.kind === "rejected") {
    const code = /only admins|not allowed|permission|your role cannot/i.test(e.message) ? "forbidden" : /\bnot found\b/i.test(e.message) ? "not_found" : "invalid_request";
    return new V1Error(code, e.message, requestId);
  }
  if (e.kind === "invalid_argument") {
    return e.field
      ? new V1Error("validation_failed", "Some values were rejected", { errors: [{ field: e.field, message: e.message }], ...requestId })
      : new V1Error("invalid_request", e.message, requestId);
  }
  if (/Only admins and managers/i.test(e.message)) return new V1Error("forbidden", "Only admins and managers can do this");
  return new V1Error("internal", `Unexpected error${e.requestId ? ` (request ${e.requestId})` : ""}; retry once, then report the request id`, requestId);
}

/**
 * A route's answers for methods it does not take: the JSON envelope with an Allow header, not Next's empty 405,
 * and an OPTIONS that lists only the real methods (Next's own would count these fallbacks as supported).
 */
export function methodNotAllowed(allowed: string[]) {
  const allow = [...allowed, "OPTIONS"].join(", ");
  const deny = async (request: Request): Promise<Response> => {
    const response = errorResponse(new V1Error("unsupported", `${request.method} is not supported on ${new URL(request.url).pathname}; use ${allowed.join(", ")}`));
    response.headers.set("Allow", allow);
    return response;
  };
  const options = async (): Promise<Response> => new Response(null, { status: 204, headers: { Allow: allow } });
  return { deny, options };
}

export type V1Result = { status: number; body: unknown };

/** The request's JSON body; anything unparseable is a 400, not a crash. */
export async function jsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new V1Error("invalid_request", "The body is not valid JSON");
  }
}

/** Wrap a handler: authenticate, run, and turn anything thrown into the error envelope. */
export function v1Route<P>(handler: (client: V1Client, request: Request, params: P) => Promise<V1Result>) {
  return async (request: Request, context: { params: Promise<P> }): Promise<Response> => {
    try {
      const client = await authenticate(request);
      const result = await handler(client, request, await context.params);
      return Response.json(result.body, { status: result.status });
    } catch (error) {
      return errorResponse(toV1Error(error));
    }
  };
}
