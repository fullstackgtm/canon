import { v1Route, methodNotAllowed } from "../../../../_lib.ts";
import { recordActivities } from "../../../../_relations.ts";

export const dynamic = "force-dynamic";

export const GET = v1Route<{ object: string; id: string }>((client, _request, { object, id }) => recordActivities(client, object, id));

const { deny, options } = methodNotAllowed(["GET"]);
export { deny as POST, deny as PATCH, deny as PUT, deny as DELETE, options as OPTIONS };
