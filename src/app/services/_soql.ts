import { fail, field, type SfObject, type SfField } from './_schema.ts';

export type Query = { object: SfObject; fields: string[]; params: URLSearchParams; count: boolean; limit?: number; offset: number };
const malformed = (message = 'Unsupported or malformed SOQL') => fail('MALFORMED_QUERY', message);
type Token = { value: string; quoted: boolean; escapedWildcard?: boolean };
function tokens(q: string): Token[] {
  const out: Token[] = [];
  const re = /\s+|'(?:\\.|[^'\\])*'|>=|<=|!=|[=<>(),.]|[A-Za-z_][A-Za-z_0-9]*(?::\d+)?|\d{4}-\d\d-\d\d(?:T[\d:.]+(?:Z|[+-]\d\d:\d\d))?|-?\d+(?:\.\d+)?/gy;
  let at = 0;
  while (at < q.length) {
    re.lastIndex = at;
    const m = re.exec(q);
    if (!m) malformed(`Unexpected SOQL at position ${at}`);
    at = re.lastIndex;
    const v = m![0];
    if (!v.trim()) continue;
    out.push({ escapedWildcard: /\\[%_]/.test(v), value: v.startsWith("'") ? v.slice(1, -1).replace(/\\(.)/g, (_, ch: string) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[ch] ?? ch)) : v, quoted: v.startsWith("'") });
  }
  if (out.length > 3000) malformed('Query too large');
  return out;
}
function dateRange(value: string, now: Date): [string, string] | null {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(day);
  const v = value.toUpperCase();
  if (v === 'TODAY') end.setUTCDate(end.getUTCDate() + 1);
  else if (v === 'YESTERDAY') day.setUTCDate(day.getUTCDate() - 1);
  else if (v === 'TOMORROW') { day.setUTCDate(day.getUTCDate() + 1); end.setUTCDate(end.getUTCDate() + 2); }
  else if (/^(LAST|NEXT)_N_DAYS:\d+$/.test(v)) {
    const n = Number(v.split(':')[1]);
    if (n > 36500) malformed('Date range too large');
    if (v.startsWith('LAST')) { day.setUTCDate(day.getUTCDate() - n); end.setUTCDate(end.getUTCDate() + 1); }
    else { day.setUTCDate(day.getUTCDate() + 1); end.setUTCDate(end.getUTCDate() + n + 1); }
  } else if (/^(THIS|LAST|NEXT)_(MONTH|YEAR)$/.test(v)) {
    const delta = v.startsWith('LAST') ? -1 : v.startsWith('NEXT') ? 1 : 0;
    day.setUTCDate(1);
    if (v.endsWith('YEAR')) { day.setUTCMonth(0); day.setUTCFullYear(day.getUTCFullYear() + delta); end.setTime(day.getTime()); end.setUTCFullYear(end.getUTCFullYear() + 1); }
    else { day.setUTCMonth(day.getUTCMonth() + delta); end.setTime(day.getTime()); end.setUTCMonth(end.getUTCMonth() + 1); }
  } else return null;
  return [day.toISOString(), end.toISOString()];
}
export function parse(q: string, objects: SfObject[], now = new Date()): Query {
  if (q.length > 16000) malformed('Query too large');
  const ts = tokens(q);
  let i = 0;
  const peek = (s: string) => !ts[i]?.quoted && ts[i]?.value.toUpperCase() === s;
  const take = () => ts[i++] ?? malformed('Unexpected end of query');
  const expect = (s: string) => { if (!peek(s)) malformed(`Expected ${s}`); i++; };
  const identifier = () => { const t = take(); if (t.quoted || !/^[A-Za-z_][A-Za-z_0-9]*$/.test(t.value)) malformed('Expected identifier'); return t.value; };
  const path = () => { let p = identifier(); if (peek('.')) { i++; p += `.${identifier()}`; } return p; };
  expect('SELECT');
  const count = peek('COUNT');
  const fields: string[] = [];
  if (count) { i++; expect('('); expect(')'); }
  else { fields.push(path()); while (peek(',')) { i++; fields.push(path()); } }
  expect('FROM');
  const name = identifier();
  const obj = objects.find(o => o.name.toLowerCase() === name.toLowerCase()) ?? fail('INVALID_TYPE', `Unknown sObject ${name}`);
  const validatePath = (p: string) => {
    const parts = p.split('.');
    if (parts.length === 1) return field(obj, p);
    const ref = obj.fields.find(f => f.relationshipName?.toLowerCase() === parts[0]!.toLowerCase());
    const parent = objects.find(o => ref?.referenceTo?.includes(o.name));
    if (!ref || !parent) fail('INVALID_FIELD', `Unknown relationship ${parts[0]}`);
    return field(parent!, parts[1]!);
  };
  fields.forEach(validatePath);
  const params = new URLSearchParams();
  const add = (f: SfField, op: string, val?: string) => params.append('filter', `${f.canon}:${op}${val === undefined ? '' : `:${val}`}`);
  const scalar = (f: SfField, t: Token): string => {
    if (f.type === 'percent') { const n = Number(t.value); if (!Number.isFinite(n)) malformed(); return String(n / 100); }
    if (t.quoted) {
      if (f.type === 'currency') { const n = Number(t.value); if (!Number.isFinite(n)) malformed(); return String(Math.round(n * 100)); }
      return t.value;
    }
    if (/^(true|false)$/i.test(t.value) || /^-?\d+(\.\d+)?$/.test(t.value) || /^\d{4}-/.test(t.value)) return f.type === 'currency' ? String(Math.round(Number(t.value) * 100)) : t.value.toLowerCase();
    return malformed('Expected a literal value');
  };
  const condition = (): { f: SfField; op: string; values: string[] } => {
    const f = field(obj, identifier());
    if (f.canon.startsWith('$') || f.canon === 'deletedAt' || (obj.canon === 'contact' && f.canon === 'accountId')) malformed(`${f.name} cannot be filtered through Canon's list API`);
    let op = take().value.toUpperCase();
    if (op === 'NOT') { expect('IN'); op = 'NOT IN'; }
    if (op === 'IN' || op === 'NOT IN') {
      expect('('); const vals = [scalar(f, take())];
      while (peek(',')) { i++; vals.push(scalar(f, take())); }
      expect(')');
      return { f, op, values: vals };
    }
    if (!['=', '!=', '<', '<=', '>', '>=', 'LIKE'].includes(op)) malformed('Unsupported comparison');
    const t = take();
    if (op === 'LIKE' && t.escapedWildcard) malformed('Escaped LIKE wildcards are unsupported');
    if (!t.quoted && t.value.toUpperCase() === 'NULL') return { f, op: op === '=' ? 'empty' : op === '!=' ? 'notEmpty' : malformed(), values: [] };
    const range = !t.quoted ? dateRange(t.value, now) : null;
    if (range) {
      if (!['date', 'datetime'].includes(f.type)) malformed('Date literal requires a date field');
      const [start, end] = range.map(d => f.type === 'date' ? d.slice(0, 10) : d);
      if (op === '=') { add(f, 'gte', start); add(f, 'lt', end); }
      else if (op === '>=') add(f, 'gte', start);
      else if (op === '>') add(f, 'gte', end);
      else if (op === '<') add(f, 'lt', start);
      else if (op === '<=') add(f, 'lt', end);
      else malformed('This date comparison needs OR');
      return { f, op: 'range', values: [] };
    }
    return { f, op, values: [scalar(f, t)] };
  };
  const emit = ({ f, op, values }: ReturnType<typeof condition>) => {
    if (op === 'range') return;
    if (op === 'NOT IN') { values.forEach(v => add(f, 'neq', v)); return; }
    if (op === 'IN') { if (values.some(v => v.includes(','))) malformed('IN values containing commas are unsupported'); add(f, 'in', values.join(',')); return; }
    if (op === 'LIKE') {
      const v = values[0]!;
      if (v.includes('_') || v.replace(/^%|%$/g, '').includes('%')) malformed('LIKE supports literal, prefix% or %contains%');
      if (v.startsWith('%') && v.endsWith('%')) add(f, 'contains', v.slice(1, -1));
      else if (v.endsWith('%')) add(f, 'startsWith', v.slice(0, -1));
      else if (!v.includes('%')) add(f, 'eq', v);
      else malformed('Suffix LIKE is unsupported');
      return;
    }
    const ops: Record<string, string> = { '=': 'eq', '!=': 'neq', '<': 'lt', '<=': 'lte', '>': 'gt', '>=': 'gte', empty: 'empty', notEmpty: 'notEmpty' };
    add(f, ops[op] ?? malformed(), values[0]);
  };
  if (peek('WHERE')) {
    i++;
    let terms = 0;
    do {
      const grouped = peek('('); if (grouped) i++;
      const c = condition();
      if (peek('OR')) {
        if (!grouped && terms > 0) malformed('Parenthesize OR when combined with AND');
        if (c.op !== '=') malformed('OR requires equalities on one field');
        while (peek('OR')) { i++; const other = condition(); if (other.f !== c.f || other.op !== '=') malformed('OR requires equalities on one field'); c.values.push(...other.values); }
        c.op = 'IN';
        if (!grouped && peek('AND')) malformed('Parenthesize OR when combined with AND');
      }
      if (grouped) expect(')');
      emit(c); terms++;
      if (!peek('AND')) break;
      i++;
    } while (true);
  }
  if (peek('ORDER')) { i++; expect('BY'); const f = field(obj, identifier()); let dir = 'asc'; if (peek('ASC') || peek('DESC')) dir = take().value.toLowerCase(); params.set('sort', `${f.canon}:${dir}`); }
  const integer = () => { const t = take(); if (t.quoted || !/^\d+$/.test(t.value) || !Number.isSafeInteger(Number(t.value))) malformed('Expected positive integer'); return Number(t.value); };
  let limit: number | undefined;
  if (peek('LIMIT')) { i++; limit = integer(); }
  let offset = 0;
  if (peek('OFFSET')) { i++; offset = integer(); if (offset > 2000) malformed('OFFSET exceeds 2000'); }
  if (i !== ts.length) malformed();
  return { object: obj, fields, params, count, limit, offset };
}
