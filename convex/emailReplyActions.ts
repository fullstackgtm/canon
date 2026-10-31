"use node";

/**
 * A reply's class when its words don't say (lib/email/replies.ts): one question to the inbox owner's ChatGPT plan, so
 * Canon pays nothing. Without a connected plan, or when the model fails, the reply stays unclassified.
 */
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { DEFAULT_MODELS, forcedToolCall } from "../engine/src/llm.ts";
import { resolveLlm } from "./lib/llmResolver";
import { CLASSIFY_SCHEMA, classifyPrompt, REPLY_CLASSES, type ReplyClass } from "./lib/email/replies";

export const classify = internalAction({
  args: { userId: v.id("users"), subject: v.string(), body: v.string() },
  handler: async (ctx, a): Promise<ReplyClass | null> => {
    try {
      // Inside the catch: a refresh that fails (network, 5xx) leaves the reply unclassified, never unlogged.
      const llm = await resolveLlm(ctx, a.userId);
      if (!llm) return null;
      const raw = await forcedToolCall(classifyPrompt(a.subject, a.body), "reply_class", CLASSIFY_SCHEMA, llm.model ?? DEFAULT_MODELS[llm.provider], llm);
      const cls = (raw as { class?: unknown } | null)?.class;
      return REPLY_CLASSES.includes(cls as ReplyClass) ? (cls as ReplyClass) : null;
    } catch (error) {
      console.warn("reply classification failed", error instanceof Error ? error.message : error);
      return null;
    }
  },
});
