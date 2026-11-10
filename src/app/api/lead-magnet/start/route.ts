import { ConvexError } from "convex/values";
import { api } from "../../../../../convex/_generated/api";
import { clientIp, plainConvexClient, rateLimit, sha256, tooManyRequests } from "../../cli/_lib.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RESEARCH_COOKIE = "fsgtm_rs";

/**
 * Homepage domain submit -> anonymous research session. Computes the IP hash
 * server-side (salted, never stored raw) for the Convex per-IP limit, passes
 * the honeypot through, and sets the `fsgtm_rs` cookie so the session can be
 * claimed after sign-up even if the redirect URL is lost.
 */
export async function POST(request: Request) {
  if (!rateLimit(request, 10, 60_000)) return tooManyRequests();
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Request body must be JSON." }, { status: 400 });
  }
  const domain = typeof body.domain === "string" ? body.domain : "";
  if (!domain.trim()) return Response.json({ error: "Enter a company domain." }, { status: 400 });
  const website = typeof body.website === "string" ? body.website : undefined;
  const salt = process.env.RESEARCH_IP_SALT ?? process.env.CLERK_SECRET_KEY ?? "fsgtm-research";
  const ipHash = sha256(`${salt}:${clientIp(request)}`).slice(0, 32);
  try {
    const { token, cached } = await plainConvexClient().mutation(api.researchSessions.start, { domain, ipHash, website, example: body.example === true });
    const response = Response.json({ token, cached, url: `/start/${token}${body.example === true ? "?replay=1" : ""}` });
    response.headers.append(
      "Set-Cookie",
      `${RESEARCH_COOKIE}=${token}; Path=/; Max-Age=${7 * 24 * 3600}; SameSite=Lax${process.env.NODE_ENV === "production" ? "; Secure" : ""}`,
    );
    return response;
  } catch (error) {
    const message = error instanceof ConvexError ? String(error.data) : "Could not start research. Try again.";
    const status = /too many|capacity|already running/i.test(message) ? 429 : 400;
    return Response.json({ error: message }, { status });
  }
}
