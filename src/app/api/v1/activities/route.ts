import { jsonBody, v1Route, methodNotAllowed } from "../_lib.ts";
import { logActivity } from "../_relations.ts";

export const dynamic = "force-dynamic";

export const POST = v1Route<Record<string, never>>(async (client, request) => logActivity(client, await jsonBody(request)));

const { deny, options } = methodNotAllowed(["POST"]);
export { deny as GET, deny as PATCH, deny as PUT, deny as DELETE, options as OPTIONS };
