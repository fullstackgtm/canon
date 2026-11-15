import { z } from 'zod';
import { api } from '../../../convex/_generated/api.js';
import { workspaceObjects } from '../api/v1/_openapi.ts';
import { createRecord, deleteRecord, getRecord, listRecords, updateRecord, type ApiRecord } from '../api/v1/_records.ts';
import { changeAssociation, setDealRole, removeFromDeal } from '../api/v1/_relations.ts';
import { jsonBody, toV1Error, V1Error, type V1Client, type V1Result } from '../api/v1/_lib.ts';
import { decode, describe, invalid, OBJECTS, property, schema, value, type ObjectDef } from './_schema.ts';
import { errorBody } from './_errors.ts';
import { searchParams } from './_search.ts';
import { memberRecords, recordsByIds } from '../api/v1/_compat.ts';
const ok = (body: unknown, status = 200): V1Result => ({ body, status });
const Write = z.object({ properties: z.record(z.string(), z.unknown()), associations: z.array(z.object({ to: z.object({ id: z.string() }), types: z.array(z.object({ associationCategory: z.literal('HUBSPOT_DEFINED'), associationTypeId: z.number().int() })) })).optional() }).strict();
const associationPairs: Record<number, [string, string]> = { 1: ['contact', 'account'], 2: ['account', 'contact'], 3: ['deal', 'contact'], 4: ['contact', 'deal'], 5: ['deal', 'account'], 6: ['account', 'deal'] };
const supported = (a: string, b: string) => Object.values(associationPairs).some(([from, to]) => a === from && b === to);
async function associate(client: V1Client, from: string, id: string, to: string, target: string, remove = false) {
  if (!supported(from, to)) invalid('Unsupported association pair');
  await getRecord(client, from, id); await getRecord(client, to, target);
  if (from === 'deal' || to === 'deal') {
    const deal = from === 'deal' ? id : target;
    const other = from === 'deal' ? target : id;
    if (from === 'account' || to === 'account') {
      const current = ((await getRecord(client, 'deal', deal)).body as { data: ApiRecord }).data;
      if (remove && current.values.companyId !== other) return;
      const result = await updateRecord(client, 'deal', deal, { values: { companyId: remove ? null : other }, expectedVersion: current.version, source: 'user' });
      applied(result);
    } else if (remove) await removeFromDeal(client, deal, other);
    else {
      const people = await client.action(api.dealCommittee.forDeal, { streamId: deal });
      if (!people?.members.some(m => m.contactId === other)) await setDealRole(client, deal, { contactId: other, role: 'involved' });
    }
  } else await changeAssociation(client, { op: remove ? 'unlink' : 'link', contactId: from === 'contact' ? id : target, accountId: from === 'account' ? id : target });
}
function applied(result: V1Result): { id: string } {
  const body = result.body as { id: string; status: string };
  if (body.status === 'proposed') invalid('Write held for review by Canon; no change was applied');
  return body;
}
async function render(client: V1Client, o: ObjectDef, rows: ApiRecord[], names?: string[], associations: string[] = []) {
  if (o.canon === 'deal') {
    const pipelines = await client.query(api.pipelines.list, {}) ?? [];
    rows = rows.map(r => ({ ...r, values: { ...r.values, pipelineId: pipelines.find(p => p.stages.some(s => s.value === r.values.stage))?.id ?? 'default' } }));
  }
  const fields = names ? names.map(n => property(o, n)) : o.properties;
  const targets = associations.map(n => ({ name: n, canon: OBJECTS[n] ?? n }));
  if (targets.some(t => !supported(o.canon, t.canon))) invalid('Unsupported association pair');
  const links = targets.length && rows.length ? await client.action(api.associations.relatedBatch, { object: o.canon as 'contact', ids: rows.map(r => r.id), targets: targets.map(t => t.canon as 'contact') }) : [];
  return rows.map(r => ({ id: r.id, properties: Object.fromEntries(fields.map(p => [p.name, value(r, p)])), createdAt: new Date(r.createdAt).toISOString(), updatedAt: new Date(r.updatedAt).toISOString(), archived: r.deletedAt !== null,
    ...(targets.length ? { associations: Object.fromEntries(targets.map(t => [t.name, { results: (links.find(l => l.id === r.id)?.links ?? []).filter(l => l.object === t.canon).map(l => ({ id: l.id, type: `${o.canon === 'account' ? 'company' : o.canon}_to_${t.canon === 'account' ? 'company' : t.canon}` })) }])) } : {}) }));
}
async function single(client: V1Client, o: ObjectDef, method: string, id: string | undefined, raw?: unknown) {
  if (method === 'GET' && id) {
    const record = o.def.register ? (await recordsByIds(client, o.canon, [id])).get(id) : ((await getRecord(client, o.canon, id)).body as { data: ApiRecord }).data;
    if (!record) throw new V1Error('not_found', 'Record not found');
    return record;
  }
  if (method === 'DELETE' && id) { applied(await deleteRecord(client, o.canon, id, new URLSearchParams())); return null; }
  const parsed = Write.safeParse(raw); if (!parsed.success) return invalid('Expected properties and optional associations');
  const b = parsed.data;
  if (id && b.associations?.length) invalid('Associations on PATCH are unsupported; use v4');
  const edges = (b.associations ?? []).map(a => {
    if (a.types.length !== 1) return invalid('Exactly one default association type is required');
    const pair = associationPairs[a.types[0]!.associationTypeId];
    if (!pair || pair[0] !== o.canon) return invalid('Unsupported default association type');
    return { to: pair[1], id: a.to.id };
  });
  for (const edge of edges) await getRecord(client, edge.to!, edge.id);
  const values: Record<string, unknown> = {};
  for (const [name, v] of Object.entries(b.properties)) {
    const p = property(o, name);
    const createFields = o.canon === 'account' ? ['domain', 'name', 'industry', 'employees', 'country', 'linkedinUrl'] : o.canon === 'contact' ? ['fullName', '$firstname', '$lastname', 'title', 'email', 'linkedinUrl'] : [];
    if (p.readOnly && (id || !createFields.includes(p.canon))) invalid('Property is read only', name);
    values[p.canon] = decode(p, v);
  }
  if (o.canon === 'contact' && ('$firstname' in values || '$lastname' in values)) {
    const old = id ? ((await getRecord(client, o.canon, id)).body as { data: ApiRecord }).data : null;
    const parts = String(old?.values.fullName ?? '').split(' ');
    values.fullName = [values.$firstname ?? parts.slice(0, -1).join(' '), values.$lastname ?? parts.at(-1)].filter(Boolean).join(' ');
    delete values.$firstname; delete values.$lastname;
  }
  if (!id && o.canon === 'contact') {
    const company = edges.find(e => e.to === 'account');
    if (!company) invalid('Canon contacts require a company association', 'associations');
    await getRecord(client, 'account', company!.id);
    values.accountId = company!.id;
  }
  if (!id) {
    const required = new Set(o.properties.filter(p => p.required && !p.readOnly).map(p => p.canon));
    if (o.canon === 'account') { required.add('domain'); required.add('name'); }
    if (o.canon === 'contact') required.add('fullName');
    if (o.canon === 'deal') for (const n of ['name', 'stage', 'closeDate']) required.add(n);
    for (const n of required) if (values[n] === undefined || values[n] === null || values[n] === '') invalid('Required property is missing', o.properties.find(p => p.canon === n)?.name ?? n);
  }
  if (values.pipelineId === 'default') values.pipelineId = null;
  if (!id && o.canon === 'deal' && 'ownerId' in values) { values.primaryRepId = values.ownerId; delete values.ownerId; }
  const current = id && !o.def.register ? ((await getRecord(client, o.canon, id)).body as { data: ApiRecord }).data : null;
  if (id && o.canon === 'deal' && 'pipelineId' in values) {
    const pipelines = await client.query(api.pipelines.list, {}) ?? [];
    const pipeline = pipelines.find(p => p.id === values.pipelineId);
    if (!pipeline || !pipeline.stages.some(s => s.value === (values.stage ?? current?.values.stage))) invalid('Pipeline must contain the selected deal stage', 'pipeline');
    delete values.pipelineId;
  }
  const body = { values, ...(o.def.register ? {} : { source: 'user', ...(current ? { expectedVersion: current.version } : {}) }) };
  let result: { id: string } | undefined;
  try {
    const createKeys = o.canon === 'account' ? ['domain', 'name', 'industry', 'employees', 'country', 'linkedinUrl'] : o.canon === 'contact' ? ['fullName', 'accountId', 'title', 'email', 'linkedinUrl'] : o.canon === 'deal' ? ['name', 'amount', 'currency', 'closeDate', 'stage', 'pipelineId', 'dealType', 'revenueType', 'primaryRepId', 'companyId'] : null;
    if (!id && createKeys) for (const key of Object.keys(values)) {
      if (!createKeys.includes(key) && !(o.canon === 'deal' && key.startsWith('custom.'))) invalid('Property is supported on PATCH only', o.properties.find(p => p.canon === key)?.name ?? key);
    }
    result = applied(id ? await updateRecord(client, o.canon, id, body) : await createRecord(client, o.canon, body));
    for (const edge of edges) await associate(client, o.canon, result.id, edge.to!, edge.id);
  } catch (error) {
    const e = toV1Error(error);
    const errors = e.details?.errors as { field: string; message: string }[] | undefined;
    throw new V1Error(e.code, e.message, { ...e.details, ...(!id && result ? { context: { createdObjectId: [result.id] } } : {}), ...(errors ? { errors: errors.map(x => ({ ...x, field: o.properties.find(p => p.canon === x.field)?.name ?? x.field })) } : {}) }, e.headers);
  }
  return ((await getRecord(client, o.canon, result!.id)).body as { data: ApiRecord }).data;
}
export async function handle(client: V1Client, request: Request, { path }: { path: string[] }): Promise<V1Result> {
  const method = request.method, params = new URL(request.url).searchParams;
  if (path[0] !== 'crm' || !['v3', 'v4'].includes(path[1] ?? '')) throw new V1Error('not_found', 'Unknown resource');
  const parts = path.slice(2);
  if (path[1] === 'v3' && parts[0] === 'owners' && method === 'GET') {
    const users = await memberRecords(client);
    const owners = users.map(u => ({ id: u.id, type: 'PERSON', createdAt: new Date(u.createdAt).toISOString(), updatedAt: new Date(u.updatedAt).toISOString(), email: u.values.email, firstName: u.title.split(' ').slice(0, -1).join(' '), lastName: u.title.split(' ').at(-1), archived: !u.values.isActive }));
    if (parts[1]) { const owner = owners.find(u => u.id === parts[1]); if (!owner) throw new V1Error('not_found', 'Owner not found'); return ok(owner); }
    const start = Number(params.get('after') ?? 0), limit = Number(params.get('limit') ?? 100);
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) invalid('Invalid owner paging');
    const rows = owners.filter(u => u.archived === (params.get('archived') === 'true'));
    return ok({ results: rows.slice(start, start + limit), ...(start + limit < rows.length ? { paging: { next: { after: String(start + limit) } } } : {}) });
  }
  if (path[1] === 'v3' && parts[0] === 'pipelines' && parts[1] === 'deals' && method === 'GET') {
    const rows = (await client.query(api.pipelines.list, {}) ?? []).map((p, i) => ({ id: p.id ?? 'default', label: p.name, displayOrder: i, archived: false, stages: p.stages.map((s, j) => ({ id: s.value ?? '', label: s.label, displayOrder: j, metadata: { probability: String(s.probability) }, archived: false })) }));
    if (!parts[2]) return ok({ results: rows });
    const p = rows.find(p => p.id === parts[2]); if (!p) throw new V1Error('not_found', 'Pipeline not found');
    return ok(parts[3] === 'stages' ? { results: p.stages } : p);
  }
  if (!['objects', 'properties'].includes(parts[0] ?? '')) throw new V1Error('not_found', 'Unknown resource');
  const canon = OBJECTS[parts[1] ?? ''] ?? parts[1];
  const def = (await workspaceObjects(client)).find(o => o.readable && o.apiName === canon && (Object.values(OBJECTS).includes(o.apiName) || o.apiName.startsWith('custom_')));
  if (!def) throw new V1Error('unknown_object', 'Unknown object');
  const o = schema(def);
  if (parts[0] === 'properties' && path[1] === 'v3') {
    if (method !== 'GET') throw new V1Error('unsupported', 'Properties are read only');
    return ok(parts[2] ? describe(property(o, parts[2])) : { results: o.properties.map(describe) });
  }
  const id = parts[2];
  if (path[1] === 'v4') {
    const remove = method === 'DELETE';
    const to = OBJECTS[parts[4] === 'default' ? parts[5]! : parts[4]!] ?? parts[4];
    if (parts[3] !== 'associations' || !id || !to || !supported(o.canon, to)) invalid('Unsupported association path');
    if (method === 'GET' && parts.length === 5) {
      const rows = await render(client, o, [await single(client, o, 'GET', id) as ApiRecord], [], [parts[4]!]);
      return ok({ results: rows[0]!.associations![parts[4]!]!.results.map(r => ({ toObjectId: r.id, associationTypes: [{ category: 'HUBSPOT_DEFINED', typeId: Number(Object.entries(associationPairs).find(([, pair]) => pair[0] === o.canon && pair[1] === to)?.[0]), label: null }] })) });
    }
    const target = remove ? parts[5] : parts[6];
    if (!target || !(remove || method === 'PUT' && parts[4] === 'default')) invalid('Unsupported association method');
    await associate(client, o.canon, id!, to!, target!, remove);
    const now = new Date().toISOString();
    return ok(remove ? null : { status: 'COMPLETE', startedAt: now, completedAt: now, results: [{ from: { id }, to: { id: target }, associationSpec: { associationCategory: 'HUBSPOT_DEFINED', associationTypeId: Number(Object.entries(associationPairs).find(([, pair]) => pair[0] === o.canon && pair[1] === to)?.[0]) } }] });
  }
  if (id === 'search' && method === 'POST') {
    const search = searchParams(o, await jsonBody(request));
    const page = (await listRecords(client, o.canon, search.params, true)).body as { data: ApiRecord[]; total: number; nextCursor: string | null };
    return ok({ total: page.total, results: await render(client, o, page.data, search.properties), ...(page.nextCursor ? { paging: { next: { after: page.nextCursor } } } : {}) });
  }
  if (id === 'batch' && method === 'POST') {
    const op = parts[3]; if (!['read', 'create', 'update', 'archive'].includes(op ?? '')) throw new V1Error('unsupported', 'Unsupported batch operation');
    const parsed = z.object({ inputs: z.array(z.record(z.string(), z.unknown())).max(100), properties: z.array(z.string()).optional(), propertiesWithHistory: z.array(z.string()).max(0).optional() }).strict().safeParse(await jsonBody(request));
    if (!parsed.success) invalid('Invalid batch body');
    const b = parsed.data!, startedAt = new Date().toISOString(), results: unknown[] = [], errors: unknown[] = [];
    for (const input of b.inputs) try {
      if (Object.keys(input).some(k => !(op === 'create' ? ['properties', 'associations'] : op === 'update' ? ['id', 'properties'] : ['id']).includes(k))) invalid('Unsupported batch input field');
      if (op !== 'create' && typeof input.id !== 'string') invalid('Batch input requires id');
      const row = await single(client, o, ({ read: 'GET', create: 'POST', update: 'PATCH', archive: 'DELETE' } as Record<string, string>)[op!]!, input.id as string | undefined, op === 'create' ? input : { properties: input.properties });
      if (row) results.push((await render(client, o, [row], b.properties))[0]);
    } catch (error) { const e = toV1Error(error); errors.push({ ...errorBody(e), context: { ...(e.details?.context as Record<string, unknown> ?? {}), id: [String(input.id ?? '')] } }); }
    return ok({ status: 'COMPLETE', results, startedAt, completedAt: new Date().toISOString(), ...(errors.length ? { numErrors: errors.length, errors } : {}) }, errors.length ? 207 : op === 'create' ? 201 : 200);
  }
  if (parts.length > 3) throw new V1Error('not_found', 'Unknown resource');
  const names = params.has('properties') ? params.getAll('properties').flatMap(v => v.split(',')) : undefined;
  const associations = params.getAll('associations').flatMap(v => v.split(','));
  if (method === 'GET' && !id) {
    const limit = Number(params.get('limit') ?? 10); if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid('limit must be 1 to 100');
    if (params.has('archived') && !['true', 'false'].includes(params.get('archived')!)) invalid('archived must be true or false');
    const p = new URLSearchParams({ limit: String(limit), ...(params.has('after') ? { cursor: params.get('after')! } : {}), ...(params.get('archived') === 'true' ? { deleted: 'true' } : {}) });
    const page = (await listRecords(client, o.canon, p, true)).body as { data: ApiRecord[]; nextCursor: string | null };
    return ok({ results: await render(client, o, page.data, names, associations), ...(page.nextCursor ? { paging: { next: { after: page.nextCursor } } } : {}) });
  }
  let resolved = id;
  if (params.has('idProperty')) {
    const p = params.get('idProperty')!;
    if (method !== 'GET' || !(o.canon === 'contact' && p === 'email' || o.canon === 'account' && p === 'domain')) invalid('Unsupported idProperty');
    const page = (await listRecords(client, o.canon, new URLSearchParams({ limit: '2', filter: `${p}:eq:${id}` }), true)).body as { data: ApiRecord[]; total: number };
    if (page.total > 1) invalid('idProperty is not unique', p);
    resolved = page.data[0]?.id; if (!resolved) throw new V1Error('not_found', 'Record not found');
  }
  if (!(method === 'GET' && resolved || method === 'POST' && !id || ['PATCH', 'DELETE'].includes(method) && resolved)) throw new V1Error('unsupported', 'Unsupported method');
  const row = await single(client, o, method, resolved, ['POST', 'PATCH'].includes(method) ? await jsonBody(request) : undefined);
  return row ? ok((await render(client, o, [row], names, associations))[0], method === 'POST' ? 201 : 200) : ok(null);
}
