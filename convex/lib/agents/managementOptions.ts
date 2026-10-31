import { ConvexError } from "convex/values";
import type { Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { agentClientOf, withRole } from "../../lib";
import { agentOwnerCandidates, agentStandingView } from "../../agents";
import { canSee } from "../../audiences";
import { roleIn } from "../../permissions";
import type { Access } from "../access";
import { can } from "../capabilities";
import { withEventDefinition } from "./definitions";
import { signingKey } from "./grantRead";
import { isOwnerCaused } from "./standing";

export const AGENT_OPTION_FIELDS = ["fields", "owners", "audiences", "slack", "permissions", "grantSigningReady"] as const;
export type AgentOptionField = typeof AGENT_OPTION_FIELDS[number];

export async function agentManagementOptions(ctx: QueryCtx, orgId: Id<"organizations">, access: Access, rawAgent?: string) {
  const viewerId = access.userId === "system" ? null : ctx.db.normalizeId("users", access.userId);
  const row = viewerId ? await ctx.db.get(viewerId) : null;
  if (!row || await roleIn(ctx, row, orgId) === null) return null;
  const viewer = await withRole(ctx, { ...row, orgId, role: access.role });
  if (!viewer) return null;
  const agentId = rawAgent ? ctx.db.normalizeId("agents", rawAgent) : null;
  const principal = agentId ? await ctx.db.get(agentId) : null;
  const agent = principal?.orgId === orgId ? await withEventDefinition(ctx, principal) : null;
  if (rawAgent && (!agent?.fieldSlugs || agent.archivedAt !== undefined)) return null;
  const admin = can(viewer, "agents.manageAll");
  const manage = !!agent && (admin || viewer._id === agent.ownerUserId);
  const writesAllowed = !access.preview && !(await agentClientOf(ctx));
  const standing = agent ? await agentStandingView(ctx, orgId, agent, agent.ownerUserId) : null;
  const owner = agent ? await ctx.db.get(agent.ownerUserId) : null;
  const fields = await ctx.db.query("researchAgents").withIndex("by_orgId_and_slug", (q) => q.eq("orgId", orgId)).take(501);
  if (fields.length > 500) throw new ConvexError("There are too many AI fields for one complete management read.");
  const audiences = await ctx.db.query("audiences").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).take(1001);
  if (audiences.length > 1000) throw new ConvexError("There are too many audiences for one complete management read.");
  const slack = await ctx.db.query("integrations").withIndex("by_orgId_provider", (q) => q.eq("orgId", orgId).eq("provider", "slack")).first();
  return {
    id: agent?._id ?? "options", createdAt: 0,
    fields: fields.filter((field) => field.entityType === "account").map((field) => ({
      slug: field.slug, label: field.label, question: field.question,
      choices: field.options?.map((option) => option.key) ?? (field.answerType === "boolean" ? ["true", "false"] : []),
      choiceOptions: field.options?.map((option) => ({ value: option.key, label: option.label })) ?? (field.answerType === "boolean" ? [{ value: "true", label: "Yes" }, { value: "false", label: "No" }] : []),
      selected: agent?.fieldSlugs?.includes(field.slug) ?? false,
    })),
    owners: await agentOwnerCandidates(ctx, viewer),
    audiences: audiences.filter((audience) => canSee(viewer, audience) && (!agent || !!owner && canSee(owner, audience)))
      .map((audience) => ({ id: audience._id, name: audience.name })).sort((a, b) => a.name.localeCompare(b.name)),
    slack: { connected: Boolean(slack?.isActive), connectedAt: slack?.connectedAt ?? null },
    grantSigningReady: await signingKey() !== null,
    permissions: {
      canRotateSecret: !!process.env.TOKEN_ENCRYPTION_KEY,
      writesAllowed, canCreate: can(viewer, "agents.run"), canManage: manage, canReassign: admin,
      canManageGrants: can(viewer, "grants.manage"),
      canPause: manage && !agent?.pause,
      canResume: manage && !!agent?.pause && (!isOwnerCaused(agent.pause.reason) || admin && !!standing?.ownerEligible),
      paused: !!agent?.pause, ownerEligible: standing?.ownerEligible ?? false,
    },
  };
}

export async function agentOptionsRead(ctx: QueryCtx, orgId: Id<"organizations">, access: Access, granted: readonly string[], args: Record<string, unknown>, limit: number) {
  if (args.agent !== undefined && typeof args.agent !== "string") throw new ConvexError("Agent options need an agent id.");
  const options = await agentManagementOptions(ctx, orgId, access, typeof args.agent === "string" ? args.agent : undefined);
  if (!options) return [];
  if (limit < 1) throw new ConvexError("Agent options need a read limit of at least one.");
  return [{ id: options.id, createdAt: options.createdAt, ...Object.fromEntries(AGENT_OPTION_FIELDS.filter((field) => granted.includes(field)).map((field) => [field, options[field]])) }];
}
