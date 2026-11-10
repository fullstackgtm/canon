import { v1Route, methodNotAllowed } from "../../../_lib.ts";
import { groupRecords } from "../../../_records.ts";

export const dynamic = "force-dynamic";

export const GET = v1Route<{ object: string }>((client, request, { object }) => groupRecords(client, object, new URL(request.url).searchParams));

const { deny, options } = methodNotAllowed(["GET"]);
export { deny as POST, deny as PATCH, deny as PUT, deny as DELETE, options as OPTIONS };
