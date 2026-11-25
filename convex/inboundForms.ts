import { v } from 'convex/values';
import { action, query, internalMutation } from './_generated/server';
import { internal } from './_generated/api';
import { requireAuthBroker } from './cliAuth';
import { clientFor } from './records';
import { admit as admitForm, commit as commitForm, formProjection } from './lib/modules/intake';
import type { InboundMatch } from './lib/objects/inboundMatch';
const submitArgs = { publicId: v.string(), nonce: v.string(), ipHash: v.string(), userAgent: v.string(), answers: v.record(v.string(),v.any()), params: v.record(v.string(),v.any()) };
export const publicForm = query({ args: { publicId: v.string() }, handler: async (ctx, args) => {
  await requireAuthBroker(ctx);
  return formProjection(ctx, args.publicId);
} });
export const admit = internalMutation({ args: submitArgs, handler: admitForm });
export const commit = internalMutation({ args: { ...submitArgs, version: v.number(), match: v.any() }, handler: (ctx, args) => commitForm(ctx, args, args.version, args.match as InboundMatch | null) });
export const submit = action({ args: submitArgs, handler: async (ctx, args): Promise<{ status: number; message?: string; redirect?: string }> => {
  await requireAuthBroker(ctx);
  const allowed = await ctx.runMutation(internal.inboundForms.admit, args);
  if (allowed.status !== 202) return { status: allowed.status };
  let match: InboundMatch | null = null;
  try { match = await clientFor(ctx).matchInbound(allowed.orgId, { email: allowed.email, companyName: allowed.companyName }); } catch { /* Matching outages still admit leads. */ }
  return ctx.runMutation(internal.inboundForms.commit, { ...args, version: allowed.version, match });
} });
