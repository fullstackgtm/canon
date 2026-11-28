/**
 * Signal watches (docs/signal-automations.md, S1). A watch is two things Canon already runs:
 *
 * - an account AI field asking a yes-or-no question, refreshed weekly on its owner's ChatGPT plan; and
 * - an automation rule that, when an accepted answer turns yes, gives the account's owner a task.
 *
 * The rule installs paused, like a recipe's template: only a person resumes it (automations.setStatus). An unchanged
 * answer adds no fact, so the rule fires once per change, not once per refresh.
 */
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getCurrentUser } from "./lib";
import { can, refusal } from "./lib/capabilities";
import { attributeFor } from "./lib/research/agentLoop";
import { insertField } from "./researchAgents";
import { insertRule, requireAdmin } from "./automations";
import { SIGNAL_PREFIX, SIGNAL_TEMPLATES, signalFieldLabel, signalTemplate } from "./lib/signals/catalog";

const QUESTION_MAX = 500;

/** The starter signals, each with whether the workspace already watches it. */
export const catalog = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const fields = await ctx.db.query("researchAgents").withIndex("by_orgId_and_slug", (q) => q.eq("orgId", user.orgId)).take(200);
    const watched = new Map(fields.filter((f) => f.label.startsWith(SIGNAL_PREFIX)).map((f) => [f.label, f]));
    return {
      templates: SIGNAL_TEMPLATES.map((t) => {
        const field = watched.get(signalFieldLabel(t.label));
        return { ...t, watching: field ? { slug: field.slug, attribute: attributeFor(field.slug), refresh: field.refreshCadence ?? null } : null };
      }),
      custom: [...watched.values()].filter((f) => !SIGNAL_TEMPLATES.some((t) => signalFieldLabel(t.label) === f.label))
        .map((f) => ({ label: f.label.slice(SIGNAL_PREFIX.length), question: f.question, slug: f.slug, attribute: attributeFor(f.slug), refresh: f.refreshCadence ?? null })),
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

    const field = await insertField(ctx, user, {
      label: fieldLabel, kind: "qa", answerType: "boolean", judgment: true, entityType: "account", refresh: "weekly",
      question: `${question} Answer yes only with a dated source from the period asked about.`,
    });
    const attribute = attributeFor(field.slug);
    const task = (args.task ?? template?.task ?? `Signal: ${label}`).trim().slice(0, 200);
    const ruleId = await insertRule(ctx, user, {
      name: `${fieldLabel}: task the owner`, object: "account",
      trigger: { kind: "updated", field: attribute, to: [true] }, conditions: [],
      actions: [{ kind: "create_task", subject: task, dueInDays: 2, owner: { kind: "record_owner" } }],
    }, { paused: "A new signal waits until you resume it" });
    return {
      slug: field.slug, attribute, ruleId,
      next: `Run "${fieldLabel}" on the accounts to watch (AI fields, or canon_ai_fields "run" with slug ${field.slug}); it then re-asks weekly. Resume its rule on the Automations page to start the tasks.`,
    };
  },
});
