/** The record API's OpenAPI document for the caller's workspace: its custom objects and fields, and only what the caller's role sees. */
import { methodNotAllowed, v1Route } from "../_lib.ts";
import { buildOpenApi, workspaceObjects } from "../_openapi.ts";

export const dynamic = "force-dynamic";

export const GET = v1Route<Record<string, never>>(async (client, request) => ({
  status: 200,
  body: buildOpenApi(await workspaceObjects(client), { server: `${new URL(request.url).origin}/api/v1`, workspace: true }),
}));

const { deny, options } = methodNotAllowed(["GET"]);
export { deny as POST, deny as PATCH, deny as PUT, deny as DELETE, options as OPTIONS };
