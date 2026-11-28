import { z } from 'zod';
import { ConvexError } from 'convex/values';
import type { MutationCtx, QueryCtx } from '../../_generated/server';
import { isDevAuthBypassEnabled, requireUser, agentClientOf } from '../../lib';
import { accessFor, principalAccess, roleIn, roleBasesOf } from '../../permissions';
import { requireWritable, saveAsCaller, view, recordVisibleTo } from '../../objects';
import { installedModule, isEnabled, manifestOf } from './packages';
import { systemScope } from './scope';
import { formProblems, normalizeSubmission, leadValuesFrom, type InboundForm } from '../../../modules/kernel/inboundForms.ts';
import { canSeeRecord, may, narrowsReads } from '../access';
import { baseRole } from '../roles';
import type { Id } from '../../_generated/dataModel';
import type { MatchCandidate, InboundMatch } from '../objects/inboundMatch.ts';
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
function supportsIntake(pkg: Parameters<typeof manifestOf>[0]): boolean {
  const m = manifestOf(pkg);
  const accepts = (name: string, fields: readonly string[]) => fields.every(field => m.ops[name]?.fields?.includes(field));
  return m.collections.submissions?.owner === 'assignee'
    && accepts('submissions.receive', ['assignee', 'candidates', 'accountOwner'])
    && accepts('submissions.resolve', ['outcome', 'leadId', 'personId', 'companyId', 'assignee', 'resolvedBy', 'resolvedAt']);
}
export async function resolveForm(ctx: QueryCtx | MutationCtx, publicId: string) {
  if (!formsEnabled() || !/^[A-Za-z0-9_-]{22}$/.test(publicId)) return null;
  const link = await ctx.db.query('moduleFormLinks').withIndex('by_publicId', q => q.eq('publicId', publicId)).unique();
  if (!link || link.moduleId !== MODULE) return null;
  const pkg = await installedModule(ctx, link.orgId, MODULE);
  if (!pkg || pkg.source.kind !== 'canon' || pkg.source.id !== 'inbound' || pkg.pending || !supportsIntake(pkg) || !(await isEnabled(ctx, link.orgId, MODULE))) return null;
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
const RECENT_MS = 10 * 60000;
/**
 * The row saying a submission with this email created a lead here in the last ten minutes. Matching reads the record
 * service before this transaction, so two submissions a moment apart both see no lead; this row is read and written in
 * the transaction, so only the first creates one. The key holds a digest, not the address.
 */
async function recentLead(ctx: MutationCtx, orgId: string, email: string) {
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email))), b => b.toString(16).padStart(2, '0')).join('');
  const key = `form:${orgId}:email:${digest}`, now = Date.now();
  const row = await ctx.db.query('moduleRateLimits').withIndex('by_key', q => q.eq('key', key)).unique();
  const next = { key, count: 1, windowStart: now, expiresAt: now + RECENT_MS };
  return { created: !!row && row.expiresAt > now, mark: () => (row ? ctx.db.patch(row._id, next) : ctx.db.insert('moduleRateLimits', next)) };
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
  let assignee: string | undefined;
  const personId = match && 'personId' in match ? match.personId : undefined;
  if (leadId || personId) assignee = await linkedAssignee(ctx, f.link.orgId, leadId, personId, match && 'personOwner' in match ? match.personOwner : undefined, match && 'accountOwner' in match ? match.accountOwner : undefined);
  if (!leadId && !personId && outcome !== 'needs_review') {
    const recent = await recentLead(ctx, f.link.orgId, n.values.email);
    if (recent.created) outcome = 'duplicate';
    else {
      const owner = f.config.routeToAccountOwner && match && 'accountOwner' in match ? await leadOwner(ctx, f.link.orgId, match.accountOwner) : undefined;
      const saved = await saveAsCaller(ctx, f.user, 'lead', { op: 'create', values: { ...n.values, ...(owner ? { ownerId: owner } : {}) } }, { intake: { formKey: f.link.formKey } });
      if (saved.status === 'applied' || saved.status === 'unchanged') { leadId = saved.streamId; assignee = owner; await recent.mark(); }
      else outcome = 'failed';
    }
  }
  await f.scope.op('submissions.receive', { data: { formKey: f.link.formKey, answers: JSON.stringify(n.answers), utm: JSON.stringify(n.utm), hidden: JSON.stringify(n.hidden), outcome, ...(assignee ? { assignee } : {}), ...(match?.by === 'ambiguous' ? { candidates: match.candidates.slice(0,50).map(c => ({ object: c.object, id: c.id, reason: c.reason, ...(c.ownerId ? { ownerId: c.ownerId } : {}), url: `/dashboard/${c.object === 'company' ? 'accounts' : c.object === 'person' ? 'records/contact' : 'records/lead'}/${encodeURIComponent(c.id)}` })) } : {}), receivedAt: Date.now(), ipHash: args.ipHash, userAgent: args.userAgent.slice(0,400), ...(leadId ? { leadId } : {}), ...(personId ? { personId } : {}), ...(match && 'companyId' in match && match.companyId ? { companyId: match.companyId } : {}), ...(match && 'accountOwner' in match && match.accountOwner ? { accountOwner: match.accountOwner } : {}), ...(!match ? { matchUnavailable: true } : {}) } });
  return { status: 200, message: f.config.message || 'Thank you. Your submission was received.', ...(f.config.redirect ? { redirect: f.config.redirect } : {}) };
}

async function activePrincipal(ctx: QueryCtx, orgId: Id<'organizations'>, raw?: string) {
  if (!raw) return null;
  const id = ctx.db.normalizeId('users', raw), user = id ? await ctx.db.get(id) : null;
  const access = user?.isActive && !user.isHidden ? (await principalAccess(ctx, orgId, [raw]))?.[0] : null;
  return user && access ? { user: { ...user, orgId }, access } : null;
}
async function leadOwner(ctx: MutationCtx, orgId: Id<'organizations'>, raw?: string) {
  const principal = await activePrincipal(ctx, orgId, raw);
  if (!principal || !canSeeRecord(principal.access, 'lead', true, raw!) || !may(principal.access, 'lead', 'edit')) return undefined;
  try { await requireWritable(ctx, principal.user, principal.access, 'lead', 'edit', undefined, { ownerId: raw }); } catch { return undefined; }
  return raw;
}
async function linkedAssignee(ctx: MutationCtx, orgId: Id<'organizations'>, leadId?: string, personId?: string, personOwner?: string | null, accountOwner?: string) {
  if (leadId) {
    const id = ctx.db.normalizeId('canonEntities', leadId);
    const row = id ? await view(ctx, orgId, id, 4000, new Map()) : null;
    if (!row || row.object !== 'lead') return undefined;
    const raw = typeof row.values.ownerId === 'string' ? row.values.ownerId : accountOwner;
    const principal = await activePrincipal(ctx, orgId, raw);
    return principal && await recordVisibleTo(ctx, principal.access, orgId, id!) ? raw : undefined;
  }
  if (!personId) return undefined;
  const raw = personOwner || accountOwner, principal = await activePrincipal(ctx, orgId, raw);
  if (!principal || personOwner === undefined && narrowsReads(principal.access)) return undefined;
  return canSeeRecord(principal.access, 'contact', true, personOwner ?? null) ? raw : undefined;
}
export const resolveSubmissionInput = z.strictObject({ key: z.string().min(1).max(200), expect: z.number().int().positive(), action: z.enum(['link', 'create', 'dismiss']), candidateId: z.string().min(1).max(200).optional() });
export type ResolutionOwners = {
  candidate: { id: string; found: boolean; ownerId: string | null };
  company?: { id: string; found: boolean; ownerId: string | null };
};
export async function admitResolution(ctx: QueryCtx, args: z.infer<typeof resolveSubmissionInput>) {
  const user = await requireUser(ctx), role = await roleIn(ctx, user, user.orgId);
  if (await agentClientOf(ctx) || !role || !['admin','manager'].includes(baseRole(role, await roleBasesOf(ctx, user.orgId)))) throw new ConvexError('Only an admin or manager may resolve submissions.');
  const pkg = await installedModule(ctx, user.orgId, MODULE);
  if (!pkg || pkg.source.kind !== 'canon' || pkg.source.id !== 'inbound' || pkg.pending || !(await isEnabled(ctx, user.orgId, MODULE))) throw dead();
  if (!supportsIntake(pkg)) throw new ConvexError('Update Inbound on the Recipes page before resolving submissions.');
  const scope = await systemScope(ctx, user.orgId, MODULE), submission = await scope?.peek('submissions', args.key);
  if (!submission) throw new ConvexError('Submission not found');
  if (submission.version !== args.expect || submission.data.outcome !== 'needs_review') throw new ConvexError('Already resolved');
  const access = (await principalAccess(ctx, user.orgId, [user._id]))?.[0];
  if (!access) throw dead();
  const candidates = (submission.data.candidates ?? []) as MatchCandidate[];
  const candidate = args.candidateId ? candidates.slice(0,50).find(c => c.id === args.candidateId) : undefined;
  if (args.candidateId && !candidate || args.action === 'link' && (!candidate || candidate.object === 'company') || args.action === 'create' && candidate && candidate.object !== 'company') throw new ConvexError('Choose a stored candidate for this action.');
  return { user, role, scope, submission, access, candidate };
}
export async function resolveSubmission(ctx: MutationCtx, args: z.infer<typeof resolveSubmissionInput>, owners?: ResolutionOwners) {
  const { user, role, scope, submission, access, candidate } = await admitResolution(ctx, args);
  if (owners && owners.candidate.id !== args.candidateId) throw new ConvexError('Unexpected Canon preparation.');
  let candidateOwner: string | null | undefined;
  let accountOwner = typeof submission.data.accountOwner === 'string' ? submission.data.accountOwner : undefined;
  if (candidate && args.action !== 'dismiss') {
    if (candidate.object === 'lead') {
      const id = ctx.db.normalizeId('canonEntities', candidate.id);
      const lead = id ? await view(ctx, user.orgId, id, 4000, new Map()) : null;
      if (!lead || lead.object !== 'lead' || lead.lifecycle.status !== 'active' || lead.values.convertedAt != null) throw new ConvexError('That lead is no longer available. Choose another candidate or create a lead.');
      if (!id || !await recordVisibleTo(ctx, access, user.orgId, id)) throw new ConvexError('Your role cannot resolve to that record.');
    } else {
      if (!owners) throw new ConvexError('Submission resolution needs private Canon preparation.');
      if (!owners.candidate.found) throw new ConvexError('That record no longer exists. Choose another candidate.');
      candidateOwner = owners.candidate.ownerId;
      if (!canSeeRecord(access, candidate.object === 'person' ? 'contact' : 'account', true, candidateOwner)) throw new ConvexError('Your role cannot resolve to that record.');
      if (candidate.object === 'person' && typeof submission.data.companyId === 'string') {
        if (owners.company?.id !== submission.data.companyId) throw new ConvexError('Unexpected Canon preparation.');
        accountOwner = owners.company.found ? owners.company.ownerId ?? undefined : undefined;
      }
    }
  }
  const data: Record<string,unknown> = { outcome: 'dismissed', resolvedBy: user._id, resolvedAt: Date.now() };
  if (args.action === 'link') {
    const c = candidate!;
    data.outcome = 'linked'; data[c.object === 'lead' ? 'leadId' : 'personId'] = c.id;
    const assignee = await linkedAssignee(ctx, user.orgId, c.object === 'lead' ? c.id : undefined, c.object === 'person' ? c.id : undefined, candidateOwner, accountOwner);
    if (assignee) data.assignee = assignee;
  } else if (args.action === 'create') {
    await requireWritable(ctx, user, access, 'lead', 'create');
    const form = await scope!.peek('forms', String(submission.data.formKey));
    if (!form || !['live','archived'].includes(String(form.data.status)) || formProblems(form.data).length) throw new ConvexError('The published form mapping is unavailable.');
    const config = form.data as unknown as InboundForm;
    const owner = config.routeToAccountOwner ? await leadOwner(ctx, user.orgId, candidateOwner ?? undefined) : undefined;
    const values = leadValuesFrom(config, JSON.parse(String(submission.data.answers)));
    const assignedValues = { ...values, ...(owner ? { ownerId: owner } : {}) };
    await requireWritable(ctx, user, access, 'lead', 'create', undefined, assignedValues);
    const saved = await saveAsCaller(ctx, { ...user, role }, 'lead', { op: 'create', values: assignedValues }, { intake: { formKey: String(submission.data.formKey) } });
    if (saved.status !== 'applied' && saved.status !== 'unchanged') throw new ConvexError('Lead could not be created.');
    data.outcome = 'received'; data.leadId = saved.streamId;
    if (candidate) data.companyId = candidate.id;
    if (owner) data.assignee = owner;
  }
  return scope!.op('submissions.resolve', { key: args.key, expect: args.expect, data });
}

/** Anonymous intake can otherwise create an unbounded stream of notices to a workspace member. */
export async function boundedInboundRecipients(ctx: MutationCtx, orgId: Id<'organizations'>, formKey: string, review: boolean, recipients: readonly string[]) {
  const allowed: string[] = [], now = Date.now(), hour = 3600000, windowStart = Math.floor(now / hour) * hour;
  for (const recipient of recipients) {
    const key = review ? `form:${orgId}:notice:review:${formKey}:${recipient}` : `form:${orgId}:notice:assignee:${recipient}`;
    const row = await ctx.db.query('moduleRateLimits').withIndex('by_key', q => q.eq('key',key)).unique();
    const count = row?.windowStart === windowStart ? row.count : 0;
    if (count >= (review ? 1 : 10)) continue;
    const next = { key, windowStart, count: count + 1, expiresAt: windowStart + hour };
    if (row) await ctx.db.patch(row._id,next); else await ctx.db.insert('moduleRateLimits',next);
    allowed.push(recipient);
  }
  return allowed;
}
