import { v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
// Node-free engine module: runs in the default Convex runtime.
import {
  chatgptIdentity,
  exchangeDeviceCode,
  pollDeviceCode,
  requestDeviceCode,
} from "../engine/src/chatgptAuth.ts";
import { decryptFromStorage, encryptForStorage } from "./lib/tokenHelpers";

/**
 * "Sign in with ChatGPT" device flow, server-driven: `start` gets a user code
 * and schedules `poll`, which re-schedules itself until the user approves at
 * auth.openai.com (or the code expires). The browser only subscribes to
 * chatgptAuth.status — it never polls OpenAI and never sees a token.
 */
export const start = action({
  args: {},
  handler: async (ctx): Promise<{ userCode: string; verificationUrl: string; expiresAt: number }> => {
    const userId: Id<"users"> | null = await ctx.runQuery(internal.chatgptAuth.currentUserId, {});
    if (!userId) throw new Error("Not authenticated");
    const code = await requestDeviceCode();
    await ctx.runMutation(internal.chatgptAuth.savePending, {
      userId,
      deviceAuthId: await encryptForStorage(code.deviceAuthId),
      userCode: code.userCode,
      verificationUrl: code.verificationUrl,
      pollIntervalMs: code.intervalMs,
      deviceExpiresAt: code.expiresAt,
    });
    await ctx.scheduler.runAfter(code.intervalMs, internal.chatgptAuthActions.poll, {
      userId,
      userCode: code.userCode,
    });
    return { userCode: code.userCode, verificationUrl: code.verificationUrl, expiresAt: code.expiresAt };
  },
});

export const poll = internalAction({
  args: { userId: v.id("users"), userCode: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.runQuery(internal.chatgptAuth.getRow, { userId: args.userId });
    // Superseded (restarted, disconnected, or already finished): stop polling.
    if (!row || row.status !== "pending" || row.userCode !== args.userCode || !row.deviceAuthId) return null;
    const fail = (error: string) =>
      ctx.runMutation(internal.chatgptAuth.markError, { userId: args.userId, error, expectedUserCode: args.userCode });
    if (Date.now() > (row.deviceExpiresAt ?? 0)) {
      await fail("The sign-in code expired before it was approved. Start again.");
      return null;
    }
    let result: Awaited<ReturnType<typeof pollDeviceCode>>;
    try {
      result = await pollDeviceCode(await decryptFromStorage(row.deviceAuthId), args.userCode);
    } catch (error) {
      // A transient poll failure shouldn't kill the login; the expiry check
      // above bounds the retries.
      console.warn(`chatgptAuth: poll failed, retrying: ${error instanceof Error ? error.message : error}`);
      result = { status: "pending" };
    }
    if (result.status === "pending") {
      await ctx.scheduler.runAfter(row.pollIntervalMs ?? 5_000, internal.chatgptAuthActions.poll, args);
      return null;
    }
    try {
      const tokens = await exchangeDeviceCode(result.authorizationCode, result.codeVerifier);
      const identity = chatgptIdentity(tokens);
      await ctx.runMutation(internal.chatgptAuth.saveConnected, {
        userId: args.userId,
        expectedUserCode: args.userCode,
        accessToken: await encryptForStorage(tokens.accessToken),
        refreshToken: await encryptForStorage(tokens.refreshToken),
        idToken: await encryptForStorage(tokens.idToken),
        accessTokenExpiresAt: identity.accessTokenExpiresAt,
        accountId: identity.accountId,
        email: identity.email,
        planType: identity.planType,
      });
    } catch (error) {
      await fail(error instanceof Error ? error.message : "ChatGPT sign-in failed.");
    }
    return null;
  },
});
