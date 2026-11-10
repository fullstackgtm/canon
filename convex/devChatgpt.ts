import { sealedV } from "./lib/sealed";
import { ConvexError, v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { DEV_USER_CLERK_ID, isDevAuthBypassEnabled } from "./lib";
import { decryptFromStorage, encryptForStorage } from "./lib/tokenHelpers";

/**
 * Local stacks only: carry the dev user's "Sign in with ChatGPT" session from
 * one local stack to the next, so testing AI features doesn't need a device
 * login every time. scripts/dev/dev-isolated.sh exports it on stop (stdout
 * into a mode-600 file outside the repo) and restores it on start through the
 * CHATGPT_DEV_SESSION env var (never argv), which it removes right after.
 *
 * Refuses to run unless this is a loopback deployment with the demo-user
 * bypass on, so it is inert on dev.canoncrm.com and prod.
 */
function requireLocalStack() {
  const url = process.env.CONVEX_CLOUD_URL ?? "";
  const loopback = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(url);
  if (!loopback || !isDevAuthBypassEnabled()) throw new ConvexError("devChatgpt runs on local stacks only");
}

type Session = {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  accessTokenExpiresAt?: number;
  accountId: string;
  email?: string;
  planType?: string;
  connectedAt?: number;
  updatedAt: number;
};

export const devUserRow = internalQuery({
  args: {},
  handler: async (ctx) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", DEV_USER_CLERK_ID))
      .first();
    if (!user) return null;
    const row = await ctx.db
      .query("chatgptAuth")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .unique();
    return { userId: user._id, row };
  },
});

/** The dev user's connected session, decrypted, or null. Printed by `convex run` into the session file. */
export const exportSession = internalAction({
  args: {},
  handler: async (ctx): Promise<Session | null> => {
    requireLocalStack();
    const found: { userId: Id<"users">; row: { status: string; [k: string]: unknown } | null } | null =
      await ctx.runQuery(internal.devChatgpt.devUserRow, {});
    const row = found?.row as Record<string, unknown> | null | undefined;
    if (!row || row.status !== "connected" || typeof row.accessToken !== "string" || typeof row.refreshToken !== "string" || typeof row.idToken !== "string" || typeof row.accountId !== "string") {
      return null;
    }
    return {
      accessToken: await decryptFromStorage(row.accessToken),
      refreshToken: await decryptFromStorage(row.refreshToken),
      idToken: await decryptFromStorage(row.idToken),
      accessTokenExpiresAt: row.accessTokenExpiresAt as number | undefined,
      accountId: row.accountId,
      email: row.email as string | undefined,
      planType: row.planType as string | undefined,
      connectedAt: row.connectedAt as number | undefined,
      updatedAt: row.updatedAt as number,
    };
  },
});

/** Restore CHATGPT_DEV_SESSION (base64 JSON) for the dev user unless the stack already has a newer session. */
export const restoreSession = internalAction({
  args: {},
  handler: async (ctx): Promise<string> => {
    requireLocalStack();
    const encoded = process.env.CHATGPT_DEV_SESSION;
    if (!encoded) return "none";
    let session: Session;
    try {
      session = JSON.parse(atob(encoded)) as Session;
    } catch {
      return "off:unreadable";
    }
    if (!session?.accessToken || !session.refreshToken || !session.idToken || !session.accountId) return "off:incomplete";
    if (!process.env.TOKEN_ENCRYPTION_KEY?.trim()) return "off:no-TOKEN_ENCRYPTION_KEY";
    return ctx.runMutation(internal.devChatgpt.writeSession, {
      accessToken: await encryptForStorage(session.accessToken),
      refreshToken: await encryptForStorage(session.refreshToken),
      idToken: await encryptForStorage(session.idToken),
      accessTokenExpiresAt: session.accessTokenExpiresAt,
      accountId: session.accountId,
      email: session.email,
      planType: session.planType,
      connectedAt: session.connectedAt,
      savedAt: session.updatedAt,
    });
  },
});

export const writeSession = internalMutation({
  args: {
    accessToken: sealedV,
    refreshToken: sealedV,
    idToken: sealedV,
    accessTokenExpiresAt: v.optional(v.number()),
    accountId: v.string(),
    email: v.optional(v.string()),
    planType: v.optional(v.string()),
    connectedAt: v.optional(v.number()),
    savedAt: v.number(),
  },
  handler: async (ctx, { savedAt, ...fields }) => {
    requireLocalStack();
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", DEV_USER_CLERK_ID))
      .first();
    if (!user) return "off:no-dev-user";
    const row = await ctx.db
      .query("chatgptAuth")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .unique();
    if (row?.status === "connected" && row.updatedAt >= savedAt) return "stack-newer";
    if (row) await ctx.db.delete(row._id);
    await ctx.db.insert("chatgptAuth", { userId: user._id, status: "connected", ...fields, updatedAt: savedAt });
    return "restored";
  },
});
