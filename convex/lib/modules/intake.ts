import { ConvexError } from 'convex/values';
import type { MutationCtx, QueryCtx } from '../../_generated/server';
import { isDevAuthBypassEnabled, requireUser } from '../../lib';
import { accessFor, principalAccess, roleIn } from '../../permissions';
import { requireWritable, saveAsCaller } from '../../objects';
import { installedModule, isEnabled } from './packages';
import { systemScope } from './scope';
import { formProblems, normalizeSubmission, type InboundForm } from '../../../modules/kernel/inboundForms.ts';
import type { InboundMatch } from '../objects/inboundMatch.ts';
const MODULE = '@canon/inbound';
export const formsEnabled = () => process.env.INBOUND_FORMS === 'on' || isDevAuthBypassEnabled();
const dead = () => new ConvexError('Form not found');
export async function publishForm(ctx: MutationCtx, args: { formKey: string }) {
  const user = await requireUser(ctx);
  if (await roleIn(ctx, user, user.orgId) !== 'admin') throw dead();
  const pkg = await installedModule(ctx, user.orgId, MODULE);
  if (!pkg || pkg.source.kind !== 'canon' || pkg.source.id !== 'inbound' || !(await isEnabled(ctx, user.orgId, MODULE))) throw dead();
  const scope = await systemScope(ctx, user.orgId, MODULE), form = await scope?.peek('forms', args.formKey);
  if (!form || form.data.status !== 'draft' || formProblems(form.data).length) throw new ConvexError('Check the form fields, email mapping, daily cap and redirect before publishing.');
  await requireWritable(ctx, user, await accessFor(ctx, user), 'lead', 'create');
  const existing = await ctx.db.query('moduleFormLinks').withIndex('by_orgId_moduleId_formKey', q => q.eq('orgId', user.orgId).eq('moduleId', MODULE).eq('formKey', args.formKey)).unique();
  if (existing) throw new ConvexError('This form has already been published.');
  const publicId = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await ctx.db.insert('moduleFormLinks', { orgId: user.orgId, moduleId: MODULE, formKey: args.formKey, publicId, createdBy: user._id, createdAt: Date.now() });
  return { publicId };
}
export async function resolveForm(ctx: QueryCtx | MutationCtx, publicId: string) {
  if (!formsEnabled() || !/^[A-Za-z0-9_-]{22}$/.test(publicId)) return null;
  const link = await ctx.db.query('moduleFormLinks').withIndex('by_publicId', q => q.eq('publicId', publicId)).unique();
  if (!link || link.moduleId !== MODULE) return null;
  const pkg = await installedModule(ctx, link.orgId, MODULE);
  if (!pkg || pkg.source.kind !== 'canon' || pkg.source.id !== 'inbound' || pkg.pending || !(await isEnabled(ctx, link.orgId, MODULE))) return null;
  const scope = await systemScope(ctx, link.orgId, MODULE), form = await scope?.peek('forms', link.formKey);
  if (!scope || !form || form.data.status !== 'live' || form.data.publicId !== publicId || form.data.publishedBy !== link.createdBy || formProblems(form.data).length) return null;
  const publisher = await ctx.db.get(link.createdBy);
  if (!publisher || await roleIn(ctx, publisher, link.orgId) !== 'admin') return null;
  const user = { ...publisher, orgId: link.orgId, role: 'admin' };
  const accesses = await principalAccess(ctx, link.orgId, [publisher._id]);
  if (!accesses) return null;
  try { await requireWritable(ctx as MutationCtx, user, accesses[0], 'lead', 'create'); } catch { return null; }
  return { link, scope, form, user, config: form.data as unknown as InboundForm };
}
export async function formProjection(ctx: QueryCtx, publicId: string) {
  const found = await resolveForm(ctx, publicId);
  if (!found) return null;
  const { name, fields, hiddenParams } = found.config;
  return { name, fields, hiddenParams: hiddenParams ?? [] };
}
export type SubmitInput = { publicId: string; nonce: string; ipHash: string; userAgent: string; answers: Record<string, unknown>; params: Record<string, unknown> };
export async function admit(ctx: MutationCtx, args: SubmitInput) {
  const f = await resolveForm(ctx, args.publicId);
  if (!f) return { status: 404 as const };
  const normalized = normalizeSubmission(f.config, args.answers, args.params);
  const now = Date.now(), base = `form:${f.link.orgId}:${args.publicId}`;
  const replay = await ctx.db.query('moduleRateLimits').withIndex('by_key', q => q.eq('key', `${base}:nonce:${args.nonce}`)).unique();
  if (replay) return { status: 200 as const };
  for (const [key, ms, cap] of [[`${base}:ip:${args.ipHash}`,60000,10],[`${base}:hour`,3600000,600],[`${base}:day`,86400000,f.config.dailyCap ?? 500],[`form:${f.link.orgId}:day`,86400000,5000]] as const) {
    const row = await ctx.db.query('moduleRateLimits').withIndex('by_key', q => q.eq('key', key)).unique();
    const start = Math.floor(now / ms) * ms;
    if (row && row.windowStart === start && row.count >= cap) return { status: 429 as const };
  }
  for (const [key, ms] of [[`${base}:ip:${args.ipHash}`,60000],[`${base}:hour`,3600000],[`${base}:day`,86400000],[`form:${f.link.orgId}:day`,86400000]] as const) {
    const row = await ctx.db.query('moduleRateLimits').withIndex('by_key', q => q.eq('key', key)).unique(), start = Math.floor(now / ms) * ms;
    const next = { key, windowStart: start, count: row?.windowStart === start ? row.count + 1 : 1, expiresAt: start + ms };
    if (row) await ctx.db.patch(row._id, next); else await ctx.db.insert('moduleRateLimits', next);
  }
  return { status: 202 as const, orgId: f.link.orgId, version: f.form.version, email: normalized.values.email, companyName: normalized.values.company ?? '' };
}
export async function commit(ctx: MutationCtx, args: SubmitInput, version: number, match: InboundMatch | null) {
  const f = await resolveForm(ctx, args.publicId);
  if (!f || f.form.version !== version) return { status: 404 };
  const base = `form:${f.link.orgId}:${args.publicId}:nonce:${args.nonce}`;
  if (await ctx.db.query('moduleRateLimits').withIndex('by_key', q => q.eq('key', base)).unique()) return { status: 200 };
  const n = normalizeSubmission(f.config, args.answers, args.params);
  await ctx.db.insert('moduleRateLimits', { key: base, count: 1, windowStart: Date.now(), expiresAt: Date.now() + 2 * 86400000 });
  let outcome = match?.by === 'ambiguous' ? 'needs_review' : 'received';
  let leadId = match && 'leadId' in match ? match.leadId : undefined;
  const personId = match && 'personId' in match ? match.personId : undefined;
  if (!leadId && !personId && outcome !== 'needs_review') {
    const saved = await saveAsCaller(ctx, f.user, 'lead', { op: 'create', values: n.values }, { intake: { formKey: f.link.formKey } });
    if (saved.status === 'applied' || saved.status === 'unchanged') leadId = saved.streamId;
    else outcome = 'failed';
  }
  await f.scope.op('submissions.receive', { data: { formKey: f.link.formKey, answers: JSON.stringify(n.answers), utm: JSON.stringify(n.utm), hidden: JSON.stringify(n.hidden), outcome, receivedAt: Date.now(), ipHash: args.ipHash, userAgent: args.userAgent.slice(0,400), ...(leadId ? { leadId } : {}), ...(personId ? { personId } : {}), ...(match && 'companyId' in match && match.companyId ? { companyId: match.companyId } : {}), ...(match && 'accountOwner' in match && match.accountOwner ? { accountOwner: match.accountOwner } : {}), ...(!match ? { matchUnavailable: true } : {}) } });
  return { status: 200, message: f.config.message || 'Thank you. Your submission was received.', ...(f.config.redirect ? { redirect: f.config.redirect } : {}) };
}
