import { v1Route, methodNotAllowed } from "../../../../_lib.ts";
import { restoreRecord } from "../../../../_records.ts";

export const dynamic = "force-dynamic";

export const POST = v1Route<{ object: string; id: string }>((client, request, { object, id }) =>
  restoreRecord(client, object, id, new URL(request.url).searchParams));

const { deny, options } = methodNotAllowed(["POST"]);
export { deny as GET, deny as PATCH, deny as PUT, deny as DELETE, options as OPTIONS };
