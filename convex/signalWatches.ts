/**
 * Signal watches (docs/signal-automations.md, S1). A watch is two things Canon already runs:
 *
 * - an account AI field asking a yes-or-no question, refreshed weekly on its owner's ChatGPT plan; and
 * - an automation rule that, when an accepted answer turns yes, gives the account's owner a task.
 *
 * With a `filter`, the field keeps that scope: every weekly refresh asks the accounts it matches, new ones included.
 * The rule installs paused, like a recipe's template: only a person resumes it (automations.setStatus). An unchanged
 * answer adds no fact, so the rule fires once per change, not once per refresh.
 */
import { ConvexError, v } from "convex/values";
import { mutation, query, type MutationCtx } from "./_generated/server";
import { getCurrentUser } from "./lib";
import { can, refusal } from "./lib/capabilities";
import { attributeFor } from "./lib/research/agentLoop";
import { insertField } from "./researchAgents";
import { insertRule, requireAdmin } from "./automations";
import { filterValidator } from "./lib/scopeValidators";
import { SIGNAL_PREFIX, SIGNAL_TEMPLATES, signalFieldLabel, signalTemplate, suggestedSignals } from "./lib/signals/catalog";
import { markOnboardingStep } from "./onboarding";
import type { Doc, Id } from "./_generated/dataModel";

const QUESTION_MAX = 500;

/** The starter signals (three suggested by the workspace's starting plan), and for each watch its scope and rule. */
export const catalog = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const fields = await ctx.db.query("researchAgents").withIndex("by_orgId_and_slug", (q) => q.eq("orgId", user.orgId)).take(200);
    const watched = new Map(fields.filter((f) => f.label.startsWith(SIGNAL_PREFIX)).map((f) => [f.label, f]));
    const rules = watched.size ? await ctx.db.query("automationRules").withIndex("by_orgId_and_status", (q) => q.eq("orgId", user.orgId)).take(200) : [];
    const view = (f: Doc<"researchAgents">) => {
      const attribute = attributeFor(f.slug);
      const rule = rules.find((r) => r.trigger.kind === "updated" && r.trigger.field === attribute);
      return { slug: f.slug, attribute, refresh: f.refreshCadence ?? null, scope: f.watchFilter ?? null, ruleId: rule?._id ?? null };
    };
    const suggested = suggestedSignals((await ctx.db.get(user.orgId))?.startingPlan?.archetypes ?? []);
    return {
      templates: SIGNAL_TEMPLATES.map((t) => {
        const field = watched.get(signalFieldLabel(t.label));
        return { ...t, suggested: suggested.includes(t.key), watching: field ? view(field) : null };
      }),
      custom: [...watched.values()].filter((f) => !SIGNAL_TEMPLATES.some((t) => signalFieldLabel(t.label) === f.label))
        .map((f) => ({ label: f.label.slice(SIGNAL_PREFIX.length), question: f.question, ...view(f) })),
      canInstall: can(user, "strategy.edit") && can(user, "automations.manage"),
    };
  },
});

/**
 * Watch a signal: a starter (`key`) or your own yes-or-no question (`label` + `question`). Makes the weekly AI field
 * and the paused rule. It answers nothing yet: run the field on the accounts to watch (canon_ai_fields "run"), and
 * resume the rule on the Automations page.
 */
export const watch = mutation({
  args: {
    key: v.optional(v.string()),
    label: v.optional(v.string()),
    question: v.optional(v.string()),
    task: v.optional(v.string()),
    /** The accounts to watch, as the Accounts list filters them (an ICP's members: { icpId }). Asked from the next due check, then weekly. */
    filter: v.optional(filterValidator),
  },
  handler: async (ctx, args) => {
    const user = await requireAdmin(ctx);
    if (!can(user, "strategy.edit")) throw new ConvexError(refusal("strategy.edit"));
    const template = args.key ? signalTemplate(args.key) : undefined;
    if (args.key && !template) throw new ConvexError(`No starter signal "${args.key}". The starters: ${SIGNAL_TEMPLATES.map((t) => t.key).join(", ")}.`);
    const label = (template?.label ?? args.label ?? "").trim();
    const question = (template?.question ?? args.question ?? "").trim();
    if (!label || !question) throw new ConvexError("Name the signal and write its yes-or-no question, or pick a starter by key.");
    if (question.length > QUESTION_MAX) throw new ConvexError(`A signal's question is at most ${QUESTION_MAX} characters.`);
    const fieldLabel = signalFieldLabel(label);
    const taken = await ctx.db.query("researchAgents").withIndex("by_orgId_and_slug", (q) => q.eq("orgId", user.orgId)).take(200);
    if (taken.some((f) => f.label === fieldLabel)) throw new ConvexError(`The workspace already watches "${label}".`);

    const fromJobs = template?.source === "job_boards";
    const field = await insertField(ctx, user, {
      label: fieldLabel, kind: "qa", answerType: "boolean", judgment: !fromJobs, entityType: "account", refresh: "weekly",
      ...(args.filter ? { watchFilter: args.filter } : {}),
      question: `${question} Answer yes only with a dated source from the period asked about.`,
    });
    if (fromJobs) {
      await ctx.db.patch(field._id, { answerSource: "job_boards" });
      await ensureJobCheck(ctx, user.orgId);
    }
    const attribute = attributeFor(field.slug);
    const task = (args.task ?? template?.task ?? `Signal: ${label}`).trim().slice(0, 200);
    const ruleId = await insertRule(ctx, user, {
      name: `${fieldLabel}: task the owner`, object: "account",
      trigger: { kind: "updated", field: attribute, to: [true] }, conditions: [],
      actions: [{ kind: "create_task", subject: task, dueInDays: 2, owner: { kind: "record_owner" } }],
    }, { paused: "A new signal waits until you resume it" });
    await markOnboardingStep(ctx, user.orgId, "watch_signals");
    return {
      slug: field.slug, attribute, ruleId,
      next: args.filter
        ? `"${fieldLabel}" starts on its accounts within the hour, then asks them and any new ones weekly on the field owner's ChatGPT plan. Resume its rule on the Automations page to start the tasks.`
        : `Run "${fieldLabel}" on the accounts to watch (AI fields, or canon_ai_fields "run" with slug ${field.slug}); it then re-asks weekly. Resume its rule on the Automations page to start the tasks.`,
    };
  },
});

/** Turn on the daily job-board check (convex/signals.ts) a job-board watch answers from; the next cron tick starts it. */
async function ensureJobCheck(ctx: MutationCtx, orgId: Id<"organizations">) {
  const check = await ctx.db.query("signalWatch").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).first();
  if (!check) await ctx.db.insert("signalWatch", { orgId, nextRunAt: Date.now() });
  else if (check.nextRunAt === undefined) await ctx.db.patch(check._id, { nextRunAt: Date.now() });
}

/** Give a watch (or any account AI field) a lasting scope, or clear it with null. A new scope is asked from the next due check. */
export const setScope = mutation({
  args: { slug: v.string(), filter: v.union(filterValidator, v.null()) },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user || !can(user, "strategy.edit")) throw new ConvexError(refusal("strategy.edit"));
    const field = await ctx.db.query("researchAgents").withIndex("by_orgId_and_slug", (q) => q.eq("orgId", user.orgId).eq("slug", args.slug)).unique();
    if (!field) throw new ConvexError(`No AI field "${args.slug}".`);
    if (field.entityType !== "account") throw new ConvexError("Only an account field can watch a list of accounts.");
    if (!args.filter) return void (await ctx.db.patch(field._id, { watchFilter: undefined, watchCursor: undefined, updatedAt: Date.now() }));
    await ctx.db.patch(field._id, { watchFilter: args.filter, watchCursor: undefined, refreshCadence: field.refreshCadence ?? "weekly", refreshNextAt: Date.now(), updatedAt: Date.now() });
  },
});
