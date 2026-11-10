import { jsonBody, v1Route, methodNotAllowed } from "../../../../_lib.ts";
import { dismissDuplicates } from "../../../../_relations.ts";

export const dynamic = "force-dynamic";

export const POST = v1Route<{ object: string }>(async (client, request, { object }) => dismissDuplicates(client, object, await jsonBody(request)));

const { deny, options } = methodNotAllowed(["POST"]);
export { deny as GET, deny as PATCH, deny as PUT, deny as DELETE, options as OPTIONS };
