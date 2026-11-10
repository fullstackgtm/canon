import { jsonBody, v1Route, methodNotAllowed } from "../../../_lib.ts";
import { mergeRecords } from "../../../_relations.ts";

export const dynamic = "force-dynamic";

export const POST = v1Route<{ object: string }>(async (client, request, { object }) => mergeRecords(client, object, await jsonBody(request)));

const { deny, options } = methodNotAllowed(["POST"]);
export { deny as GET, deny as PATCH, deny as PUT, deny as DELETE, options as OPTIONS };
