import { z } from 'zod';
import { decode, invalid, property, type ObjectDef } from './_schema.ts';
const Filter = z.object({ propertyName: z.string(), operator: z.string(), value: z.string().optional(), highValue: z.string().optional(), values: z.array(z.string()).optional() }).strict();
export const Search = z.object({ filterGroups: z.array(z.object({ filters: z.array(Filter) }).strict()).default([]), sorts: z.array(z.string()).max(1).default([]), properties: z.array(z.string()).optional(), limit: z.number().int().min(1).max(200).default(10), after: z.union([z.string(), z.number().int().nonnegative()]).optional(), query: z.string().optional() }).strict();
export function searchParams(o: ObjectDef, raw: unknown) {
  const parsed = Search.safeParse(raw); if (!parsed.success) return invalid('Invalid search body');
  const b = parsed.data;
  if (b.query !== undefined) invalid('Text query is not supported; use filterGroups');
  const params = new URLSearchParams({ limit: String(b.limit) });
  if (b.after !== undefined) params.set('cursor', String(b.after));
  let filters = b.filterGroups[0]?.filters ?? [];
  if (b.filterGroups.length > 1) {
    const all = b.filterGroups.flatMap(g => g.filters);
    if (!b.filterGroups.every(g => g.filters.length === 1) || !all.every(f => f.propertyName === all[0]!.propertyName && ['EQ', 'IN'].includes(f.operator))) invalid('OR groups must reduce to IN on one property');
    filters = [{ propertyName: all[0]!.propertyName, operator: 'IN', values: all.flatMap(f => f.operator === 'EQ' ? [f.value ?? invalid('EQ requires value')] : f.values ?? invalid('IN requires values')) }];
  }
  for (const f of filters) {
    const p = property(o, f.propertyName);
    if (p.canon.startsWith('$')) invalid('Derived name properties cannot be filtered', p.name);
    const scalar = (s: string | undefined) => { if (s === undefined) return invalid('Filter requires value', p.name); const v = decode(p, s); if (v === null || Array.isArray(v)) return invalid('Unsupported filter value', p.name); return String(v); };
    const add = (op: string, v = '') => params.append('filter', `${p.canon}:${op}:${v}`);
    const ops: Record<string, string> = { EQ: 'eq', NEQ: 'neq', LT: 'lt', LTE: 'lte', GT: 'gt', GTE: 'gte', CONTAINS_TOKEN: 'contains' };
    if (ops[f.operator]) add(ops[f.operator]!, scalar(f.value));
    else if (f.operator === 'BETWEEN') { add('gte', scalar(f.value)); add('lte', scalar(f.highValue)); }
    else if (f.operator === 'HAS_PROPERTY' || f.operator === 'NOT_HAS_PROPERTY') add(f.operator === 'HAS_PROPERTY' ? 'notEmpty' : 'empty');
    else if (f.operator === 'IN' || f.operator === 'NOT_IN') {
      if (!f.values?.length || f.values.some(v => v.includes(','))) invalid('IN values must be nonempty and contain no commas', p.name);
      const values = f.values!.map(scalar);
      if (f.operator === 'IN') add('in', values.join(',')); else values.forEach(v => add('neq', v));
    } else invalid(`Unsupported operator ${f.operator}`, p.name);
  }
  if (b.sorts.length) { const s = b.sorts[0]!; const p = property(o, s.replace(/^-/, '')); if (p.canon.startsWith('$')) invalid('Cannot sort a derived property', p.name); params.set('sort', `${p.canon}:${s.startsWith('-') ? 'desc' : 'asc'}`); }
  return { params, properties: b.properties };
}
