import { v } from "convex/values";
import { internalQuery, type QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { principalAccess, workspaceMembers } from "./permissions";
import { callReader } from "./lib/modules/transcripts";
import { teamOf, isOurSide } from "./lib/calls/suggestions";
import { isAutomated } from "./lib/conversations/email";
import { FREE_EMAIL_DOMAINS } from "../engine/src/freeEmailDomains.ts";

export async function ownAccounts(ctx: QueryCtx, orgId: Id<"organizations">, userId: Id<"users">) {
  const linkedin = (await ctx.db.query("linkedinAccounts").withIndex("by_userId", (q) => q.eq("userId", userId)).take(50)).filter((a) => a.orgId === orgId && a.status !== "disconnected");
  const email = (await ctx.db.query("emailAccounts").withIndex("by_userId", (q) => q.eq("userId", userId)).take(50)).filter((a) => a.orgId === orgId && a.status !== "disconnected");
  return { linkedin, email };
}
export async function sourceStatus(ctx: QueryCtx, orgId: Id<"organizations">, userId: Id<"users">) {
  const a = await ownAccounts(ctx, orgId, userId);
  const granola = await ctx.db.query("integrations").withIndex("by_orgId_provider", (q) => q.eq("orgId", orgId).eq("provider", "granola")).first();
  const linked = a.linkedin.some((x) => x.status === "ok");
  return [
    { id: "linkedin", name: "LinkedIn profile and posts", status: linked ? "connected" : "not_connected", intakeStatus: !linked ? "not_connected" : a.linkedin.some((x) => x.status === "ok" && x.ingest) ? "connected" : "not_opted_in", url: "/dashboard/integrations/linkedin" },
    { id: "gmail", name: "Gmail", status: !a.email.some((x) => x.status === "ok") ? "not_connected" : a.email.some((x) => x.status === "ok" && x.ingest) ? "connected" : "not_opted_in", url: "/dashboard/integrations/gmail" },
    { id: "granola", name: "Granola calls", status: granola?.isActive ? "connected" : "not_connected", url: "/dashboard/integrations/granola" },
  ];
}
export const snapshot = internalQuery({
  args: { orgId: v.id("organizations"), userId: v.id("users"), counterparts: v.optional(v.boolean()) },
  handler: async (ctx, { orgId, userId, counterparts }) => {
    const access = (await principalAccess(ctx, orgId, [userId]))?.[0];
    if (!access) throw new Error("Personal context requires a current workspace member.");
    const accounts = await ownAccounts(ctx, orgId, userId);
    const sources = await sourceStatus(ctx, orgId, userId);
    if (counterparts === false) return { sources, linkedinAccountId: accounts.linkedin.find((a) => a.status === "ok")?.unipileAccountId ?? null, rows: [], access, teamDomains: [] as string[] };
    const members = await workspaceMembers(ctx, orgId);
    const granola = await ctx.db.query("integrations").withIndex("by_orgId_provider", (q) => q.eq("orgId", orgId).eq("provider", "granola")).first();
    const extra = granola?.syncConfig?.granolaOurTeam;
    const team = teamOf(members.map((m) => m.email), Array.isArray(extra) ? extra.filter((x): x is string => typeof x === "string") : []);
    const now = Date.now();
    const since = now - 90 * 86400000;
    const rows: Array<{ id: string; name: string; email: string; domain: string; channel: "email" | "linkedin" | "call"; interactions: number; lastAt: number; personId?: string }> = [];
    const add = (p: { id: string; name?: string; email?: string; domain?: string; personId?: string }, channel: "email" | "linkedin" | "call", interactions: number, lastAt: number) => {
      const email = (p.email ?? "").toLowerCase();
      const domain = p.domain ?? email.split("@")[1] ?? "";
      if (isOurSide(team, email) || team.domains.has(domain) || isAutomated(new Map(), email) || (!p.personId && !p.name && (!domain || FREE_EMAIL_DOMAINS.has(domain))) || !interactions) return;
      rows.push({ id: p.personId ? `person:${p.personId}` : email ? `email:${email}` : p.id, name: p.name?.slice(0, 200) ?? "", email, domain: FREE_EMAIL_DOMAINS.has(domain) ? "" : domain, channel, interactions, lastAt, ...(p.personId ? { personId: p.personId } : {}) });
    };
    for (const a of [...accounts.linkedin, ...accounts.email].filter((a) => a.status === "ok" && a.ingest)) {
      const conversations = await ctx.db.query("conversations").withIndex("by_accountRef_and_lastMessageAt", (q) => q.eq("accountRef", a._id).gte("lastMessageAt", since).lte("lastMessageAt", now)).take(1001);
      if (conversations.length > 1000) throw new Error("Personal context exceeds 1,000 recent conversations on one account.");
      for (const c of conversations) {
        if (c.orgId !== orgId || c.ownerUserId !== userId) continue;
        const messages = await ctx.db.query("conversationMessages").withIndex("by_conversationId_and_at", (q) => q.eq("conversationId", c._id).gte("at", since).lte("at", now)).take(2001);
        if (messages.length > 2000) throw new Error("Personal context exceeds 2,000 recent interactions in one conversation.");
        // Intake already excludes newsletters, automated mail and bulk sends. Only metadata crosses this query.
        add({ id: `${c.channel}:${c.counterpart.providerId ?? c._id}`, ...c.counterpart, personId: c.contactIds.length === 1 ? c.contactIds[0] : undefined }, c.channel, messages.length, c.lastMessageAt);
      }
    }
    const callerEmail = members.find((m) => m.id === userId)?.email?.toLowerCase();
    const reader = callReader(ctx, orgId, access);
    const calls = await ctx.db.query("callRecordings").withIndex("by_orgId_callDate", (q) => q.eq("orgId", orgId).gte("callDate", new Date(since).toISOString()).lte("callDate", new Date(now).toISOString())).take(5001);
    if (calls.length > 5000) throw new Error("Personal context exceeds 5,000 recent calls.");
    for (const c of calls) {
      const attended = callerEmail && c.participants?.some((p: { email?: unknown }) => typeof p?.email === "string" && p.email.toLowerCase() === callerEmail);
      if (c.ownerId !== userId && !attended || !(await reader.callSeen(c))) continue;
      const seen = new Set<string>();
      for (const raw of c.participants ?? []) {
        const p = raw as { email?: unknown; name?: unknown };
        const email = typeof p.email === "string" ? p.email.toLowerCase() : "";
        if (!email || seen.has(email)) continue;
        seen.add(email);
        add({ id: `email:${email}`, email, name: typeof p.name === "string" ? p.name : undefined }, "call", 1, Date.parse(c.callDate!));
      }
    }
    return { sources, linkedinAccountId: accounts.linkedin.find((a) => a.status === "ok")?.unipileAccountId ?? null, rows, access, teamDomains: [...team.domains] };
  },
});
