import { createHash, timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { agentTokenRejection } from "../agents/_lib.ts";
import { gtmErrorEnvelope, gtmErrorStatus, type GtmErrorCode } from "../../../lib/gtm-error-envelope.ts";

export type GtmApiContext = {
  request: Request;
  client: ConvexHttpClient;
  url: URL;
};

export type GtmJsonBody = Record<string, unknown>;

function smokeBypassToken() {
  // The smoke bypass skips auth and must never be honored in production.
  if (process.env.NODE_ENV === "production") return undefined;
  return (
    process.env.FSGTM_SMOKE_BYPASS_TOKEN ??
    process.env.FSGTM_UI_SMOKE_BYPASS_TOKEN
  );
}

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // Compare against a fixed-length digest so the length itself isn't an oracle.
  const ha = createHash("sha256").update(bufA).digest();
  const hb = createHash("sha256").update(bufB).digest();
  return nodeTimingSafeEqual(ha, hb);
}

function hasSmokeBypass(request: Request) {
  const token = smokeBypassToken();
  if (!token) return false;
  const provided =
    request.headers.get("x-fsgtm-smoke-bypass") ??
    request.headers.get("x-fsgtm-ui-smoke");
  return Boolean(provided) && timingSafeEqual(provided!, token);
}

export function convexClient(request: Request) {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) {
    throw new Error("NEXT_PUBLIC_CONVEX_URL is not configured");
  }

  const client = new ConvexHttpClient(url);
  const authorization = request.headers.get("authorization");
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];

  // Default-deny for the self-registered tier: agent tokens are public-read
  // only and never reach org-scoped routes, in any environment (this check
  // deliberately precedes the dev/smoke allowances below).
  const rejection = agentTokenRejection(token, request);
  if (rejection) return { error: rejection };

  if (token) {
    client.setAuth(token);
  } else if (process.env.NODE_ENV === "production" && !hasSmokeBypass(request)) {
    return { error: apiErrorResponse("UNAUTHORIZED", "Unauthorized", ["Pass a Bearer token via the Authorization header or configure FSGTM_SMOKE_BYPASS_TOKEN for smoke tests."]) };
  }

  return { client };
}

export function apiErrorResponse(code: GtmErrorCode, message: string, hints: string[] = []) {
  return Response.json(gtmErrorEnvelope(code, message, hints), {
    status: gtmErrorStatus(code),
  });
}

export function apiError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected API error";
  return apiErrorResponse("UPSTREAM", message, ["Run `npm run gtm -- doctor --json` to verify local configuration and upstream reachability."]);
}

export function unsupportedAction() {
  return apiErrorResponse("UNSUPPORTED_ACTION", "Unsupported action", ["Check the route documentation or run `npm run gtm -- surface --json` to inspect supported surfaces."]);
}

export async function readJsonBody(request: Request): Promise<GtmJsonBody> {
  const body = await request.json().catch(() => ({}));
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as GtmJsonBody)
    : {};
}

export async function requireAction(body: GtmJsonBody, action: string) {
  return body.action && body.action !== action ? unsupportedAction() : null;
}

export function gtmApi(
  handler: (context: GtmApiContext) => Promise<Response> | Response,
) {
  return async function route(request: Request) {
    try {
      const { client, error } = convexClient(request);
      if (error) return error;

      return await handler({
        request,
        client,
        url: new URL(request.url),
      });
    } catch (error) {
      return apiError(error);
    }
  };
}

export function publicGtmApi(
  handler: (request: Request) => Promise<Response> | Response,
) {
  return async function route(request: Request) {
    try {
      return await handler(request);
    } catch (error) {
      return apiError(error);
    }
  };
}
