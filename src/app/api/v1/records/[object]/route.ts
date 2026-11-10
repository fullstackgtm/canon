import { idempotencyKeyOf, jsonBody, v1Route, methodNotAllowed } from "../../_lib.ts";
import { createRecord, listRecords } from "../../_records.ts";

export const dynamic = "force-dynamic";

type Params = { object: string };

export const GET = v1Route<Params>((client, request, { object }) => listRecords(client, object, new URL(request.url).searchParams));

export const POST = v1Route<Params>(async (client, request, { object }) =>
  createRecord(client, object, await jsonBody(request), idempotencyKeyOf(request)));

const { deny, options } = methodNotAllowed(["GET", "POST"]);
export { deny as PATCH, deny as PUT, deny as DELETE, options as OPTIONS };
