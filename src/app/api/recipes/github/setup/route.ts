import { serverSession } from "../../../../../lib/serverSession.ts";
import { ConvexHttpClient } from "convex/browser";
import { ConvexError } from "convex/values";
import { api } from "../../../../../../convex/_generated/api.js";
import { siteBase } from "../../../agents/_lib.ts";

export const dynamic = "force-dynamic";

/**
 * Where GitHub returns an admin from Canon's GitHub App (docs/recipes.md, R5b). It sits behind the active session
 * gate, and the signed-in person's Convex token goes with the call, so `githubRecipes.completeSetup` checks the
 * state against that person and their workspace. GitHub's own parameters prove nothing by themselves.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const base = siteBase(request);
  const back = (params: Record<string, string>) => Response.redirect(`${base}/dashboard/customization?${new URLSearchParams({ tab: "browse", ...params })}`, 302);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code") ?? undefined;
  const installation = url.searchParams.get("installation_id");
  if (!state) return back({ github_error: "GitHub came back without Canon's connect request, as it does after an owner approves an install there. Connect GitHub again from here to finish." });
  if (installation !== null && !/^\d{1,15}$/.test(installation)) return back({ github_error: "GitHub sent an installation id Canon can't read." });

  const client = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
  const session = await serverSession();
  if (!session) return Response.redirect(process.env.CANON_AUTH === "local" ? `${base}/sign-in` : `${base}/sign-in?redirect_url=${encodeURIComponent(request.url)}`, 302);
  if (session.token) client.setAuth(session.token);

  try {
    const result = await client.action(api.githubRecipes.completeSetup, {
      state, code, ...(installation !== null ? { installationId: Number(installation) } : {}), redirectUri: `${base}/api/recipes/github/setup`,
    });
    if ("authorize" in result) return Response.redirect(result.authorize, 302);
    return back({ github: result.connected.join(",") });
  } catch (error) {
    return back({ github_error: error instanceof ConvexError && typeof error.data === "string" ? error.data : "Connecting GitHub failed. Try again from the Customization page." });
  }
}
