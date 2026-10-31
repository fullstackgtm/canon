import { ConvexError, v } from "convex/values";
import { action, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { moduleScope } from "./lib/modules/scope";
import { callerClient, requireCaller } from "./records";
import type { Id } from "./_generated/dataModel";
import { renderVariables, variableFields } from "./lib/sequences/variables";
import { signVariableReview, type SequenceVariablePlan, type SequencePreflight } from "./lib/sequences/preflight";

export const plan = internalQuery({
  args: { module: v.string(), key: v.string() },
  handler: async (ctx, a): Promise<SequenceVariablePlan> => {
    const scope = await moduleScope(ctx, a.module);
    if (!scope) throw new ConvexError("Sequence unavailable.");
    return scope.sequenceVariables(a.key);
  },
});
const check = { contactId: v.string(), fullName: v.string(), address: v.string(), emailStatus: v.string(), companyId: v.string(), companyName: v.string(), companyDomain: v.string(), companyOwnerId: v.optional(v.string()) };
export const saveChecks = internalMutation({
  args: { orgId: v.id("organizations"), sequenceKey: v.string(), checks: v.array(v.object(check)) },
  handler: async (ctx, a) => {
    for (const check of a.checks) {
      const previous = await ctx.db.query("sequenceRecipientChecks").withIndex("by_orgId_and_sequenceKey_and_contactId", (q) => q.eq("orgId", a.orgId).eq("sequenceKey", a.sequenceKey).eq("contactId", check.contactId)).unique();
      const value = { ...check, orgId: a.orgId, sequenceKey: a.sequenceKey, checkedAt: Date.now() };
      if (previous) await ctx.db.replace(previous._id, value); else await ctx.db.insert("sequenceRecipientChecks", value);
    }
  },
});
export const review = action({
  args: { module: v.string(), key: v.string() },
  handler: async (ctx, a): Promise<SequencePreflight> => {
    const caller = await requireCaller(ctx, { read: true });
    const plan: SequenceVariablePlan = await ctx.runQuery(internal.sequenceVariables.plan, a);
    if (plan.orgId !== caller.orgId || plan.userId !== caller.userId) throw new ConvexError("Sequence reader changed.");
    const client = callerClient(ctx, caller), fields = [...new Set(plan.templates.flatMap(variableFields))];
    const samples: SequencePreflight["samples"] = [], failures: SequencePreflight["failures"] = [], checks = [];
    for (const recipient of plan.recipients) {
      const contact = await client.getContact(caller.orgId, recipient.contactId);
      if (!contact) { failures.push({ ...recipient, problems: ["Required Canon recipient fields are unavailable or not visible."] }); continue; }
      const company = fields.some((f) => f.startsWith("company.")) || fields.includes("to.firstName") && !contact.fullName?.trim() ? await client.get(caller.orgId, contact.accountId) : null;
      const values = { "to.name": contact.fullName, "to.firstName": contact.fullName?.trim().split(/\s+/)[0] ?? "", "to.email": contact.email ?? "", "company.name": company?.account.name ?? "", "company.domain": company?.account.domain ?? "" };
      const messages = plan.templates.flatMap((t) => (plan.senders.length ? plan.senders : [{ name: "", address: "" }]).map((s) => ({ step: t.step, variant: t.variant,
        ...renderVariables(t, { ...values, "sender.name": s.name, "sender.address": s.address }, contact.emailStatus, plan.usesEmail) })));
      const problems = [...new Set(messages.flatMap((m) => m.problems))];
      if (plan.usesEmail && !plan.templates.length) problems.push(...renderVariables({ subject: "", body: "" }, values, contact.emailStatus).problems);
      if (samples.length < 5) samples.push({ key: recipient.key, name: recipient.name, messages });
      if (problems.length) failures.push({ key: recipient.key, version: recipient.version, name: recipient.name, problems });
      checks.push({ contactId: contact.id, fullName: contact.fullName ?? "", address: (contact.email ?? "").trim().toLowerCase(), emailStatus: contact.emailStatus ?? "not_checked", companyId: contact.accountId, companyName: company?.account.name ?? "", companyDomain: company?.account.domain ?? "", ...(company?.account.ownerId ? { companyOwnerId: company.account.ownerId } : {}) });
    }
    await ctx.runMutation(internal.sequenceVariables.saveChecks, { orgId: caller.orgId as Id<"organizations">, sequenceKey: plan.sequenceKey, checks });
    return { recipients: plan.recipients.length, samples, failures, ready: !failures.length, token: failures.length ? null : await signVariableReview(plan) };
  },
});
