import { ConvexError } from "convex/values";
import type { Doc } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { systemScope, type ModuleScope } from "../modules/scope";
import { installedModule, manifestOf } from "../modules/packages";
import { valueProblems } from "../../../modules/kernel/schema.ts";
import { AGENTS_MODULE, DEFINITION_VIEW, DEFINITION_CREATE, DEFINITION_UPDATE, DEFINITION_FIELDS, eventDefinitionSchema, legacyDefinition, type EventDefinition } from "./definitionModel";

async function definitionScope(ctx: QueryCtx | MutationCtx, agent: Doc<"agents">): Promise<ModuleScope | null> {
  const scope = await systemScope(ctx, agent.orgId, AGENTS_MODULE, true);
  return scope?.manifest.collections.agents && scope.manifest.views[DEFINITION_VIEW] ? scope : null;
}

export async function eventDefinition(ctx: QueryCtx | MutationCtx, agent: Doc<"agents">): Promise<EventDefinition | null> {
  const scope = await definitionScope(ctx, agent);
  const doc = scope ? await scope.view(DEFINITION_VIEW, { agentId: agent._id }) : null;
  if (!doc) return legacyDefinition(agent);
  if (Array.isArray(doc) || valueProblems(doc.data, eventDefinitionSchema, "Agent definition", () => false).length) {
    throw new ConvexError("The installed agent definition has an unsupported shape.");
  }
  return doc.data as EventDefinition;
}

export async function withEventDefinition(ctx: QueryCtx | MutationCtx, agent: Doc<"agents">): Promise<Doc<"agents">> {
  const definition = await eventDefinition(ctx, agent);
  return definition ? { ...agent, route: undefined, crmTrigger: undefined, slack: undefined, ...definition } : agent;
}

export async function writeEventDefinition(ctx: MutationCtx, agent: Doc<"agents">, patch: Partial<EventDefinition>): Promise<void> {
  const current = await eventDefinition(ctx, agent);
  if (!current) throw new ConvexError("Agent not found");
  const next = { ...current, ...patch };
  const data = Object.fromEntries(DEFINITION_FIELDS.filter((key) => next[key] !== undefined).map((key) => [key, next[key]]));
  const problems = valueProblems(data, eventDefinitionSchema, "Agent definition", () => false);
  if (problems.length) throw new ConvexError(problems.join(" "));
  const scope = await definitionScope(ctx, agent);
  if (!scope) {
    const installed = await installedModule(ctx, agent.orgId, AGENTS_MODULE);
    if (installed && manifestOf(installed).collections.agents) {
      throw new ConvexError("Agents is finishing its upgrade. Try this change again when it finishes.");
    }
  }
  if (scope) {
    if (scope.migrating) throw new ConvexError("Agents is upgrading. Try this change again when it finishes.");
    const existing = await scope.peek("agents", agent._id);
    const op = existing ? DEFINITION_UPDATE : DEFINITION_CREATE;
    if (!scope.manifest.ops[op]?.system) throw new ConvexError("The installed Agents module cannot save definitions.");
    await scope.op(op, {
      key: agent._id, data, ...(existing ? { expect: existing.version, unset: DEFINITION_FIELDS.filter((key) => next[key] === undefined) } : {}),
    });
  }
  await ctx.db.patch(agent._id, {
    ...next, route: next.route, crmTrigger: next.crmTrigger, slack: next.slack, updatedAt: Date.now(),
  });
}
