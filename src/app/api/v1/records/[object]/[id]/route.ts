import { jsonBody, v1Route, methodNotAllowed } from "../../../_lib.ts";
import { deleteRecord, getRecord, updateRecord } from "../../../_records.ts";

export const dynamic = "force-dynamic";

type Params = { object: string; id: string };

export const GET = v1Route<Params>((client, _request, { object, id }) => getRecord(client, object, id));

export const PATCH = v1Route<Params>(async (client, request, { object, id }) => updateRecord(client, object, id, await jsonBody(request)));

export const DELETE = v1Route<Params>((client, request, { object, id }) => deleteRecord(client, object, id, new URL(request.url).searchParams));

const { deny, options } = methodNotAllowed(["GET", "PATCH", "DELETE"]);
export { deny as POST, deny as PUT, options as OPTIONS };
