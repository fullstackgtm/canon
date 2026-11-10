import { api } from "../../../../../../convex/_generated/api.js";
import { jsonBody, v1Route, V1Error, methodNotAllowed } from "../../_lib.ts";
import { SALESFORCE_OBJECTS, SpotCheckBody } from "../../_contract.ts";

export const dynamic = "force-dynamic";

/**
 * What Canon holds for up to 100 imported Salesforce records of one object
 * (CP11's spot check, scripts/sf-spot-check.ts). Body: `{object, sfIds}`.
 */
export const POST = v1Route<Record<string, never>>(async (client, request) => {
  const parsed = SpotCheckBody.safeParse(await jsonBody(request));
  if (!parsed.success) {
    throw new V1Error("invalid_request", parsed.error.issues[0]!.path[0] === "sfIds" ? "sfIds is a list of Salesforce ids" : `object is one of ${SALESFORCE_OBJECTS.join(", ")}`);
  }
  const data = await client.action(api.salesforceImport.spotCheck, parsed.data);
  return { status: 200, body: { data } };
});

const { deny, options } = methodNotAllowed(["POST"]);
export { deny as GET, deny as PATCH, deny as PUT, deny as DELETE, options as OPTIONS };
