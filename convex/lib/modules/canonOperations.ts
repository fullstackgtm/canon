import { ConvexError } from "convex/values";
import { z } from "zod";
import type { TableNames } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { agentClientOf, requireUser } from "../../lib";
import { setAgentOwner, setAgentPaused } from "../../agents";
import { createAgentGrant, revokeAgentGrant } from "../../agentGrants";
import {
  archiveEventAgent, createEventAgent, saveEventSecret, setEventCrmTrigger, setEventRouting,
  setEventSlack, testEventAgent,
} from "../../agentTurns";
import { agentWebhookUrl } from "../agentReads";
import type { CanonOperation } from "../../../modules/kernel/canonOperations.ts";
import { startResearchRun, probeResearchRun, stopResearchRun, setResearchAutoAccept, setResearchRefresh } from "../../researchAgents";
import { stopPopulation } from "../populationStop";
import { startFreePopulation } from "../../populateActions";

export type PreparedCanonOperation = { operation: "agents.rotateSecret"; encryptedSecret: string };

const id = <T extends TableNames>(ctx: MutationCtx, table: T) => z.string().transform((raw, issue) => {
  const normalized = ctx.db.normalizeId(table, raw);
  if (normalized) return normalized;
  issue.addIssue({ code: "custom", message: `Invalid ${table} id` });
  return z.NEVER;
});

function operation<T>(schema: (ctx: MutationCtx) => z.ZodType<T>, run: (ctx: MutationCtx, input: T, prepared?: PreparedCanonOperation) => Promise<unknown>) {
  return {
    async execute(ctx: MutationCtx, input: unknown, prepared?: PreparedCanonOperation) {
      const parsed = schema(ctx).safeParse(input);
      if (!parsed.success) throw new ConvexError("Invalid arguments for the Canon operation.");
      return run(ctx, parsed.data, prepared);
    },
  };
}

const principal = (ctx: MutationCtx) => z.union([
  z.strictObject({ agentId: id(ctx, "agents") }),
  z.strictObject({ fieldSlug: z.string() }),
]);

const researchStart = (ctx: MutationCtx) => z.strictObject({
  slug: z.string(),
  filter: z.strictObject({
    segmentId: z.string().optional(), status: z.enum(["new", "working", "qualified", "disqualified"]).optional(),
    ownerId: z.string().optional(), minFit: z.number().optional(), q: z.string().optional(),
    industry: z.array(z.string()).optional(), country: z.array(z.string()).optional(),
    employeeMin: z.number().optional(), employeeMax: z.number().optional(), sizeBand: z.array(z.string()).optional(),
    region: z.array(z.string()).optional(), traits: z.record(z.string(), z.array(z.string())).optional(),
    icpId: z.string().optional(), custom: z.record(z.string(), z.array(z.string())).optional(),
  }).optional(),
  contacts: z.union([
    z.strictObject({ kind: z.literal("all") }),
    z.strictObject({ kind: z.literal("view"), viewId: id(ctx, "savedViews") }),
    z.strictObject({ kind: z.literal("ids"), ids: z.array(z.string()) }),
  ]).optional(),
  capCredits: z.number().optional(),
});

const operations = {
  "research.start": operation(researchStart, startResearchRun),
  "research.probe": operation(researchStart, probeResearchRun),
  "research.stop": operation((ctx) => z.strictObject({ runId: id(ctx, "researchRuns") }), stopResearchRun),
  "research.autoAccept": operation(() => z.strictObject({ slug: z.string(), minConfidence: z.number().nullable() }), setResearchAutoAccept),
  "research.refresh": operation(() => z.strictObject({ slug: z.string(), cadence: z.enum(["weekly", "monthly"]).nullable() }), setResearchRefresh),
  "population.start": operation(() => z.strictObject({ query: z.string().max(10000), title: z.string().min(1).max(120), detail: z.string().max(500).optional() }), startFreePopulation),
  "runs.stopJob": operation((ctx) => z.strictObject({ jobId: id(ctx, "backgroundJobs") }), stopPopulation),
  "agents.create": operation(() => z.strictObject({ label: z.string(), fieldSlugs: z.array(z.string()), turnsPerDay: z.number() }), createEventAgent),
  "agents.archive": operation((ctx) => z.strictObject({ agentId: id(ctx, "agents") }), archiveEventAgent),
  "agents.setRouting": operation((ctx) => z.strictObject({
    agentId: id(ctx, "agents"), audienceId: id(ctx, "audiences").nullable(),
    rule: z.strictObject({ fieldSlug: z.string(), op: z.enum(["equals", "contains"]), value: z.string() }).nullable(),
  }), setEventRouting),
  "agents.setCrmTrigger": operation((ctx) => z.strictObject({
    agentId: id(ctx, "agents"), trigger: z.strictObject({ event: z.literal("deal.stage_changed"), toStage: z.string().optional() }).nullable(),
  }), setEventCrmTrigger),
  "agents.setSlack": operation((ctx) => z.strictObject({ agentId: id(ctx, "agents"), mode: z.enum(["all", "qualified", "failures"]).nullable() }), setEventSlack),
  "agents.testRun": operation((ctx) => z.strictObject({ agentId: id(ctx, "agents"), payload: z.string() }), testEventAgent),
  "agents.setOwner": operation((ctx) => z.strictObject({ agent: principal(ctx), ownerUserId: id(ctx, "users") }), setAgentOwner),
  "agents.setPaused": operation((ctx) => z.strictObject({ agent: principal(ctx), paused: z.boolean() }), setAgentPaused),
  "agents.rotateSecret": operation((ctx) => z.strictObject({ agentId: id(ctx, "agents") }), async (ctx, input, prepared) => {
    if (prepared?.operation !== "agents.rotateSecret") throw new ConvexError("Webhook rotation needs private Canon preparation.");
    await saveEventSecret(ctx, { agentId: input.agentId, secret: prepared.encryptedSecret });
    return { url: agentWebhookUrl(input.agentId) };
  }),
  "grants.create": operation((ctx) => z.strictObject({
    agentId: id(ctx, "agents"), fieldSlug: z.string(), days: z.number(),
    allowedValues: z.array(z.string()).optional(), maxPerDay: z.number().optional(),
  }), createAgentGrant),
  "grants.revoke": operation((ctx) => z.strictObject({ grantId: id(ctx, "agentGrants") }), revokeAgentGrant),
} satisfies Record<CanonOperation, { execute(ctx: MutationCtx, input: unknown, prepared?: PreparedCanonOperation): Promise<unknown> }>;

export async function executeCanonOperation(ctx: MutationCtx, name: CanonOperation, input: unknown, prepared?: PreparedCanonOperation): Promise<unknown> {
  await requireUser(ctx);
  if (await agentClientOf(ctx)) throw new ConvexError("Only a person can run this Canon operation.");
  if (!Object.hasOwn(operations, name)) throw new ConvexError("Unsupported Canon operation.");
  return operations[name].execute(ctx, input, prepared);
}
