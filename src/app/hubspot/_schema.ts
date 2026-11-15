import { HUBSPOT_DEFAULT_FIELD_MAPPINGS as mappings } from '../../../engine/src/mappings.ts';
import type { DescribedObject } from '../../../convex/lib/objects/describe.ts';
import type { ApiRecord } from '../api/v1/_records.ts';
import { V1Error } from '../api/v1/_lib.ts';

export const OBJECTS: Record<string, string> = { contacts: 'contact', companies: 'account', deals: 'deal', tasks: 'task', notes: 'note', meetings: 'meeting', calls: 'call', products: 'product', '0-1': 'contact', '0-2': 'account', '0-3': 'deal', '0-27': 'task', '0-46': 'note', '0-47': 'meeting', '0-48': 'call', '0-7': 'product' };
const aliases: Record<string, Record<string, string>> = {
  account: { ...mappings.accounts, employees: mappings.accounts.employeeCount!, country: 'country', city: 'city', description: 'description', linkedinUrl: 'linkedin_company_page' },
  contact: { ...mappings.contacts, linkedinUrl: mappings.contacts.linkedin! },
  deal: { ...mappings.deals, pipelineId: 'pipeline', currency: 'deal_currency_code', description: 'description' },
  task: { subject: 'hs_task_subject', description: 'hs_task_body', status: 'hs_task_status', priority: 'hs_task_priority', dueDate: 'hs_timestamp' },
  note: { body: 'hs_note_body' }, meeting: { title: 'hs_meeting_title', startAt: 'hs_meeting_start_time', endAt: 'hs_meeting_end_time', notes: 'hs_meeting_body', location: 'hs_meeting_location' },
  call: { subject: 'hs_call_title', notes: 'hs_call_body', durationSeconds: 'hs_call_duration', callAt: 'hs_timestamp' }, product: { name: 'name', description: 'description', sku: 'hs_sku', unitPrice: 'price' },
};
export const invalid = (message: string, property?: string): never => { throw new V1Error('invalid_request', message, property ? { errors: [{ field: property, message }] } : undefined); };
export type Property = { name: string; canon: string; kind: string; required: boolean; readOnly: boolean; label: string; options: readonly { value: string; label: string }[]; unique: boolean; calculated: boolean };
export type ObjectDef = { canon: string; properties: Property[]; def: DescribedObject };
export function schema(def: DescribedObject): ObjectDef {
  const system: Record<string, string> = { id: 'hs_object_id', createdAt: 'createdate', updatedAt: def.apiName === 'contact' ? 'lastmodifieddate' : 'hs_lastmodifieddate', ownerId: 'hubspot_owner_id' };
  const properties = def.fields.filter(f => f.apiName !== 'deletedAt').map(f => ({ canon: f.apiName, name: system[f.apiName] ?? aliases[def.apiName]?.[f.apiName] ?? `canon_${Buffer.from(f.apiName).toString('hex')}`, kind: f.type === 'formula' ? f.returns : f.type, label: f.label, required: !!f.required, readOnly: !!f.system || f.type === 'formula' || def.readOnlyFields.includes(f.apiName), calculated: f.type === 'formula', options: 'options' in f ? f.options : [], unique: 'unique' in f && f.unique === true }));
  for (const [canon, name, kind] of [['id', 'hs_object_id', 'text'], ['createdAt', 'createdate', 'datetime'], ['updatedAt', system.updatedAt!, 'datetime']] as const) if (!properties.some(p => p.canon === canon)) properties.push({ canon, name, kind, label: name, required: false, readOnly: true, calculated: false, options: [], unique: canon === 'id' });
  if (def.apiName === 'contact' && properties.some(p => p.canon === 'fullName')) for (const name of ['firstname', 'lastname']) properties.push({ ...properties.find(p => p.canon === 'fullName')!, name, canon: `$${name}`, required: false });
  if (def.apiName === 'deal' && properties.some(p => p.canon === 'stage')) properties.push({ canon: 'pipelineId', name: 'pipeline', kind: 'text', label: 'Pipeline', required: false, readOnly: false, calculated: false, options: [], unique: false });
  if (new Set(properties.map(p => p.name)).size !== properties.length) throw new Error('Property name collision');
  return { canon: def.apiName, properties, def };
}
export const property = (o: ObjectDef, name: string): Property => o.properties.find(p => p.name === name) ?? invalid(`Unknown property ${name}`, name);
export function decode(p: Property, value: unknown): string | number | boolean | null | string[] {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return invalid('Expected a scalar property value', p.name);
  const s = String(value);
  if (p.kind === 'currency' || p.kind === 'number') { const n = Number(s); if (!Number.isFinite(n) || !s.trim()) return invalid('Expected a number', p.name); return p.kind === 'currency' ? Math.round(n * 100) : p.name === 'hs_call_duration' ? n / 1000 : n; }
  if (p.kind === 'datetime') { const n = /^\d+$/.test(s) ? Number(s) : Date.parse(s); if (!Number.isFinite(n)) return invalid('Expected an ISO datetime or epoch milliseconds', p.name); return n; }
  if (p.kind === 'checkbox') { if (!['true', 'false'].includes(s)) return invalid('Expected true or false', p.name); return s === 'true'; }
  if (['multipicklist', 'emails', 'phones', 'links'].includes(p.kind)) return s.split(';');
  return s;
}
export function value(r: ApiRecord, p: Property): string {
  const parts = String(r.values.fullName ?? '').split(' ');
  const v = p.canon === '$firstname' ? parts.slice(0, -1).join(' ') : p.canon === '$lastname' ? parts.at(-1) : p.canon === 'id' ? r.id : p.canon === 'createdAt' ? r.createdAt : p.canon === 'updatedAt' ? r.updatedAt : r.values[p.canon];
  if (v === null || v === undefined) return '';
  if (p.canon === 'pipelineId' && !v) return 'default';
  return p.kind === 'datetime' ? new Date(Number(v)).toISOString() : p.kind === 'currency' ? String(Number(v) / 100) : p.name === 'hs_call_duration' ? String(Number(v) * 1000) : Array.isArray(v) ? v.join(';') : String(v);
}
export function describe(p: Property) {
  return { name: p.name, label: p.label, type: p.kind === 'datetime' || p.kind === 'date' ? p.kind : p.kind === 'checkbox' ? 'bool' : ['number', 'currency'].includes(p.kind) ? 'number' : p.options.length ? 'enumeration' : 'string', fieldType: p.kind === 'checkbox' ? 'booleancheckbox' : p.options.length ? 'select' : 'text', options: p.options, hasUniqueValue: p.unique, modificationMetadata: { readOnlyValue: p.readOnly }, calculated: p.calculated, hubspotDefined: !p.name.startsWith('canon_') };
}
