export const LEAD_TARGETS = ['email', 'firstName', 'lastName', 'company', 'title', 'phone'] as const;
export type FormField = { key: string; label: string; kind: 'text' | 'email' | 'phone' | 'textarea' | 'select' | 'checkbox'; required?: boolean; mapsTo?: string; options?: string[] };
export type InboundForm = { name: string; fields: FormField[]; hiddenParams?: string[]; redirect?: string; message?: string; leadSource?: string; dailyCap?: number };
const keyPattern = /^[a-z][a-z0-9_]{0,39}$/;
const controls = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
const clean = (v: string, max: number) => v.replace(controls, '').slice(0, max);
export function formProblems(raw: unknown): string[] {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object') return ['Form is required'];
  const f = raw as InboundForm;
  if (typeof f.name !== 'string' || !f.name.trim() || f.name.length > 200) errors.push('Name is required (200 characters at most)');
  if (!Array.isArray(f.fields) || f.fields.length < 1 || f.fields.length > 25) return [...errors, 'Use 1 to 25 fields'];
  const keys = new Set<string>(), targets = new Set<string>();
  let emails = 0;
  for (const field of f.fields) {
    if (!field || typeof field !== 'object') { errors.push('Invalid field'); continue; }
    if (!keyPattern.test(field.key) || field.key === 'website' || keys.has(field.key)) errors.push('Field keys must be unique lowercase identifiers');
    keys.add(field.key);
    if (typeof field.label !== 'string' || !field.label.trim() || field.label.length > 200 || !['text', 'email', 'phone', 'textarea', 'select', 'checkbox'].includes(field.kind)) errors.push('Invalid field label or kind');
    if (field.mapsTo) {
      if (!(LEAD_TARGETS as readonly string[]).includes(field.mapsTo) || targets.has(field.mapsTo) || field.kind === 'checkbox') errors.push('Invalid or repeated lead mapping');
      targets.add(field.mapsTo);
      if (field.mapsTo === 'email' && field.kind === 'email' && field.required) emails++;
    }
    if (field.kind === 'select' && (!Array.isArray(field.options) || !field.options.length || field.options.length > 50 || field.options.some(o => typeof o !== 'string' || !o || o.length > 200))) errors.push('Select needs 1 to 50 bounded options');
  }
  if (emails !== 1) errors.push('Map exactly one required email field to email');
  if (f.hiddenParams !== undefined && (!Array.isArray(f.hiddenParams) || f.hiddenParams.length > 10 || f.hiddenParams.some(k => !keyPattern.test(k)) || new Set(f.hiddenParams).size !== f.hiddenParams.length)) errors.push('Use at most 10 distinct hidden parameter keys');
  if (f.dailyCap !== undefined && (!Number.isInteger(f.dailyCap) || f.dailyCap < 1 || f.dailyCap > 10000)) errors.push('Daily cap must be 1 to 10000');
  if (f.redirect) {
    try { const u = new URL(f.redirect); if (u.protocol !== 'https:' || u.username || u.password || /[\u0000-\u0020\u007f]/.test(f.redirect) || f.redirect.length > 2000) errors.push('Redirect must be a safe HTTPS URL'); } catch { errors.push('Invalid redirect'); }
  }
  return errors;
}
export function normalizeSubmission(form: InboundForm, raw: Record<string, unknown>, params: Record<string, unknown>) {
  if (formProblems(form).length) throw new Error('Invalid form');
  const answers: Record<string, string> = {}, values: Record<string, string> = {}, utm: Record<string, string> = {}, hidden: Record<string, string> = {};
  for (const field of form.fields) {
    const input = raw[field.key];
    const value = field.kind === 'checkbox' ? (input === true || input === 'true' ? 'true' : '') : typeof input === 'string' ? clean(input, field.kind === 'textarea' ? 2000 : 200).trim() : '';
    if (field.required && !value) throw new Error('Required field missing');
    if (value && field.kind === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error('Invalid email');
    if (value && field.kind === 'select' && !field.options!.includes(value)) throw new Error('Invalid option');
    answers[field.key] = value;
    if (field.mapsTo) values[field.mapsTo] = value;
  }
  for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']) if (typeof params[k] === 'string') utm[k] = clean(params[k], 200);
  for (const k of form.hiddenParams ?? []) if (typeof params[k] === 'string') hidden[k] = clean(params[k], 200);
  values.email = values.email.toLowerCase();
  values.lastName ||= values.email;
  values.status = 'new'; values.leadSource = clean(form.leadSource || `Form: ${form.name}`, 200);
  return { answers, values, utm, hidden };
}
