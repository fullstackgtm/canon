"use node";

/**
 * Ask Canon: a read-only chat over the caller's own organization.
 *
 * Runs on the caller's connected ChatGPT plan (lib/llmResolver; there is no
 * server-key fallback, docs/pricing.md D4). The tools (lib/ask/tools.ts) read
 * through the same org-scoped record client and Convex queries the dashboard
 * uses, bound to the org the server resolves for the caller. Nothing here
 * writes CRM data. General history lives in the browser; deal chats can retain
 * user questions and checked answers, behind dealChats' live access gate.
 */
import { ConvexError, v } from "convex/values";
import { action, type ActionCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { DEFAULT_MODELS, forcedToolCall } from "../engine/src/llm.ts";
import { resolveLlm } from "./lib/llmResolver";
import { callerClient, requireCaller } from "./records";
import { hiddenFields, type Access } from "./lib/access";
import { ask, MAX_QUESTION_CHARS, type AskMessage, type Source } from "./lib/ask/askLoop";
import { buildPlane } from "./dealPlays";
import { dealChatContext } from "./lib/ask/dealContext";

/** How this workspace names the objects it renamed, for the model to answer in its words. */
const glossaryOf = (renamed: readonly { object: string; label: string; pluralLabel: string }[]) =>
  renamed.length ? `This workspace names some objects its own way; use its names in answers: ${renamed.map((r) => `${r.object} records are "${r.pluralLabel}" (one is a "${r.label}")`).join("; ")}.` : "";
import { askTools, recordAskData, type AskData, type FactInfo, type ObjectInfo } from "./lib/ask/tools";

/** One turn at most: a stuck model call stops here and the turn reports it. */
const TURN_MS = 120_000;

export type AskReply =
  | { status: "ok"; answer: string; sources: Source[] }
  | { status: "not_connected" }
  | { status: "error"; message: string };

/**
 * The Canon entity behind a record, when it has one. Account and contact ids are record-service ids; a deal's id is its stream.
 * Asked only after the caller's scoped client returned the record (lib/ask/tools.ts), so its id is admitted (CP14).
 */
async function entityOf(ctx: ActionCtx, orgId: string, access: Access, object: string, id: string): Promise<{ entityId: Id<"canonEntities">; fields: FactInfo[] } | null> {
  const as = { orgId: orgId as Id<"organizations">, accesses: [access], admitted: [id] };
  const found =
    object === "account" || object === "contact" ? await ctx.runQuery(internal.canonEntities.findFor, { ...as, entityType: object, recordId: id })
    : object === "deal" ? await ctx.runQuery(internal.canonEntities.findFor, { ...as, entityType: "opportunity", entityId: id })
    : null;
  if (!found) return null;
  return { entityId: found.entityId, fields: found.fields.map((f) => ({ attribute: f.attribute, value: f.value, state: f.state, sourceKind: f.sourceKind ?? null, updatedAt: f.updatedAt })) };
}

/** Ask Canon reads only what the caller sees (CP14): every record it looks up goes through the caller's client, and a field hidden from them leaves its facts and receipts too. */
function dataFor(ctx: ActionCtx, orgId: string, access: Access): AskData {
  return recordAskData(callerClient(ctx, { orgId, access }), orgId, {
    async describe(object): Promise<ObjectInfo | null> {
      const d = await ctx.runQuery(api.objects.describe, { object });
      if (!d) return null;
      return { object, label: d.label, fields: d.fields.map((f) => ({ fieldId: f.fieldId, apiName: f.apiName, label: f.label, type: f.type, ...("options" in f ? { options: f.options } : {}) })) };
    },
    async facts(object, id) {
      return (await entityOf(ctx, orgId, access, object, id))?.fields ?? null;
    },
    async receipts(object, id, attribute) {
      const entity = await entityOf(ctx, orgId, access, object, id);
      return entity
        ? ctx.runQuery(internal.canonGate.entityReceiptsFor, { orgId: orgId as Id<"organizations">, accesses: [access], entityId: entity.entityId, attribute, admitted: [id] })
        : null;
    },
  }, (object) => new Set(hiddenFields(access, object)));
}

export const send = action({
  args: {
    question: v.string(),
    streamId: v.optional(v.string()),
    chatId: v.optional(v.id("dealChats")),
    history: v.optional(v.array(v.object({ role: v.union(v.literal("user"), v.literal("assistant")), content: v.string() }))),
  },
  handler: async (ctx, args): Promise<AskReply> => {
    const caller = await requireCaller(ctx, { read: !args.chatId });
    const question = args.question.trim().slice(0, MAX_QUESTION_CHARS);
    if (!question) return { status: "error", message: "Ask a question first." };
    if (args.chatId && args.streamId) return { status: "error", message: "Choose a chat or a deal." };
    // The caller's own plan pays. No plan, no answer: never a Canon key.
    const llm = await resolveLlm(ctx, caller.userId as Id<"users">);
    if (!llm) return { status: "not_connected" };
    const model = llm.model ?? DEFAULT_MODELS[llm.provider];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TURN_MS);
    const turnId = crypto.randomUUID();
    let claimed = false;
    try {
      const saved = args.chatId ? await ctx.runMutation(internal.dealChats.begin, { chatId: args.chatId, turnId }) : null;
      claimed = Boolean(saved);
      const streamId = saved?.streamId ?? args.streamId;
      const plane = streamId ? await buildPlane(ctx, caller, streamId) : null;
      if (streamId && !plane) throw new ConvexError("Deal not found, or you cannot see it");
      const result = await ask(
        {
          tools: askTools(dataFor(ctx, caller.orgId, caller.access)),
          glossary: glossaryOf(await ctx.runQuery(internal.dataModel.relabels, { orgId: caller.orgId as Id<"organizations"> })),
          signal: controller.signal,
          ...(plane ? { context: dealChatContext(plane) } : {}),
          call: (prompt, tool, schema) =>
            forcedToolCall(prompt, tool, schema, model, { ...llm, fetchImpl: (input, init) => fetch(input, { ...init, signal: controller.signal }) }),
        },
        (saved?.history ?? args.history ?? []) as AskMessage[],
        question,
      );
      if (args.chatId) await ctx.runMutation(internal.dealChats.finish, { chatId: args.chatId, turnId, reply: { question, answer: result.answer, sources: result.sources } });
      claimed = false;
      return { status: "ok", answer: result.answer, sources: result.sources };
    } catch (error) {
      const message = controller.signal.aborted ? "Ask Canon ran out of time. Try a narrower question." : error instanceof Error ? error.message : "Ask Canon failed.";
      return { status: "error", message: message.slice(0, 300) };
    } finally {
      clearTimeout(timer);
      if (claimed && args.chatId) await ctx.runMutation(internal.dealChats.finish, { chatId: args.chatId, turnId }).catch(() => {});
    }
  },
});
