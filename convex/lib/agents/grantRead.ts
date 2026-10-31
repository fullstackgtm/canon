import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { derivedSecret } from "../operatorConfig";
import { grantState, grantStateLabel, usageSince, type StoredGrant } from "./grants";
import type { AgentReadBudget } from "./readBudget";

type ReadCtx = Pick<QueryCtx, "db">;
export const MAX_GRANTS = 50;
export const signingKey = () => derivedSecret("agent-grant");

export function termsOf(g: Doc<"agentGrants">): StoredGrant {
  return {
    grantId: g._id, orgId: g.orgId, agentId: g.agentId, operation: g.operation, entityType: g.entityType, attribute: g.attribute,
    ...(g.allowedValues ? { allowedValues: g.allowedValues } : {}), ...(g.maxPerDay !== undefined ? { maxPerDay: g.maxPerDay } : {}),
    expiresAt: g.expiresAt, createdBy: g.createdBy, createdAt: g.createdAt, signature: g.signature,
    ...(g.revokedAt !== undefined ? { revokedAt: g.revokedAt } : {}),
  };
}

const MAX_APPROVALS = 1000;
const approvalsSince = (ctx: ReadCtx, grantId: Id<"agentGrants">, now: number) => ctx.db.query("agentGrantApprovals").withIndex("by_grantId_and_at", (q) => q.eq("grantId", grantId).gt("at", usageSince(now)));
const approvalTotal = (rows: readonly Doc<"agentGrantApprovals">[]) => rows.reduce((n, r) => n + r.factCount, 0);

export async function usedToday(ctx: ReadCtx, grantId: Id<"agentGrants">, now: number): Promise<number> {
  return approvalTotal(await approvalsSince(ctx, grantId, now).take(MAX_APPROVALS));
}

async function completeUsage(ctx: ReadCtx, grantId: Id<"agentGrants">, now: number, budget: AgentReadBudget) {
  return approvalTotal(await budget.complete(approvalsSince(ctx, grantId, now), MAX_APPROVALS, "This grant's recent usage exceeds one display read. Its usage total cannot be shown completely."));
}

export async function grantViews(ctx: ReadCtx, agent: Doc<"agents">, now: number, budget: AgentReadBudget) {
  const rows = await budget.complete(ctx.db.query("agentGrants").withIndex("by_agentId", (q) => q.eq("agentId", agent._id)).order("desc"), MAX_GRANTS, `An agent's grants exceed the ${MAX_GRANTS}-grant display limit.`);
  return shapeGrants(ctx, agent, now, rows, (id) => completeUsage(ctx, id, now, budget));
}

export async function latestGrantViews(ctx: ReadCtx, agent: Doc<"agents">, now: number) {
  const rows = await ctx.db.query("agentGrants").withIndex("by_agentId", (q) => q.eq("agentId", agent._id)).order("desc").take(MAX_GRANTS);
  return shapeGrants(ctx, agent, now, rows, (id) => usedToday(ctx, id, now));
}

async function shapeGrants(ctx: ReadCtx, agent: Doc<"agents">, now: number, rows: Doc<"agentGrants">[], usage: (id: Id<"agentGrants">) => Promise<number>) {
  const key = await signingKey();
  const grants = [];
  for (const g of rows) {
    if (g.orgId !== agent.orgId) continue;
    const state = await grantState(termsOf(g), key, now);
    const field = await ctx.db.query("researchAgents").withIndex("by_orgId_and_slug", (q) => q.eq("orgId", g.orgId).eq("slug", g.attribute.slice("custom.".length))).unique();
    const creator = await ctx.db.get(g.createdBy);
    grants.push({
      id: g._id, fieldLabel: field?.label ?? g.attribute, entityType: g.entityType, allowedValues: g.allowedValues ?? null,
      maxPerDay: g.maxPerDay ?? null, expiresAt: g.expiresAt, createdAt: g.createdAt, createdBy: creator?.name ?? null,
      revokedAt: g.revokedAt ?? null, state, stateLabel: grantStateLabel[state],
      usedToday: await usage(g._id),
    });
  }
  return { grants, signingReady: key !== null };
}
