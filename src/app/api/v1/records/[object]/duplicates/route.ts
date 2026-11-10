import { v1Route, methodNotAllowed } from "../../../_lib.ts";
import { listDuplicates } from "../../../_relations.ts";

export const dynamic = "force-dynamic";

export const GET = v1Route<{ object: string }>((client, _request, { object }) => listDuplicates(client, object));

const { deny, options } = methodNotAllowed(["GET"]);
export { deny as POST, deny as PATCH, deny as PUT, deny as DELETE, options as OPTIONS };
