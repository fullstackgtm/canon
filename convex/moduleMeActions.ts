"use node";
import { createHash } from "node:crypto";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { createUnipileClient } from "./lib/linkedin/unipile";
import { unipileEnv } from "./linkedinActions";
import { fakeModel } from "./lib/modules/ai";
import { callerClient } from "./records";

const text = (x: unknown, max = 8000): string => typeof x === "string" ? x.slice(0, max) : "";
const record = (x: unknown): Record<string, unknown> => x && typeof x === "object" ? x as Record<string, unknown> : {};
function personalClient() {
  if (fakeModel()) return createUnipileClient({
    apiKey: "fixture", dsn: "https://unipile.fixture",
    fetchImpl: async (url) => {
      const request = new URL(String(url));
      const account = request.searchParams.get("account_id");
      return Response.json(request.pathname.endsWith("/posts")
        ? { items: [{ id: "fixture-post", text: "I reconcile commissions before every payroll deadline. Fixture, no provider contacted." }] }
        : { provider_id: `fixture-${account}`, headline: `Revenue operations lead for ${account}. Fixture profile, no provider contacted.`, summary: "I help sales teams reconcile commissions.", work_experience: [
          { position: "Revenue operations lead", company: "Fixture SaaS", start: "2022", end: null },
          { position: "Sales operations analyst", company: "Fixture Software", start: "2018", end: "2021" },
        ] });
    },
  });
  const env = unipileEnv();
  if (!env) throw new Error("LinkedIn is not configured on this deployment.");
  return createUnipileClient(env);
}

export const context = internalAction({
  args: { orgId: v.id("organizations"), userId: v.id("users"), section: v.string() },
  handler: async (ctx, a): Promise<Array<Record<string, unknown>>> => {
    if (!["all", "words", "counterparts", "sources"].includes(a.section)) throw new Error("Unknown personal context section.");
    const snap = await ctx.runQuery(internal.moduleMe.snapshot, { orgId: a.orgId, userId: a.userId, counterparts: a.section === "all" || a.section === "counterparts" });
    if (a.section === "sources") return snap.sources;
    const out: Array<Record<string, unknown>> = a.section === "all" ? [...snap.sources] : [];
    if (a.section === "all" || a.section === "words") {
      if (snap.linkedinAccountId) {
        const client = personalClient();
        const profile = await client.selfProfile(snap.linkedinAccountId);
        const fields = ["headline", "summary", "location"];
        for (const field of fields) if (text(profile[field])) out.push({ id: `profile:${field}`, kind: "profile", text: text(profile[field]) });
        for (const [i, raw] of (Array.isArray(profile.work_experience) ? profile.work_experience : []).slice(0, 20).entries()) {
          const p = record(raw);
          const title = text(p.position ?? p.title, 300), company = text(p.company ?? p.company_name, 300);
          const dates = [p.start, p.end].map((x) => typeof x === "string" ? x : JSON.stringify(x ?? "present")).join(" to ");
          if (title) out.push({ id: `profile:position:${i}`, kind: "profile", title, company, dates, text: title });
          if (text(p.description)) out.push({ id: `profile:position:${i}:description`, kind: "profile", text: text(p.description) });
        }
        const providerId = text(profile.provider_id, 500);
        if (providerId) for (const [i, raw] of (await client.recentPosts(snap.linkedinAccountId, providerId, 20)).slice(0, 20).entries()) {
          const p = record(raw), body = text(p.text ?? p.content);
          if (body) out.push({ id: `post:${text(p.id, 500) || i}`, kind: "post", text: body });
        }
      }
    }
    if (a.section === "all" || a.section === "counterparts") {
      const client = callerClient(ctx, { orgId: a.orgId, access: snap.access });
      const merged = new Map<string, Record<string, unknown>>();
      for (const r of snap.rows) {
        let personId = r.personId;
        if (!personId && r.email) {
          const found = await client.listRegister(a.orgId, "contact", { filter: [{ field: "email", op: "eq", value: r.email }], limit: 2 });
          if (found.rows.length === 1) personId = found.rows[0].id;
        }
        const person = personId ? await client.getContact(a.orgId, personId) : null;
        const values = record(person);
        const companyId = text(values.accountId);
        const company = companyId ? await client.get(a.orgId, companyId) : null;
        const cv = record(company?.account);
        if (snap.teamDomains.includes(text(cv.domain, 300) || r.domain)) continue;
        if (!person && !r.name && !r.domain) continue;
        const id = person ? `person:${personId}` : r.id;
        const old = merged.get(id);
        merged.set(id, { id, name: text(values.fullName ?? values.name, 200) || r.name, title: text(values.title, 300), company: text(cv.name, 300), domain: text(cv.domain, 300) || r.domain, channels: [...new Set([...(old?.channels as string[] ?? []), r.channel])], interactions: Number(old?.interactions ?? 0) + r.interactions, lastAt: Math.max(Number(old?.lastAt ?? 0), r.lastAt), ...(person ? { personId } : {}) });
      }
      out.push(...[...merged.values()].sort((a, b) => Number(b.interactions) - Number(a.interactions) || String(a.id).localeCompare(String(b.id))).slice(0, 200).map((p) => ({
        ref: createHash("sha256").update(`${a.userId}:${p.id}`).digest("hex"),
        title: p.title, company: p.company, channels: p.channels, interactions: p.interactions, lastAt: p.lastAt,
      })));
    }
    return out;
  },
});
