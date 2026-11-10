"use node";

import { ConvexError, v } from "convex/values";
import { internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { principalClient } from "./records";
import { normalizeDomain } from "./lib/recordClient";
import { runScopeOf } from "./lib/scopeValidators";
import { attributeFor, PAGE_CHARS, RUN_CAP, STEP_TOOL, stepSchema, type AgentSpec, type FetchedPage, type Subject } from "./lib/research/agentLoop";
import { piContextStamp, piFinding, piSpecJson, type PiLanding, type PiNext } from "./lib/research/piProtocol";
import { fetchPage } from "./researchAgentActions";
import { resolveLlm } from "./lib/llmResolver";
import { DEFAULT_MODELS, chatgptWebSearch } from "../engine/src/llm";
import { makeWebSearch } from "./lib/research/webSearch";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { Tool } from "@earendil-works/pi-ai";
import { piFixtureRun } from "./lib/research/piEnablement";

async function current(ctx: ActionCtx, runId: Id<"researchRuns">) {
  const loaded = await ctx.runQuery(internal.piResearch.context, { runId });
  if (loaded.standing?.status !== "active") await ctx.runMutation(internal.researchAgents.stopIfInactive, { runId });
  if (loaded.run.status !== "running" || loaded.standing?.status !== "active" || !loaded.principals) throw new ConvexError("Pi run stopped");
  return { ...loaded, client: principalClient(ctx, loaded.run.orgId, loaded.principals), stamp: piContextStamp(loaded) };
}

async function admitted(ctx: ActionCtx, runId: Id<"researchRuns">, stepId: Id<"piResearchSteps">) {
  const loaded = await current(ctx, runId);
  const row = await ctx.runQuery(internal.piResearch.step, { runId, index: loaded.run.piStep ?? 0 });
  if (!row || row._id !== stepId || !row.record || row.landed) throw new ConvexError("Pi step unavailable");
  const record = await loaded.client.get(loaded.run.orgId, row.record.recordId);
  const subject = JSON.parse(row.record.subjectJson) as Subject;
  if (!record || record.account.name !== subject.name || normalizeDomain(record.account.domain) !== subject.domain || row.record.specJson !== piSpecJson(loaded.spec)) throw new ConvexError("Pi record access or subject changed");
  return { ...loaded, row };
}

export const next = internalAction({
  args: { runId: v.id("researchRuns"), index: v.number() },
  handler: async (ctx, args): Promise<PiNext> => {
    const existing: Doc<"piResearchSteps"> | null = await ctx.runQuery(internal.piResearch.step, args);
    if (existing?.landed) return { kind: "advance", ...existing.landed };
    const loaded = await current(ctx, args.runId);
    let row = existing;
    if (!row) {
      const scope = runScopeOf(loaded.run, loaded.agent.entityType);
      if (!scope || scope.entity !== "account") throw new ConvexError("Pi only researches a manual account scope");
      const remaining = loaded.run.planned ? loaded.run.planned - loaded.run.done - loaded.run.errors : RUN_CAP;
      const page = remaining <= 0 ? null : await loaded.client.list(loaded.run.orgId, { filter: scope.filter, sort: { field: "fit", dir: "desc" }, cursor: loaded.run.cursor, limit: 1 });
      const account = page?.rows[0];
      const promoted = account?.domain ? await ctx.runMutation(internal.canonEntities.anchorAccounts, {
        orgId: loaded.run.orgId, accounts: [{ recordId: account.id, domain: normalizeDomain(account.domain), name: account.name }],
      }) : [];
      const entityId = promoted[0]?.entityId;
      const skipped: Id<"canonEntities">[] = entityId ? await ctx.runQuery(internal.researchAgents.skippedEntities, { agentId: loaded.agent._id, entityIds: [entityId], attribute: attributeFor(loaded.agent.slug) }) : [];
      const todo = account && entityId && !skipped.length;
      row = await ctx.runMutation(internal.piResearch.stage, {
        ...args, stamp: loaded.stamp, total: page?.total ?? loaded.run.inScope,
        record: todo ? { recordId: account.id, entityId, label: normalizeDomain(account.domain), subjectJson: JSON.stringify({ name: account.name, domain: normalizeDomain(account.domain) }) } : null,
        skipped: (page?.rows.length ?? 0) - (todo ? 1 : 0), nextCursor: page?.nextCursor ?? null, finished: !page?.nextCursor,
      });
    }
    if (!row.record) {
      const result: PiLanding = await ctx.runMutation(internal.piResearch.land, { runId: args.runId, stepId: row._id, stamp: loaded.stamp, finding: { status: "unknown", reason: "No eligible record on this page." }, ms: 0 });
      return { kind: "advance", ...result };
    }
    await admitted(ctx, args.runId, row._id);
    return { kind: "record", record: { stepId: row._id, spec: JSON.parse(row.record.specJson) as AgentSpec, subject: JSON.parse(row.record.subjectJson) as Subject } };
  },
});

function boundedPage(page: FetchedPage | null): FetchedPage | null {
  return page ? { ...page, url: page.url.slice(0, 2000), text: page.text.slice(0, PAGE_CHARS), links: page.links.slice(0, 60).map((l) => ({ href: l.href.slice(0, 2000), text: l.text.slice(0, 80) })) } : null;
}

export const effect = internalAction({
  args: {
    runId: v.id("researchRuns"), stepId: v.id("piResearchSteps"), key: v.string(),
    operation: v.union(v.literal("read"), v.literal("model"), v.literal("search")), request: v.string(),
  },
  handler: async (ctx, args): Promise<string> => {
    if (args.request.length > 80_000) throw new ConvexError("Pi request too large");
    const loaded = await admitted(ctx, args.runId, args.stepId);
    const data = JSON.parse(args.request) as Record<string, unknown>;
    const reserved: Doc<"piResearchEffects"> = await ctx.runMutation(internal.piResearch.effect, { ...args, stamp: loaded.stamp });
    if (reserved.response !== undefined) return reserved.response;
    const signal = AbortSignal.timeout(Math.max(1, 90_000 - (Date.now() - loaded.row.createdAt)));
    let result: unknown;
    let usedModel: string | undefined;
    if (piFixtureRun(loaded.run)) {
      const subject = JSON.parse(loaded.row.record!.subjectJson) as Subject;
      const url = `https://${subject.domain}/`;
      const quote = `${subject.name} sells a forecasting service for manufacturers.`;
      if (args.operation === "read") result = data.url === url ? { url, text: quote, links: [] } : null;
      else if (args.operation === "search") result = { pages: [], links: [], calls: 0 };
      else { result = { action: "answer", answer: "Forecasting service", quote, sourceUrl: url, confidence: 0.95 }; usedModel = "fixture/research-step"; }
    } else if (args.operation === "read") {
      if (typeof data.url !== "string" || data.url.length > 2000) throw new ConvexError("Invalid Pi page URL");
      result = boundedPage(await fetchPage(data.url));
    } else {
      const llm = await resolveLlm(ctx, loaded.run.createdBy);
      if (!llm || llm.provider !== "chatgpt") throw new ConvexError("Connect ChatGPT before continuing this Pi run");
      const modelId = llm.model ?? DEFAULT_MODELS.chatgpt;
      if (args.operation === "search") {
        if (typeof data.query !== "string" || data.query.length > 500) throw new ConvexError("Invalid Pi search query");
        const search = makeWebSearch({ fetchPage: async (url) => boundedPage(await fetchPage(url)), chatgpt: (query) => chatgptWebSearch(query, modelId, { ...llm, signal }) });
        result = await search(data.query);
      } else {
        if (typeof data.prompt !== "string" || data.prompt.length > 64_000 || data.tool !== STEP_TOOL || ![false, true].some((read) => [false, true].some((search) => JSON.stringify(stepSchema(loaded.spec, read, search)) === data.schemaJson))) throw new ConvexError("Invalid Pi model contract");
        const [major, minor] = process.versions.node.split(".").map(Number);
        if (major < 22 || (major === 22 && minor < 19)) throw new ConvexError("Pi model access requires Node >=22.19");
        const models = createModels();
        models.setProvider(openaiCodexProvider());
        const model = models.getModel("openai-codex", modelId);
        if (!model) throw new ConvexError("The configured ChatGPT model is unavailable in pinned pi-ai");
        const response = await models.complete(model, {
          messages: [{ role: "user", content: data.prompt, timestamp: Date.now() }],
          tools: [{ name: STEP_TOOL, description: "Return the research step.", parameters: JSON.parse(data.schemaJson as string) as Tool["parameters"] }],
        }, { apiKey: llm.apiKey, signal, transport: "sse", toolChoice: "required", maxTokens: 4096, maxRetryDelayMs: 1000 });
        if (response.stopReason === "error" || response.stopReason === "aborted") throw new ConvexError("Pi model request failed");
        const call = response.content.find((part) => part.type === "toolCall" && part.name === STEP_TOOL);
        if (!call || call.type !== "toolCall") throw new ConvexError("Pi model returned no research step");
        result = call.arguments;
        usedModel = `pi-ai/openai-codex/${modelId}`;
      }
    }
    const admittedAtCommit = await admitted(ctx, args.runId, args.stepId);
    const saved: Doc<"piResearchEffects"> = await ctx.runMutation(internal.piResearch.effect, { ...args, stamp: admittedAtCommit.stamp, response: JSON.stringify(result), ...(usedModel ? { model: usedModel } : {}) });
    return saved.response!;
  },
});

export const finish = internalAction({
  args: { runId: v.id("researchRuns"), stepId: v.id("piResearchSteps"), finding: piFinding, ms: v.number() },
  handler: async (ctx, args): Promise<PiLanding> => {
    const previous: PiLanding | null = await ctx.runMutation(internal.piResearch.status, { runId: args.runId, stepId: args.stepId });
    if (previous) return previous;
    const loaded = await admitted(ctx, args.runId, args.stepId);
    return ctx.runMutation(internal.piResearch.land, { ...args, stamp: loaded.stamp });
  },
});
