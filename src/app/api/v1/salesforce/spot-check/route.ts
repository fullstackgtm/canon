import { api } from "../../../../../../convex/_generated/api.js";
import { jsonBody, v1Route, V1Error, methodNotAllowed } from "../../_lib.ts";

export const dynamic = "force-dynamic";

const OBJECTS = new Set(["Account", "Contact", "Lead", "Opportunity", "Task", "Event", "Note", "ContentDocument"]);

/**
 * What Canon holds for up to 100 imported Salesforce records of one object
 * (CP11's spot check, scripts/sf-spot-check.ts). Body: `{object, sfIds}`.
 */
export const POST = v1Route<Record<string, never>>(async (client, request) => {
  const body = (await jsonBody(request)) as { object?: unknown; sfIds?: unknown };
  if (typeof body.object !== "string" || !OBJECTS.has(body.object)) throw new V1Error("invalid_request", `object is one of ${[...OBJECTS].join(", ")}`);
  if (!Array.isArray(body.sfIds) || !body.sfIds.every((id) => typeof id === "string")) throw new V1Error("invalid_request", "sfIds is a list of Salesforce ids");
  const data = await client.action(api.salesforceImport.spotCheck, { object: body.object as "Account", sfIds: body.sfIds as string[] });
  return { status: 200, body: { data } };
});

const { deny, options } = methodNotAllowed(["POST"]);
export { deny as GET, deny as PATCH, deny as PUT, deny as DELETE, options as OPTIONS };
