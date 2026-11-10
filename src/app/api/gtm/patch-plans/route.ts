import { api } from "../../../../../convex/_generated/api";
import type { Id } from "../../../../../convex/_generated/dataModel";
import { apiErrorResponse, gtmApi, readJsonBody } from "../_lib";

export const dynamic = "force-dynamic";

export const GET = gtmApi(async ({ client, url }) => {
  const patchPlanId = url.searchParams.get("patchPlanId") ?? url.searchParams.get("id");
  if (patchPlanId) {
    const result = await client.query(api.patchPlans.get, {
      patchPlanId: patchPlanId as Id<"patchPlans">,
    });
    return Response.json(result);
  }

  const limit = Number(url.searchParams.get("limit") ?? 50);
  const status = url.searchParams.get("status") ?? undefined;
  const result = await client.query(api.patchPlans.list, {
    limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 100) : 50,
    status: status as any,
  });
  return Response.json(result);
});

export const POST = gtmApi(async ({ client, request }) => {
  const body = await readJsonBody(request);
  const patchPlanId = typeof body.patchPlanId === "string" ? body.patchPlanId : null;
  const action = typeof body.action === "string" ? body.action : null;
  const reason = typeof body.reason === "string" ? body.reason : undefined;

  if (!patchPlanId) {
    return apiErrorResponse("USER_INPUT", "patchPlanId is required", [
      "Pass patchPlanId plus action=approve, action=reject, or action=apply.",
    ]);
  }

  if (action === "approve" || action === "reject") {
    const result = await client.mutation(api.patchPlans.approve, {
      patchPlanId: patchPlanId as Id<"patchPlans">,
      decision: action === "approve" ? "approved" : "rejected",
      reason,
    });
    return Response.json(result);
  }

  if (action === "apply") {
    const result = await client.action(api.patchPlanActions.apply, {
      patchPlanId: patchPlanId as Id<"patchPlans">,
    });
    return Response.json(result);
  }

  return apiErrorResponse("UNSUPPORTED_ACTION", "Unsupported action", [
    "Use action=approve, action=reject, or action=apply.",
  ]);
});
