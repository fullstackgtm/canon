import { api } from "../../../../../convex/_generated/api";
import type { Id } from "../../../../../convex/_generated/dataModel";
import { gtmApi, readJsonBody, requireAction } from "../_lib";

export const dynamic = "force-dynamic";

export const GET = gtmApi(async ({ client, url }) => {
  const accountId = url.searchParams.get("accountId");

  if (accountId) {
    const enrichment = await client.query(api.research.getForAccount, {
      accountId: accountId as Id<"crmAccounts">,
    });
    return Response.json({ enrichment });
  }

  const enrichments = await client.query(api.research.listEnrichments, {});
  return Response.json({ enrichments });
});

export const POST = gtmApi(async ({ client, request }) => {
  const body = await readJsonBody(request);
  const actionError = await requireAction(body, "generateFromCrm");
  if (actionError) return actionError;

  const result = await client.mutation(api.research.generateFromCrm, {});
  return Response.json({ result });
});
