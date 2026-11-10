/**
 * Copy Clerk organizations and memberships into this deployment, through the
 * same internal mutations the Clerk webhook (http.ts /clerk-webhook) calls.
 * For a deployment that started receiving webhooks late (dev): users and orgs
 * created before its webhook endpoint existed never reached it.
 *
 *   npx convex run clerkBackfill:run            # all orgs
 *   npx convex run clerkBackfill:run '{"dryRun":true}'
 *
 * Idempotent: the upserts match on Clerk ids. Reads the Clerk Backend API with
 * CLERK_SECRET_KEY.
 */
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { mapClerkRole } from "./lib/clerkRoles";

type ClerkOrg = { id: string; name: string; slug?: string | null };
type ClerkMembership = {
  role: string;
  public_user_data: { user_id: string; identifier: string; first_name?: string | null; last_name?: string | null; image_url?: string | null };
};

async function clerkGet<T>(path: string, key: string): Promise<T> {
  const res = await fetch(`https://api.clerk.com/v1${path}`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`Clerk ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

async function all<T>(path: string, key: string): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; offset += 100) {
    const sep = path.includes("?") ? "&" : "?";
    const page = await clerkGet<{ data: T[]; total_count: number }>(`${path}${sep}limit=100&offset=${offset}`, key);
    out.push(...page.data);
    if (out.length >= page.total_count || !page.data.length) return out;
  }
}

export const run = internalAction({
  args: { dryRun: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<{ orgs: number; memberships: number; dryRun: boolean }> => {
    const key = process.env.CLERK_SECRET_KEY;
    if (!key) throw new Error("CLERK_SECRET_KEY is not set on this deployment");
    const orgs = await all<ClerkOrg>("/organizations", key);
    let memberships = 0;
    for (const org of orgs) {
      const members = await all<ClerkMembership>(`/organizations/${org.id}/memberships`, key);
      memberships += members.length;
      if (args.dryRun) continue;
      await ctx.runMutation(internal.organizations.upsertFromClerk, { clerkOrgId: org.id, name: org.name, slug: org.slug ?? org.id });
      for (const m of members) {
        const pud = m.public_user_data;
        await ctx.runMutation(internal.users.upsertFromClerk, {
          clerkUserId: pud.user_id,
          clerkOrgId: org.id,
          email: pud.identifier,
          name: [pud.first_name, pud.last_name].filter(Boolean).join(" ") || pud.identifier,
          imageUrl: pud.image_url ?? undefined,
          role: mapClerkRole(m.role),
        });
      }
    }
    return { orgs: orgs.length, memberships, dryRun: Boolean(args.dryRun) };
  },
});
