import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ConvexError } from "convex/values";
import { api } from "../../../../convex/_generated/api";
import { LOCAL_SESSION_COOKIE } from "@/lib/authMode";
import { hashLocalSecret, hashPassword, localAuthBroker, localSession, mintLocalToken, newLocalSecret, SESSION_SECONDS, verifyPassword } from "@/lib/localAuth";
import { rateLimit } from "../cli/_lib";

export const dynamic = "force-dynamic";

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(12).max(256);
const bodySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("register"), email, password, name: z.string().trim().min(1).max(100), workspaceName: z.string().trim().max(100).optional(), invite: z.string().regex(/^[\w-]{43}$/).optional() }),
  z.object({ kind: z.literal("sign-in"), email, password: z.string().min(1).max(256) }),
  z.object({ kind: z.literal("sign-out") }),
]);

export async function GET() {
  if (process.env.CANON_AUTH !== "local") return new Response(null, { status: 404 });
  const session = await localSession();
  return NextResponse.json(session ? { token: mintLocalToken(session) } : { token: null }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  if (process.env.CANON_AUTH !== "local") return new Response(null, { status: 404 });
  const origin = request.headers.get("origin");
  if (!origin || (origin !== new URL(request.url).origin && origin !== process.env.NEXT_PUBLIC_SITE_URL) ||
      !request.headers.get("content-type")?.startsWith("application/json")) return new Response(null, { status: 403 });
  if (!rateLimit(request, 15)) return Response.json({ error: "Too many attempts. Try again in a minute." }, { status: 429 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Enter a valid email, name, and a password of at least 12 characters." }, { status: 400 });
  const body = parsed.data;
  const broker = localAuthBroker();
  const secure = new URL(process.env.NEXT_PUBLIC_SITE_URL ?? request.url).protocol === "https:";
  try {
    if (body.kind === "sign-out") {
      const { cookies } = await import("next/headers");
      const token = (await cookies()).get(LOCAL_SESSION_COOKIE)?.value;
      if (token) await broker.mutation(api.localAuth.signOut, { tokenHash: hashLocalSecret(token) });
      const response = NextResponse.json({ ok: true });
      response.cookies.set(LOCAL_SESSION_COOKIE, "", { path: "/", maxAge: 0, httpOnly: true, sameSite: "lax", secure });
      return response;
    }
    const token = newLocalSecret();
    const session = { tokenHash: hashLocalSecret(token), expiresAt: Date.now() + SESSION_SECONDS * 1000 };
    if (body.kind === "register") {
      await broker.mutation(api.localAuth.register, {
        email: body.email, name: body.name, passwordHash: await hashPassword(body.password), subject: `local_${randomUUID()}`,
        ...(body.workspaceName ? { workspaceName: body.workspaceName } : {}), ...(body.invite ? { inviteHash: hashLocalSecret(body.invite) } : {}), ...session,
      });
    } else {
      const credential = await broker.query(api.localAuth.credential, { email: body.email });
      // An unknown email still runs scrypt, so account existence does not skip the expensive work.
      const valid = await verifyPassword(body.password, credential?.passwordHash ?? `scrypt:${"0".repeat(32)}:${"0".repeat(128)}`);
      if (!credential || !valid) return Response.json({ error: "Email or password is incorrect" }, { status: 401 });
      await broker.mutation(api.localAuth.signIn, { credentialId: credential._id, passwordHash: credential.passwordHash, ...session });
    }
    const response = NextResponse.json({ ok: true });
    response.cookies.set(LOCAL_SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: SESSION_SECONDS });
    return response;
  } catch (error) {
    if (!(error instanceof ConvexError)) throw error;
    return Response.json({ error: typeof error.data === "string" ? error.data : "Sign-in failed" }, { status: 400 });
  }
}
