import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { visitHeaders, visitFileHeaders } from "./lib/visitHeaders.ts";
import { isClerkContextOnlyPath, isPublicPath } from "./publicPaths.ts";

const DEV_MODE =
  (process.env.NODE_ENV !== "production" &&
    !process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) ||
  process.env.NEXT_PUBLIC_FSGTM_UI_SMOKE_BYPASS === "true";

function smokeBypassToken() {
  return (
    process.env.FSGTM_SMOKE_BYPASS_TOKEN ??
    process.env.FSGTM_UI_SMOKE_BYPASS_TOKEN
  );
}

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (process.env.NEXT_PUBLIC_CANON_SELFHOST === "true" &&
      (path === "/convex" || path.startsWith("/convex/") || path === "/convex-site" || path.startsWith("/convex-site/"))) {
    return NextResponse.next();
  }
  if (path === "/r" || path.startsWith("/r/") || path.startsWith("/api/visit/")) {
    const nonce = btoa(crypto.randomUUID());
    const headers = path === "/api/visit/file" ? visitFileHeaders() : visitHeaders(nonce, process.env.NODE_ENV !== "production");
    const forwarded = new Headers(request.headers);
    forwarded.set("Content-Security-Policy", headers["Content-Security-Policy"]);
    forwarded.set("x-nonce", nonce);
    if (isPublicPath(path)) {
      const response = NextResponse.next({ request: { headers: forwarded } });
      for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
      return response;
    }
    return new NextResponse(null, { status: 404, headers });
  }
  const bypassToken = smokeBypassToken();
  const isSmokeBypass =
    Boolean(bypassToken) &&
    (request.headers.get("x-fsgtm-smoke-bypass") === bypassToken ||
      request.headers.get("x-fsgtm-ui-smoke") === bypassToken);

  if (process.env.CANON_AUTH === "local") {
    const [{ localAuthGate }, { sessionForToken }] = await Promise.all([import("./lib/localAuthGate.ts"), import("./lib/localAuth.ts")]);
    return (await localAuthGate(request, sessionForToken)) ?? NextResponse.next();
  }

  if (DEV_MODE || isSmokeBypass || isPublicPath(request.nextUrl.pathname)) {
    return NextResponse.next();
  }

  const { clerkMiddleware } = await import("@clerk/nextjs/server");

  const handler = clerkMiddleware(async (auth, req) => {
    // /mcp needs Clerk's middleware CONTEXT (so the route can verify OAuth
    // access tokens via auth({acceptsToken:"oauth_token"})) but must not be
    // session-gated — withMcpAuth in the route answers unauthenticated
    // clients with the RFC 9728 401 + resource_metadata discovery hint.
    if (isClerkContextOnlyPath(req.nextUrl.pathname)) return;
    await auth.protect();
  });

  return handler(request, {} as any);
}

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
