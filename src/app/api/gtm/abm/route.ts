import { api } from "../../../../../convex/_generated/api";
import type { Id } from "../../../../../convex/_generated/dataModel";
import { gtmApi, readJsonBody, requireAction } from "../_lib";

export const dynamic = "force-dynamic";

export const GET = gtmApi(async ({ client, url }) => {
  const listId = url.searchParams.get("listId");

  const [stats, lists] = await Promise.all([
    client.query(api.abm.getStats, {}),
    client.query(api.abm.listLists, {}),
  ]);
  if (!listId) return Response.json({ stats, lists });

  const typedListId = listId as Id<"abmLists">;
  const [list, accounts, candidateAccounts, plays] = await Promise.all([
    client.query(api.abm.getList, { listId: typedListId }),
    client.query(api.abm.listAccounts, { listId: typedListId }),
    client.query(api.abm.listCandidateAccounts, { listId: typedListId }),
    client.query(api.abm.listPlays, { listId: typedListId }),
  ]);
  return Response.json({ stats, list, accounts, candidateAccounts, plays });
});

export const POST = gtmApi(async ({ client, request }) => {
  const body = await readJsonBody(request);
  const actionError = await requireAction(body, "generateFromCrm");
  if (actionError) return actionError;

  const result = await client.mutation(api.abm.generateFromCrm, {});
  return Response.json({ result });
});
