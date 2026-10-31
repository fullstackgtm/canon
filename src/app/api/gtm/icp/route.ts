import { api } from "../../../../../convex/_generated/api";
import type { Id } from "../../../../../convex/_generated/dataModel";
import { gtmApi, readJsonBody, requireAction } from "../_lib";

export const dynamic = "force-dynamic";

export const GET = gtmApi(async ({ client, url }) => {
  const profileId = url.searchParams.get("profileId");
  const typedProfileId = profileId as Id<"icpProfiles"> | null;
  const limitParam = Number(url.searchParams.get("limit") ?? 50);
  const limit = Number.isFinite(limitParam) ? limitParam : 50;

  const [profiles, scores, topAccounts] = await Promise.all([
    client.query(api.icp.listProfiles, {}),
    client.query(api.icp.listScores, {
      profileId: typedProfileId ?? undefined,
    }),
    client.query(api.icp.getTopAccounts, { limit }),
  ]);
  return Response.json({ profiles, scores, topAccounts });
});

export const POST = gtmApi(async ({ client, request }) => {
  const body = await readJsonBody(request);
  const actionError = await requireAction(body, "generateFromCrm");
  if (actionError) return actionError;

  const result = await client.action(api.icp.generateFromCrm, {});
  return Response.json({ result });
});
