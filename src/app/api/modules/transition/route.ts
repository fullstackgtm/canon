import { ConvexHttpClient } from "convex/browser";
import { ConvexError } from "convex/values";
import { api } from "../../../../../convex/_generated/api.js";
import { evidenceSigner, requestIp, signEvidence } from "../../../../lib/moduleEvidence.ts";

export const dynamic = "force-dynamic";

const DEV_MODE = process.env.NODE_ENV !== "production" && !process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

/**
 * A module transition that records where the person ran it (docs/modules.md, "Evidence"). The page posts the
 * transition here instead of to Convex: this server reads the request's IP address and browser, signs them for this
 * one transition, and runs it as the signed-in person with their own Convex token. Convex checks the signature, so
 * the evidence on the doc's history is this server's word, never the browser's or module code's.
 */
export async function POST(request: Request) {
  // Only Canon's own pages post here: JSON (which a form on another site can't send without asking first), from this origin.
  const origin = request.headers.get("origin");
  if (!request.headers.get("content-type")?.startsWith("application/json") || (origin !== null && origin !== new URL(request.url).origin && origin !== process.env.NEXT_PUBLIC_SITE_URL)) {
    return Response.json({ error: "Run it from Canon." }, { status: 403 });
  }
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const str = (k: string) => (typeof body?.[k] === "string" ? (body[k] as string) : null);
  const [module, machine, name, key] = [str("module"), str("machine"), str("name"), str("key")];
  const expect = typeof body?.expect === "number" ? body.expect : null;
  if (!module || !machine || !name || !key || expect === null) return Response.json({ error: "Name the module, machine, transition, doc and its version." }, { status: 400 });
  const signer = evidenceSigner();
  if (!signer) return Response.json({ error: "This server can't sign evidence: it has no service key." }, { status: 503 });

  const client = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
  let subject: string | null = null;
  if (process.env.CANON_AUTH === "local") {
    const { localSession, mintLocalToken } = await import("../../../../lib/localAuth.ts");
    const session = await localSession();
    if (!session) return Response.json({ error: "Sign in first." }, { status: 401 });
    client.setAuth(mintLocalToken(session));
    subject = session.user.clerkUserId;
  } else if (!DEV_MODE) {
    const { auth } = await import("@clerk/nextjs/server");
    const session = await auth();
    const token = await session.getToken({ template: "convex" });
    if (!token || !session.userId) return Response.json({ error: "Sign in first." }, { status: 401 });
    client.setAuth(token);
    subject = session.userId;
  }
  const evidence = signEvidence(signer, { module, machine, name, key, expect }, { ip: requestIp(request.headers), userAgent: request.headers.get("user-agent") }, subject);
  try {
    const args = body?.args && typeof body.args === "object" ? (body.args as Record<string, unknown>) : undefined;
    const result = await client.mutation(api.modules.transition, { module, machine, name, key, expect, ...(args ? { args } : {}), ...(str("reason") ? { reason: str("reason")! } : {}), evidence });
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: error instanceof ConvexError && typeof error.data === "string" ? error.data : "That didn't run. Try again." }, { status: 400 });
  }
}
