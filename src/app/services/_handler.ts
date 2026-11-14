import { api } from '../../../convex/_generated/api.js';
import { workspaceObjects } from '../api/v1/_openapi.ts';
import { createRecord, deleteRecord, getRecord, listRecords, updateRecord, type ApiRecord } from '../api/v1/_records.ts';
import { jsonBody, V1Error, type V1Client, type V1Result } from '../api/v1/_lib.ts';
import { fail, field, iso, OBJECTS, SalesforceError, schema, type SfObject, type SfField } from './_schema.ts';
import { parse } from './_soql.ts';

const ok = (body: unknown, status = 200): V1Result => ({ status, body });
const userSchema: SfObject = { name: 'User', canon: 'user', label: 'User', createable: false, updateable: false, deletable: false, custom: false, fields: Object.entries({ Id: 'id', Name: 'string', Email: 'email', IsActive: 'boolean', Title: 'string' }).map(([name, type]) => ({ name, canon: ({ Id: 'id', IsActive: 'isActive' } as Record<string, string>)[name] ?? name.toLowerCase(), type, label: name, nillable: true, createable: false, updateable: false, custom: false })) };
async function objects(client: V1Client) { return [...(await workspaceObjects(client)).filter(d => d.readable && (Object.values(OBJECTS).includes(d.apiName) || d.apiName.startsWith('custom_'))).map(schema), userSchema]; }
async function page(client: V1Client, obj: SfObject, params: URLSearchParams): Promise<{ data: ApiRecord[]; total: number; nextCursor: string | null }> {
  if (obj.canon !== 'user') return (await listRecords(client, obj.canon, params, true)).body as { data: ApiRecord[]; total: number; nextCursor: string | null };
  if ([...params.keys()].some(k => !['limit', 'filter', 'cursor'].includes(k))) fail('MALFORMED_QUERY', 'User supports Id filters only');
  const filters = params.getAll('filter');
  if (filters.some(f => !/^id:(eq|in):/.test(f))) fail('MALFORMED_QUERY', 'User supports Id filters only');
  const rows = (await client.query(api.users.list, {})).filter(u => filters.every(f => f.split(':').slice(2).join(':').split(',').includes(u._id)));
  const start = Number(params.get('cursor') ?? 0);
  if (!Number.isSafeInteger(start) || start < 0) fail('MALFORMED_QUERY', 'Invalid User cursor');
  const end = start + Number(params.get('limit') ?? 200);
  return { data: rows.slice(start, end).map(u => ({ id: u._id, object: 'user', title: u.name, version: 1, status: 'active', createdAt: 0, updatedAt: 0, deletedAt: null, values: { name: u.name, email: u.email, isActive: u.isActive, title: u.title ?? null } })), total: rows.length, nextCursor: end < rows.length ? String(end) : null };
}
function value(r: ApiRecord, f: SfField): unknown {
  if (f.canon === '$firstName' || f.canon === '$lastName') {
    const parts = String(r.values.fullName ?? '').split(' ');
    return f.canon === '$firstName' ? parts.slice(0, -1).join(' ') : parts.at(-1) ?? '';
  }
  const v = f.canon === 'id' ? r.id : f.canon === 'deletedAt' ? r.deletedAt !== null : f.canon === 'createdAt' ? r.createdAt : f.canon === 'updatedAt' ? r.updatedAt : r.values[f.canon] ?? null;
  return f.type === 'datetime' ? iso(v) : f.type === 'percent' && typeof v === 'number' ? v * 100 : f.type === 'currency' && typeof v === 'number' ? v / 100 : f.type === 'multipicklist' && Array.isArray(v) ? v.join(';') : v;
}
async function render(client: V1Client, obj: SfObject, rows: ApiRecord[], selections: string[], all: SfObject[], base: string) {
  const refs = new Map<string, Map<string, ApiRecord>>();
  for (const path of selections.filter(p => p.includes('.'))) {
    const rel = path.split('.')[0]!;
    if (refs.has(rel)) continue;
    const f = obj.fields.find(f => f.relationshipName?.toLowerCase() === rel.toLowerCase())!;
    const parent = all.find(o => f.referenceTo?.includes(o.name))!;
    const ids = [...new Set(rows.map(r => value(r, f)).filter((v): v is string => typeof v === 'string' && !!v))];
    const records = new Map<string, ApiRecord>();
    for (let i = 0; i < ids.length; i += 200) {
      let cursor: string | null = null;
      do {
        const params = new URLSearchParams({ limit: '200', filter: `id:in:${ids.slice(i, i + 200).join(',')}` });
        if (cursor) params.set('cursor', cursor);
        const result = await page(client, parent, params);
        result.data.forEach(r => records.set(r.id, r)); cursor = result.nextCursor;
      } while (cursor);
    }
    refs.set(rel, records);
  }
  return rows.map(r => {
    const out: Record<string, unknown> = { attributes: { type: obj.name, url: `${base}/sobjects/${obj.name}/${encodeURIComponent(r.id)}` } };
    for (const p of selections) {
      const [rel, child] = p.split('.');
      if (!child) { const f = field(obj, p); out[f.name] = value(r, f); continue; }
      const f = obj.fields.find(f => f.relationshipName?.toLowerCase() === rel!.toLowerCase())!;
      const parent = all.find(o => f.referenceTo?.includes(o.name))!;
      const record = refs.get(rel!)!.get(String(value(r, f)));
      if (!record) { out[f.relationshipName!] = null; continue; }
      const nested = (out[f.relationshipName!] ?? { attributes: { type: parent.name, url: `${base}/sobjects/${parent.name}/${record.id}` } }) as Record<string, unknown>;
      const pf = field(parent, child); nested[pf.name] = value(record, pf); out[f.relationshipName!] = nested;
    }
    return out;
  });
}
type Locator = { q: string; cursor?: string; seen: number; skip: number; batch: number };
async function query(client: V1Client, request: Request, all: SfObject[], base: string, locator?: string) {
  const url = new URL(request.url);
  let state: Locator;
  if (locator) {
    try { state = JSON.parse(Buffer.from(locator, 'base64url').toString()); } catch { return fail('MALFORMED_QUERY', 'Invalid query locator'); }
    if (!state || typeof state !== 'object' || typeof state.q !== 'string' || state.q.length > 16000 || !Number.isSafeInteger(state.seen) || state.seen < 0 || !Number.isInteger(state.skip) || state.skip < 0 || state.skip > 2000 || !Number.isInteger(state.batch) || state.batch < 200 || state.batch > 2000 || (state.cursor !== undefined && typeof state.cursor !== 'string')) fail('MALFORMED_QUERY', 'Invalid query locator');
  } else {
    const header = request.headers.get('sforce-query-options');
    if (header && !/^batchSize=\d+$/i.test(header)) fail('MALFORMED_QUERY', 'Invalid query options');
    const batch = header ? Number(header.split('=')[1]) : 2000;
    if (batch < 200 || batch > 2000) fail('MALFORMED_QUERY', 'batchSize must be 200 to 2000');
    state = { q: url.searchParams.get('q') ?? '', seen: 0, skip: 0, batch };
  }
  const parsed = parse(state.q, all);
  if (!locator) state.skip = parsed.offset;
  const rows: ApiRecord[] = [];
  let total = 0;
  let cursor = state.cursor;
  const desired = Math.min(state.batch, Math.max(0, (parsed.limit ?? Infinity) - state.seen));
  do {
    const params = new URLSearchParams(parsed.params);
    params.set('limit', String(Math.max(1, Math.min(200, parsed.count ? 1 : state.skip || desired - rows.length))));
    if (cursor) params.set('cursor', cursor);
    const result = await page(client, parsed.object, params);
    total = Math.max(0, result.total - parsed.offset);
    if (parsed.limit !== undefined) total = Math.min(total, parsed.limit);
    cursor = result.nextCursor ?? undefined;
    if (parsed.count) return ok({ totalSize: total, done: true, records: [] });
    if (state.skip) state.skip = Math.max(0, state.skip - result.data.length);
    else rows.push(...result.data.slice(0, desired - rows.length));
    if (!cursor) break;
  } while (state.skip || rows.length < desired);
  const seen = state.seen + rows.length;
  const done = !cursor || seen >= (parsed.limit ?? Infinity);
  const next: Locator = { q: state.q, cursor, seen, skip: 0, batch: state.batch };
  return ok({ totalSize: total, done, records: await render(client, parsed.object, rows, parsed.fields, all, base), ...(!done ? { nextRecordsUrl: `${base}/query/${Buffer.from(JSON.stringify(next)).toString('base64url')}` } : {}) });
}
export async function handle(client: V1Client, request: Request, { path }: { path: string[] }): Promise<V1Result> {
  const method = request.method;
  if (path.join('/') === 'oauth2/userinfo' && method === 'GET') {
    const me = await client.query(api.users.me, {});
    if (!me) throw new V1Error('unauthorized', 'Token has no user');
    return ok({ user_id: me._id, organization_id: me.orgId, preferred_username: me.email, name: me.name, email: me.email, active: me.isActive, sub: me._id });
  }
  if (path[0] !== 'data') throw new V1Error('not_found', 'Unknown resource');
  if (path.length === 1 && method === 'GET') return ok(Array.from({ length: 17 }, (_, i) => ({ version: `${50 + i}.0`, label: `Canon Salesforce compatibility ${50 + i}.0`, url: `/services/data/v${50 + i}.0` })));
  if (!/^v(5\d|6[0-6])\.0$/.test(path[1] ?? '')) throw new V1Error('not_found', 'Unsupported API version');
  const base = `/services/data/${path[1]}`;
  const parts = path.slice(2);
  if (!parts.length && method === 'GET') return ok({ sobjects: `${base}/sobjects`, query: `${base}/query` });
  const all = await objects(client);
  if (parts[0] === 'query' && parts.length <= 2 && method === 'GET') return query(client, request, all, base, parts[1]);
  if (parts[0] !== 'sobjects') throw new V1Error('not_found', 'Unknown resource');
  if (parts.length === 1 && method === 'GET') return ok({ encoding: 'UTF-8', maxBatchSize: 200, sobjects: all.map(o => ({ ...o, fields: undefined, queryable: true, retrieveable: true, urls: { sobject: `${base}/sobjects/${o.name}`, describe: `${base}/sobjects/${o.name}/describe` } })) });
  const obj = all.find(o => o.name.toLowerCase() === parts[1]?.toLowerCase()) ?? (() => { throw new V1Error('unknown_object', `Unknown sObject ${parts[1]}`); })();
  if ((parts.length === 2 || (parts.length === 3 && parts[2] === 'describe')) && method === 'GET') return ok({ ...obj, queryable: true, retrieveable: true, urls: { sobject: `${base}/sobjects/${obj.name}`, describe: `${base}/sobjects/${obj.name}/describe` } });
  if (parts.length > 3) fail('NOT_FOUND', 'External id upsert is not supported');
  const id = parts[2];
  if (method === 'GET' && id) {
    const selections = new URL(request.url).searchParams.get('fields')?.split(',') ?? obj.fields.map(f => f.name);
    selections.forEach(n => field(obj, n));
    const record = ['user', 'contact'].includes(obj.canon) ? (await page(client, obj, new URLSearchParams({ filter: `id:eq:${id}` }))).data[0] : ((await getRecord(client, obj.canon, id)).body as { data: ApiRecord }).data;
    if (!record) throw new V1Error('not_found', 'Record not found');
    return ok((await render(client, obj, [record], selections, all, base))[0]);
  }
  if (obj.canon === 'user') throw new V1Error('forbidden', 'User is read only');
  let result: V1Result;
  if (method === 'DELETE' && id) result = await deleteRecord(client, obj.canon, id, new URLSearchParams());
  else if ((method === 'POST' && !id) || (method === 'PATCH' && id)) {
    const raw = await jsonBody(request);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('INVALID_FIELD', 'Expected a JSON object');
    const values: Record<string, unknown> = {};
    for (const [name, v] of Object.entries(raw!)) {
      const f = field(obj, name);
      if (method === 'PATCH' ? !f.updateable : !f.createable) throw new SalesforceError('INVALID_FIELD', `${f.name} cannot be written`, [f.name]);
      if (f.type === 'datetime' && v !== null && (typeof v !== 'string' || !Number.isFinite(Date.parse(v)))) throw new SalesforceError('INVALID_FIELD', `${f.name} requires an ISO datetime`, [f.name]);
      values[f.canon] = f.type === 'percent' && typeof v === 'number' ? v / 100 : f.type === 'currency' && typeof v === 'number' ? Math.round(v * 100) : f.type === 'datetime' && typeof v === 'string' ? Date.parse(v) : f.type === 'multipicklist' && typeof v === 'string' ? v.split(';') : v;
    }
    if (obj.canon === 'contact' && ('$firstName' in values || '$lastName' in values)) {
      const existing = id ? ((await getRecord(client, 'contact', id)).body as { data: ApiRecord }).data : null;
      const parts = String(existing?.values.fullName ?? '').split(' ');
      values.fullName = [values.$firstName ?? parts.slice(0, -1).join(' '), values.$lastName ?? parts.at(-1) ?? ''].filter(Boolean).join(' ');
      delete values.$firstName; delete values.$lastName;
    }
    if (!id && obj.canon === 'account' && !values.domain) throw new SalesforceError('REQUIRED_FIELD_MISSING', 'Website is required because Canon identifies accounts by domain', ['Website']);
    if (!id && obj.canon === 'deal' && 'ownerId' in values) { values.primaryRepId = values.ownerId; delete values.ownerId; }
    const body = { values, ...(obj.canon === 'account' || obj.canon === 'contact' ? {} : { source: 'user' }) };
    result = id ? await updateRecord(client, obj.canon, id, body) : await createRecord(client, obj.canon, body);
  } else throw new V1Error('unsupported', 'Unsupported method');
  const body = result.body as { status: string; id: string };
  if (body.status === 'proposed') throw new SalesforceError('FIELD_CUSTOM_VALIDATION_EXCEPTION', 'Write held for review by Canon; no change was applied');
  return id ? ok(null, 200) : ok({ id: body.id, success: true, errors: [] }, 201);
}
