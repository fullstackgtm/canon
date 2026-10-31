import { ConvexError, v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { agentClientOf } from "../lib";
import { can, refusal } from "./capabilities";

export const recordingPolicyFields = {
  consent: v.union(v.literal("notice"), v.literal("explicit")),
  noticeText: v.string(),
  internalRecording: v.boolean(),
  internalDomains: v.array(v.string()),
  neverRecordDomains: v.array(v.string()),
  neverRecordEmails: v.array(v.string()),
  retentionDays: v.number(),
  region: v.union(v.literal("us"), v.literal("eu")),
  callRecording: v.boolean(),
};
export const recordingPolicyValidator = v.object(recordingPolicyFields);
export type RecordingPolicy = Infer<typeof recordingPolicyValidator>;

export const DEFAULT_RECORDING_NOTICE = "This meeting is being recorded by Canon for the host's workspace. Tell the host if you do not consent to recording.";

type Workspace = Partial<Doc<"organizations">> & {
  domain?: string;
  region?: RecordingPolicy["region"];
  callRecording?: boolean;
};

/** All recording readers share these defaults, including before the dialer backfill. */
export function policyOf(row: Partial<RecordingPolicy> | null, org: Workspace | null): RecordingPolicy {
  const region = row?.region ?? org?.region ?? "us";
  const domain = org?.domain?.trim().toLowerCase();
  return {
    consent: row?.consent ?? (region === "eu" ? "explicit" : "notice"),
    noticeText: row?.noticeText?.trim() || DEFAULT_RECORDING_NOTICE,
    internalRecording: row?.internalRecording ?? false,
    internalDomains: row?.internalDomains ?? (domain ? [domain] : []),
    neverRecordDomains: row?.neverRecordDomains ?? [],
    neverRecordEmails: row?.neverRecordEmails ?? [],
    retentionDays: row?.retentionDays ?? 365,
    region,
    callRecording: row?.callRecording ?? org?.callRecording ?? true,
  };
}

export async function readPolicy(ctx: QueryCtx, orgId: Id<"organizations">): Promise<RecordingPolicy> {
  const row = await ctx.db.query("recordingPolicy").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).unique();
  const org = await ctx.db.get(orgId);
  const legacy = row ? null : await ctx.db.query("dialerSettings").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).unique();
  return policyOf(row, { ...org, callRecording: legacy?.record });
}

const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
function addresses(values: string[], kind: "domain" | "email"): string[] {
  if (values.length > 200) throw new ConvexError("Use at most 200 entries per list.");
  return [...new Set(values.map((v) => {
    const value = v.trim().toLowerCase();
    const parts = value.split("@");
    const valid = kind === "domain" ? DOMAIN.test(value) : parts.length === 2 && /^[^\s@]+$/.test(parts[0]) && DOMAIN.test(parts[1]);
    if (!valid || value.length > 254) throw new ConvexError(`Enter a valid ${kind}.`);
    return value;
  }))];
}

export async function writePolicy(ctx: MutationCtx, user: Doc<"users">, changes: Partial<RecordingPolicy>) {
  if (!can(user, "recording.manage")) throw new ConvexError(refusal("recording.manage"));
  if (!user.isActive || await agentClientOf(ctx)) throw new ConvexError("Only a signed-in admin changes recording policy.");
  const before = await readPolicy(ctx, user.orgId);
  const next = { ...before, ...changes };
  if (changes.region !== undefined && changes.region !== before.region && changes.consent === undefined) next.consent = next.region === "eu" ? "explicit" : "notice";
  const noticeText = next.noticeText.trim();
  if (!noticeText || noticeText.length > 4000) throw new ConvexError("Recording notice must contain 1 to 4000 characters.");
  if (!Number.isInteger(next.retentionDays) || next.retentionDays < 7 || next.retentionDays > 3650) throw new ConvexError("Retention must be a whole number from 7 to 3650 days.");
  const policy = {
    ...next, noticeText,
    internalDomains: addresses(next.internalDomains, "domain"),
    neverRecordDomains: addresses(next.neverRecordDomains, "domain"),
    neverRecordEmails: addresses(next.neverRecordEmails, "email"),
  };
  const row = await ctx.db.query("recordingPolicy").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).unique();
  const now = Date.now();
  const values = { ...policy, updatedBy: user._id, updatedAt: now };
  if (row) await ctx.db.patch(row._id, values);
  else await ctx.db.insert("recordingPolicy", { orgId: user.orgId, ...values });
  // Keep old readers correct until the migration has run on dev and production.
  const legacy = await ctx.db.query("dialerSettings").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).unique();
  const dialer = { record: policy.callRecording, updatedBy: user._id, updatedAt: now };
  if (legacy) await ctx.db.patch(legacy._id, dialer);
  else await ctx.db.insert("dialerSettings", { orgId: user.orgId, ...dialer });
  await ctx.db.insert("operationAuditLog", {
    orgId: user.orgId, userId: user._id, verb: "do", operation: "recording_policy.save", status: "applied",
    details: { before, after: policy }, createdAt: now,
  });
}
