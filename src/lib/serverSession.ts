/** The active dashboard session's token and evidence subject; null means sign-in is required. */
export async function serverSession(): Promise<{ token: string | null; subject: string | null } | null> {
  if (process.env.CANON_AUTH === "convex") {
    const { convexAuthNextjsToken } = await import("@convex-dev/auth/nextjs/server");
    const token = await convexAuthNextjsToken();
    if (!token) return null;
    // Convex verifies the token. Reading its subject here only binds signed evidence to that same session.
    try {
      const claims: { sub?: unknown } = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
      return typeof claims.sub === "string" ? { token, subject: claims.sub } : null;
    } catch { return null; }
  }
  if (process.env.CANON_AUTH === "local") {
    const { localSession, mintLocalToken } = await import("./localAuth.ts");
    const session = await localSession();
    return session ? { token: mintLocalToken(session), subject: session.user.clerkUserId } : null;
  }
  if (process.env.NODE_ENV !== "production" && !process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) return { token: null, subject: null };
  const { auth } = await import("@clerk/nextjs/server");
  const session = await auth();
  const token = await session.getToken({ template: "convex" });
  return token && session.userId ? { token, subject: session.userId } : null;
}
