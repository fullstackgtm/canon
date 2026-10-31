import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { withRole } from "../lib";
import { canSee } from "../audiences";
import { agentStandingView } from "../agents";
import { roleBasesOf, roleIn } from "../permissions";
import { agentPrincipals, seesRunRecords, type Access } from "./access";
import { can } from "./capabilities";
import { grantViews, latestGrantViews } from "./agents/grantRead";
import { agentReadBudget } from "./agents/readBudget";
import { DAY_MS, DEFAULT_BUDGET, WEBHOOK_PATH_PREFIX } from "./agents/webhook";
import type { ModuleManifest } from "../../modules/kernel/manifest.ts";
import { withEventDefinition } from "./agents/definitions";

const TURNS_SHOWN = 25;
const EVENT_AGENTS_MAX = 100;
const EVENT_SCAN_MAX = 1000;
const refuse = (message: string): never => { throw new ConvexError(message); };

export const agentWebhookUrl = (id: Id<"agents">) => `${(process.env.CONVEX_SITE_URL ?? "").replace(/\/$/, "")}${WEBHOOK_PATH_PREFIX}${id}`;

function withoutAccount(payload: string): string {
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    delete parsed.account;
    return JSON.stringify(parsed);
  } catch {
    return "";
  }
}

export async function agentReader(ctx: QueryCtx, orgId: Id<"organizations">, access: Access, mode: "legacy" | "canon") {
  const system = access.userId === "system";
  const id = system ? null : ctx.db.normalizeId("users", access.userId);
  const row = id ? await ctx.db.get(id) : null;
  if (!system && (!row || await roleIn(ctx, row, orgId) === null)) return null;
  const viewer = row ? await withRole(ctx, { ...row, orgId, role: access.role }) : null;
  const canDo = (cap: Parameters<typeof can>[1]) => system || (viewer !== null && can(viewer, cap));
  const manages = (agent: Doc<"agents">) => canDo("agents.manageAll") || viewer?._id === agent.ownerUserId;
  const budget = agentReadBudget();
  const now = Date.now();
  let bases: Promise<Record<string, string>> | undefined;
  const audiences = new Map<string, Promise<Doc<"audiences"> | null>>();
  const audienceOf = (id: Id<"audiences">) => {
    let found = audiences.get(id);
    if (!found) { found = ctx.db.get(id); audiences.set(id, found); }
    return found;
  };
  const seesAudience = (audience: Doc<"audiences"> | null) => audience !== null && audience.orgId === orgId && (system || (viewer !== null && canSee(viewer, audience)));
  const agentOf = async (raw: string) => {
    const id = ctx.db.normalizeId("agents", raw);
    const agent = id ? await ctx.db.get(id) : null;
    return agent?.orgId === orgId ? agent : null;
  };

  return {
    canCreate: canDo("agents.run"),
    async event(selection: { all: true } | { agent: string }, limit: number) {
      const max = Math.min(limit, mode === "legacy" ? 300 : EVENT_AGENTS_MAX);
      const rows = "agent" in selection
        ? [await agentOf(selection.agent)].filter((a): a is Doc<"agents"> => a !== null)
        : mode === "legacy" ? await ctx.db.query("agents").withIndex("by_orgId_and_slug", (q) => q.eq("orgId", orgId)).take(300)
        : await budget.complete(ctx.db.query("agents").withIndex("by_orgId_and_ledgerKey", (q) => q.eq("orgId", orgId).gte("ledgerKey", "agent:").lt("ledgerKey", "agent;")), EVENT_SCAN_MAX, "There are too many event-agent records for one complete display read.");
      const definitions = await Promise.all(rows.map((row) => withEventDefinition(ctx, row)));
      const live = definitions.filter((a) => a.fieldSlugs !== undefined && a.archivedAt === undefined).sort((a, b) => a.slug.localeCompare(b.slug));
      if (live.length > max) refuse(`This read has more than ${max} event agents. Open a single agent.`);
      const out = [];
      for (const a of live) {
        if (a.fieldSlugs!.length > 10) refuse("This agent has more AI fields than one display read supports.");
        const limits = a.budget ?? DEFAULT_BUDGET;
        const fields = [];
        for (const slug of a.fieldSlugs!) {
          const field = await ctx.db.query("researchAgents").withIndex("by_orgId_and_slug", (q) => q.eq("orgId", orgId).eq("slug", slug)).unique();
          fields.push({ slug, label: field?.label ?? slug, missing: !field, choices: field?.options?.map((o) => o.key) ?? (field?.answerType === "boolean" ? ["true", "false"] : []) });
        }
        const recent = ctx.db.query("agentTurns").withIndex("by_agentId_and_admitted_and_createdAt", (q) => q.eq("agentId", a._id).eq("admitted", true).gt("createdAt", now - DAY_MS));
        const today = mode === "legacy" ? await recent.take(limits.turnsPerDay) : await budget.take(recent, limits.turnsPerDay);
        const hook = await ctx.db.query("agentWebhooks").withIndex("by_agentId", (q) => q.eq("agentId", a._id)).unique();
        const routed = a.route ? await audienceOf(a.route.audienceId) : null;
        bases ??= roleBasesOf(ctx, orgId);
        const standing = await agentStandingView(ctx, orgId, a, a.ownerUserId, await bases);
        out.push({
          id: a._id, createdAt: a.createdAt, label: a.label, fields, budget: limits,
          turnsToday: today.filter((t) => t.orgId === orgId).length,
          route: a.route ? { audienceId: a.route.audienceId, audienceName: seesAudience(routed) ? routed!.name : routed ? "a private audience" : null, rule: a.route.rule ?? null } : null,
          crmTrigger: a.crmTrigger ?? null, slack: a.slack ?? null,
          webhook: { url: agentWebhookUrl(a._id), rotatedAt: hook?.rotatedAt ?? null },
          agent: { ref: { agentId: a._id }, ...standing, canManage: manages(a), canReassign: canDo("agents.manageAll") },
          canManage: manages(a),
        });
      }
      return out;
    },
    async turns(raw: string) {
      const agent = await agentOf(raw);
      if (!agent) return [];
      const recent = ctx.db.query("agentTurns").withIndex("by_agentId_and_createdAt", (q) => q.eq("agentId", agent._id)).order("desc");
      const rows = mode === "legacy" ? await recent.take(TURNS_SHOWN) : await budget.take(recent, TURNS_SHOWN);
      const out = [];
      for (const t of rows) {
        if (t.orgId !== orgId) continue;
        if (!seesRunRecords(access, agentPrincipals({ ownerUserId: agent.ownerUserId, startedBy: t.triggeredBy }))) {
          out.push({
            id: t._id, trigger: t.trigger, status: t.status, skip: t.skip ?? null, subject: {}, account: null,
            outputs: [], spend: t.spend, budgetHit: t.budgetHit ?? null, error: null, payload: "", createdAt: t.createdAt,
            waiting: t.status === "queued" && t.dispatchedAt === undefined,
            routing: t.routing ? { ...t.routing, message: "", contactId: undefined } : null, slack: t.slack ?? null,
          });
          continue;
        }
        if (t.outputs.length > 10) refuse("This turn has more answers than one display read supports.");
        const outputs = [];
        for (const output of t.outputs) {
          const fact = output.factId ? await ctx.db.get(output.factId) : null;
          outputs.push({ ...output, factStatus: fact?.orgId === orgId ? fact.status : null });
        }
        const legacy = t.trigger === "crm_event" && !t.account;
        const audience = t.routing?.audienceId ? await audienceOf(t.routing.audienceId) : null;
        out.push({
          id: t._id, trigger: t.trigger, status: t.status, skip: t.skip ?? null, subject: legacy ? {} : t.subject, account: t.account ?? null,
          outputs, spend: t.spend, budgetHit: t.budgetHit ?? null, error: t.error ?? null, payload: legacy ? withoutAccount(t.payload) : t.payload,
          createdAt: t.createdAt, waiting: t.status === "queued" && t.dispatchedAt === undefined,
          routing: t.routing ? seesAudience(audience) ? t.routing : { ...t.routing, message: "", contactId: undefined } : null,
          slack: t.slack ?? null,
        });
      }
      return out;
    },
    async grants(raw: string) {
      const agent = await agentOf(raw);
      if (!agent) return null;
      const view = mode === "legacy" ? await latestGrantViews(ctx, agent, now) : await grantViews(ctx, agent, now, budget);
      return { ...view, canManage: canDo("grants.manage") };
    },
  };
}

type AgentRead = "agents.event" | "agents.turns" | "agents.grants";

export async function agentsRead(ctx: QueryCtx, orgId: Id<"organizations">, access: Access, granted: ModuleManifest["reads"], read: AgentRead, args: Record<string, unknown>, limit: number) {
  if ((read !== "agents.event" || args.agent !== undefined) && typeof args.agent !== "string") refuse(`${read} needs agent, an agent's id.`);
  const reader = await agentReader(ctx, orgId, access, "canon");
  if (!reader) return [];
  let rows: Array<{ id: string; createdAt: number } & Record<string, unknown>>;
  let fields: readonly string[];
  if (read === "agents.event") {
    rows = (await reader.event(typeof args.agent === "string" ? { agent: args.agent } : { all: true }, limit)).map((a) => ({
      ...a, principal: { owner: a.agent.owner, status: a.agent.status, reason: a.agent.reason, message: a.agent.message },
    }));
    fields = granted?.agents ?? [];
  } else if (read === "agents.turns") {
    rows = await reader.turns(args.agent as string);
    fields = granted?.agentTurns ?? [];
  } else {
    rows = (await reader.grants(args.agent as string))?.grants ?? [];
    fields = granted?.agentGrants ?? [];
  }
  if (rows.length > limit) refuse(`${read} has more than ${limit} rows. Raise the read's limit.`);
  return rows.map((row) => ({ id: row.id, createdAt: row.createdAt, ...Object.fromEntries(fields.map((f) => [f, row[f] ?? null])) }));
}
