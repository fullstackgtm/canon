import { toV1Error, type V1ErrorCode } from '../api/v1/_lib.ts';
export const categories: Partial<Record<V1ErrorCode, string>> = { unauthorized: 'INVALID_AUTHENTICATION', forbidden: 'MISSING_SCOPES', not_found: 'OBJECT_NOT_FOUND', unknown_object: 'OBJECT_NOT_FOUND', version_conflict: 'CONFLICT', idempotency_key_reused: 'CONFLICT', rate_limited: 'RATE_LIMITS', internal: 'INTERNAL_ERROR' };
export function errorBody(error: unknown) {
  const e = toV1Error(error);
  const errors = e.details?.errors as { field: string; message: string }[] | undefined;
  return { status: 'error', message: e.message, correlationId: e.details?.requestId ?? crypto.randomUUID(), category: categories[e.code] ?? 'VALIDATION_ERROR', ...(e.details?.context ? { context: e.details.context } : {}), ...(errors ? { errors: errors.map(x => ({ message: x.message, context: { propertyName: [x.field] } })) } : {}) };
}
