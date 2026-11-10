/** The caller's workspace's objects and their fields, as plain JSON: the same descriptions GET /api/v1/openapi.json is built from. */
import { methodNotAllowed, v1Route } from "../_lib.ts";
import { objectsBody, workspaceObjects } from "../_openapi.ts";

export const dynamic = "force-dynamic";

export const GET = v1Route<Record<string, never>>(async (client) => ({ status: 200, body: objectsBody(await workspaceObjects(client)) }));

const { deny, options } = methodNotAllowed(["GET"]);
export { deny as POST, deny as PATCH, deny as PUT, deny as DELETE, options as OPTIONS };
