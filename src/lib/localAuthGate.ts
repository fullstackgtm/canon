import { isPublicPath } from "../publicPaths.ts";
import { LOCAL_SESSION_COOKIE, localAuthPublicPath } from "./authMode.ts";

export async function localAuthGate(request: Request, resolveSession: (token: string | undefined) => Promise<unknown>) {
  const url = new URL(request.url);
  if (localAuthPublicPath(url.pathname) || isPublicPath(url.pathname) || url.pathname === "/mcp") return null;
  const cookie = request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${LOCAL_SESSION_COOKIE}=`));
  const token = cookie?.slice(LOCAL_SESSION_COOKIE.length + 1);
  if (await resolveSession(token)) return null;
  if (url.pathname.startsWith("/api/")) return Response.json({ error: "Sign in first" }, { status: 401 });
  return Response.redirect(new URL("/sign-in", url), 307);
}
