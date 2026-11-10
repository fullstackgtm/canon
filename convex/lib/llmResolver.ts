import type { ActionCtx } from "../_generated/server";
import { integrationEnabled } from "./integrationsAvailable.ts";

import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
// Type-only: llm.ts itself pulls in the Node credential store.
import type { LlmCallOptions } from "../../engine/src/llm.ts";
import { ChatgptReauthRequired, chatgptIdentity, refreshChatgptTokens } from "../../engine/src/chatgptAuth.ts";
import { decryptFromStorage, encryptForStorage } from "./tokenHelpers";

/** Refresh this far ahead of expiry so a long run doesn't expire mid-flight. */
const REFRESH_MARGIN_MS = 10 * 60_000;

/**
 * The single place Convex picks an LLM for a task: the acting user's connected
 * ChatGPT plan, so inference is on their budget. There is deliberately no
 * server-key fallback: agent runs are unlimited on a flat plan, so Canon must
 * not pay for them (docs/pricing.md). Returns null when the user has no
 * connected plan; callers keep their no-LLM fallback.
 * Every new AI feature should resolve its LLM through here.
 */
export async function resolveLlm(
  ctx: ActionCtx,
  userId: Id<"users"> | null | undefined,
): Promise<LlmCallOptions | null> {
  return userId ? chatgptLlmForUser(ctx, userId) : null;
}

/** The user's ChatGPT session as LLM options, refreshed if near expiry; null if not connected. */
export async function chatgptLlmForUser(ctx: ActionCtx, userId: Id<"users">): Promise<LlmCallOptions | null> {
  if (!integrationEnabled("chatgpt")) return null;
  const row = await ctx.runQuery(internal.chatgptAuth.getRow, { userId });
  if (!row || row.status !== "connected" || !row.accessToken || !row.refreshToken || !row.idToken || !row.accountId) {
    return null;
  }
  let accessToken = await decryptFromStorage(row.accessToken);
  if ((row.accessTokenExpiresAt ?? 0) - REFRESH_MARGIN_MS < Date.now()) {
    try {
      const tokens = await refreshChatgptTokens({
        accessToken,
        refreshToken: await decryptFromStorage(row.refreshToken),
        idToken: await decryptFromStorage(row.idToken),
      });
      const saved = await ctx.runMutation(internal.chatgptAuth.saveRefreshed, {
        userId,
        expectedRefreshToken: row.refreshToken,
        accessToken: await encryptForStorage(tokens.accessToken),
        refreshToken: await encryptForStorage(tokens.refreshToken),
        idToken: await encryptForStorage(tokens.idToken),
        accessTokenExpiresAt: chatgptIdentity(tokens).accessTokenExpiresAt,
      });
      // Lost the race to a concurrent refresh: its tokens are the live ones.
      if (!saved) return chatgptLlmForUser(ctx, userId);
      accessToken = tokens.accessToken;
    } catch (error) {
      if (!(error instanceof ChatgptReauthRequired)) throw error;
      await ctx.runMutation(internal.chatgptAuth.markError, {
        userId,
        error: error.message,
        expectedRefreshToken: row.refreshToken,
      });
      return null;
    }
  }
  return {
    provider: "chatgpt",
    apiKey: accessToken,
    chatgptAccountId: row.accountId,
    model: process.env.CHATGPT_MODEL || undefined,
  };
}
