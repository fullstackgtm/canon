import { v1Route, V1_STATUS, type V1ErrorCode } from '../../api/v1/_lib.ts';
import { handle } from '../_handler.ts';
export const dynamic = 'force-dynamic';
const inner = v1Route(handle);
const codes: Record<V1ErrorCode, string> = { unauthorized: 'INVALID_SESSION_ID', forbidden: 'INSUFFICIENT_ACCESS_OR_READONLY', unknown_object: 'INVALID_TYPE', not_found: 'NOT_FOUND', invalid_request: 'MALFORMED_QUERY', validation_failed: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', version_conflict: 'VERSION_CONFLICT', idempotency_key_reused: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', unsupported: 'NOT_FOUND', rate_limited: 'REQUEST_LIMIT_EXCEEDED', not_configured: 'SERVER_UNAVAILABLE', internal: 'UNKNOWN_EXCEPTION' };
async function route(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const response = await inner(request, context);
  const body = await response.json();
  if (body?.error) {
    const e = body.error;
    const code = e.code as V1ErrorCode;
    return Response.json([{ message: e.message, errorCode: e.salesforceCode ?? (code === 'invalid_request' && request.method !== 'GET' ? 'INVALID_FIELD' : code === 'validation_failed' && /required|missing/i.test(JSON.stringify(e.errors ?? e.message)) ? 'REQUIRED_FIELD_MISSING' : codes[code]), fields: e.fields ?? e.errors?.map((x: { field: string }) => x.field) ?? [] }], { status: e.salesforceCode === 'NOT_FOUND' ? 404 : code === 'rate_limited' ? 403 : code === 'validation_failed' ? 400 : V1_STATUS[code], headers: response.headers });
  }
  if (request.method === 'PATCH' || request.method === 'DELETE') return new Response(null, { status: 204, headers: response.headers });
  return Response.json(body, { status: response.status, headers: response.headers });
}
export { route as GET, route as POST, route as PATCH, route as DELETE, route as PUT };
