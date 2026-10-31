import { v1Route, methodNotAllowed } from "../../../_lib.ts";
import { undoMerge } from "../../../_relations.ts";

export const dynamic = "force-dynamic";

export const POST = v1Route<{ mergeId: string }>((client, _request, { mergeId }) => undoMerge(client, mergeId));

const { deny, options } = methodNotAllowed(["POST"]);
export { deny as GET, deny as PATCH, deny as PUT, deny as DELETE, options as OPTIONS };
