import { v1Route, methodNotAllowed } from "../../../../_lib.ts";
import { removeFromDeal } from "../../../../_relations.ts";

export const dynamic = "force-dynamic";

export const DELETE = v1Route<{ id: string; contactId: string }>((client, _request, { id, contactId }) => removeFromDeal(client, id, contactId));

const { deny, options } = methodNotAllowed(["DELETE"]);
export { deny as GET, deny as POST, deny as PATCH, deny as PUT, options as OPTIONS };
