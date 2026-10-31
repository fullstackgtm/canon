import { api } from "../../../../../convex/_generated/api";
import { plainConvexClient, rateLimit, tooManyRequests } from "../../cli/_lib";

export const runtime = "nodejs";
export async function GET(request: Request) {
  if (!rateLimit(request, 20, 60_000)) return tooManyRequests();
  const token = new URL(request.url).searchParams.get("token");
  if (!token || !/^[a-f0-9]{32}$/.test(token))
    return Response.json({ error: "Invalid invitation." }, { status: 400 });
  const session = await plainConvexClient().query(api.researchSessions.get, {
    token,
  });
  if (!session?.invited)
    return Response.json(
      { error: "An invitation is required." },
      { status: 403 },
    );
  const signup = new URL("/sign-up", request.url);
  signup.searchParams.set("research", token);
  signup.searchParams.set("redirect_url", `/start/${token}/claim`);
  const response = Response.redirect(signup, 303);
  const headers = new Headers(response.headers);
  headers.append(
    "Set-Cookie",
    `fsgtm_invite=${token}; Path=/sign-up; Max-Age=3600; HttpOnly; SameSite=Lax${process.env.NODE_ENV === "production" ? "; Secure" : ""}`,
  );
  return new Response(null, { status: 303, headers });
}
