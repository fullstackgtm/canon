import { jsonBody, v1Route, methodNotAllowed } from "../_lib.ts";
import { changeAssociation, relatedRecords } from "../_relations.ts";

export const dynamic = "force-dynamic";

export const GET = v1Route<Record<string, never>>((client, request) => relatedRecords(client, new URL(request.url).searchParams));

export const POST = v1Route<Record<string, never>>(async (client, request) => changeAssociation(client, await jsonBody(request)));

const { deny, options } = methodNotAllowed(["GET", "POST"]);
export { deny as PATCH, deny as PUT, deny as DELETE, options as OPTIONS };
