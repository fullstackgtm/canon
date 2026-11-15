import { v1Route, V1_STATUS, V1Error, type V1ErrorCode } from '../../api/v1/_lib.ts';
import { handle } from '../_handler.ts';
export const dynamic = 'force-dynamic';
const inner = v1Route(handle);
import { errorBody } from '../_errors.ts';
async function route(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const response = await inner(request, context);
  const body = await response.json();
  if (body?.error) {
    const e = body.error;
    return Response.json(errorBody(new V1Error(e.code, e.message, e)), { status: ['invalid_request', 'validation_failed'].includes(e.code) ? 400 : V1_STATUS[e.code as V1ErrorCode], headers: response.headers });
  }
  return response.status === 200 && request.method === 'DELETE' ? new Response(null, { status: 204, headers: response.headers }) : Response.json(body, { status: response.status, headers: response.headers });
}
export { route as GET, route as POST, route as PATCH, route as DELETE, route as PUT };
