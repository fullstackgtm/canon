import { jsonBody, v1Route, methodNotAllowed } from "../../../_lib.ts";
import { dealRoles, setDealRole } from "../../../_relations.ts";

export const dynamic = "force-dynamic";

type Params = { id: string };

export const GET = v1Route<Params>((client, _request, { id }) => dealRoles(client, id));

export const POST = v1Route<Params>(async (client, request, { id }) => setDealRole(client, id, await jsonBody(request)));

const { deny, options } = methodNotAllowed(["GET", "POST"]);
export { deny as PATCH, deny as PUT, deny as DELETE, options as OPTIONS };
