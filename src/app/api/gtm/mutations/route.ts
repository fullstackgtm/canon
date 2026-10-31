import { apiErrorResponse, gtmApi, readJsonBody } from "../_lib";
import {
  getGtmMutationReference,
  gtmMutationNames,
  gtmMutationSurfaceManifest,
} from "../../../../lib/gtm-mutation-registry.ts";

export const dynamic = "force-dynamic";

export const GET = gtmApi(() => Response.json(gtmMutationSurfaceManifest()));

export const POST = gtmApi(async ({ client, request }) => {
  const body = await readJsonBody(request);
  const name = typeof body.name === "string" ? body.name : null;
  // Only `mode: "apply"` executes. Every other value (including the default)
  // is an ECHO: the generated Convex `api` is `anyApi` — a proxy with no
  // runtime argument metadata — so we cannot validate `args` against the
  // mutation's schema here without hand-maintaining a parallel schema list.
  // We name that honestly (`mode: "echo"`, `validated: false`) instead of
  // calling an unvalidated echo a "dry run": typed dry-run previews are the
  // patch-plan surface's job (/api/gtm/patch-plans).
  const mode = body.mode === "apply" ? "apply" : "echo";
  const args = body.args && typeof body.args === "object" && !Array.isArray(body.args)
    ? (body.args as Record<string, unknown>)
    : {};

  if (!name) {
    return apiErrorResponse("USER_INPUT", "name is required", [
      "Pass an allowlisted mutation name such as api.patchPlans.approve.",
    ]);
  }

  const mutationRef = getGtmMutationReference(name);
  if (!mutationRef) {
    return apiErrorResponse("USER_INPUT", `Mutation is not allowlisted: ${name}`, [
      `Allowed mutations: ${gtmMutationNames().slice(0, 10).join(", ")}...`,
    ]);
  }

  if (mode !== "apply") {
    return Response.json({
      ok: true,
      mode: "echo",
      validated: false,
      mutation: name,
      args,
      note: "Echo only — args were not validated against the mutation's schema. Use the patch-plan surface for typed dry-run previews; pass mode=apply to execute.",
    });
  }

  const result = await client.mutation(mutationRef as any, args as any);
  return Response.json(result);
});
