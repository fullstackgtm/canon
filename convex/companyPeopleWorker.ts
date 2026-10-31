"use node";

import { v } from "convex/values";
import { z } from "zod";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { callerClient, lookupWorkEmail } from "./records";
import { DEFAULT_BUYER_TITLES, findCompanyPeople, signedReviewReplies, type Classification, type PeopleSource } from "./lib/tam/companyPeople";
import { webPersonNameKey } from "./lib/tam/webPeople";
import { normDomain } from "./lib/peopleSources";
import { companyRootDomain } from "./lib/tam/siteExtract";
import { quickEnrichPage } from "./lib/quickenrich";
import { icpTitles } from "./lib/quickenrich";
import { specToIcp } from "./lib/addRecords";
import { paidCallsAllowed, tregCall } from "./lib/treg";
import { forcedToolCall } from "../engine/src/llm";
import { DEFAULT_ICP_DERIVATION_MODEL, OPENROUTER_API_BASE } from "../engine/src/icpDerive";

const roleSchema = { type: "object", properties: { role: { type: "string", enum: ["decision_maker", "champion", "other"] }, reasoning: { type: "string" } }, required: ["role", "reasoning"], additionalProperties: false };
const classification = z.object({ role: z.enum(["decision_maker", "champion", "other"]), reasoning: z.string().min(1) });
const exaAnswer = z.object({ answer: z.object({ fullName: z.string().nullable(), quote: z.string() }), citations: z.array(z.object({ url: z.string().url(), text: z.string().optional() })) });
const reply = z.union([z.string(), z.object({ text: z.string().optional(), snippet: z.string().optional() })]);
const reviewBody = z.object({ output: z.object({ reviews: z.array(z.object({ owner_reply: reply.nullish(), ownerResponse: z.string().nullish(), responseFromOwnerText: z.string().nullish(), response: reply.nullish(), url: z.string().optional() }).passthrough()) }) });

export const run = internalAction({
  args: { runId: v.id("companyPeopleRuns") },
  handler: async (ctx, { runId }) => {
    if (!await ctx.runMutation(internal.companyPeople.claim, { runId })) return;
    try {
      const input = await ctx.runQuery(internal.companyPeople.inputs, { runId });
      if (!input) return;
      const { run, caller, icp, facts, address, placeId } = input;
      const client = callerClient(ctx, caller);
      const detail = await client.get(run.orgId, run.accountId);
      if (!detail || companyRootDomain(detail.account.domain) !== run.domain) throw new Error("Company changed or is unavailable.");
      const token = process.env.TREG_TOKEN;
      const apiKey = process.env.OPENROUTER_API_KEY;
      const meta = { customer: run.orgId, feature: "company_people" };
      const titles = icp ? icpTitles(specToIcp(icp.spec.market, icp.spec.persona)) : DEFAULT_BUYER_TITLES;
      const startedAt = Date.now();
      const model = apiKey && icp ? async (prompt: string): Promise<Classification> => {
        if (Date.now() - startedAt > 3 * 60_000) throw new Error("Classification time budget reached.");
        return classification.parse(await forcedToolCall(prompt, "buyer_role", roleSchema, DEFAULT_ICP_DERIVATION_MODEL, { provider: "openai", apiKey, openaiBaseUrl: OPENROUTER_API_BASE, fetchImpl: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15_000) }) }));
      } : undefined;
      const paid = async (endpoint: string, body: unknown, maxCostUsd: number) => {
        if (!paidCallsAllowed() || !token) throw new Error("Paid data calls unavailable.");
        const r = await tregCall({ token, endpoint, body, meta, maxCostUsd, timeoutMs: 30_000, baseUrl: process.env.TREG_BASE_URL,
          onResponse: async (receipt) => { await ctx.runMutation(internal.records.recordProviderCall, { orgId: run.orgId, endpoint, feature: "company_people", ...(receipt.callId ? { callId: receipt.callId } : {}), costMicro: receipt.costMicro ?? 0, outcome: receipt.status === 200 ? "hit" : "miss" }); },
        });
        if (r.status !== 200) throw new Error("Source unavailable.");
        return r.body;
      };
      const find = async (source: PeopleSource) => {
        if (Date.now() - startedAt > 6 * 60_000) throw new Error("Finder time budget reached.");
        if (source === "linkedin_titles" || source === "linkedin_any") {
          if (!token) throw new Error("People search is not configured.");
          if (source === "linkedin_titles" && !titles.length) return [];
          const page = await quickEnrichPage({ token, query: { company_url: { include: [run.domain], exclude: [] }, ...(source === "linkedin_titles" ? { title: { include: titles, exclude: [] } } : {}) }, meta, countryName: () => undefined, baseUrl: process.env.TREG_BASE_URL });
          return page.people.filter((p) => normDomain(p.company.domain) === run.domain).slice(0, 25).map((p) => ({ fullName: p.fullName, ...(p.title ? { title: p.title } : {}), ...(p.headline ? { headline: p.headline } : {}), ...(p.linkedinUrl ? { linkedinUrl: p.linkedinUrl } : {}), url: p.linkedinUrl ?? `https://${run.domain}` }));
        }
        if (source === "website_staff") return facts?.staff ?? [];
        if (source === "review_replies") {
          if (!placeId) return [];
          const body = reviewBody.parse(await paid("treg.google.maps.reviews", { place_id: placeId, limit: 5 }, 0.00015));
          return signedReviewReplies(body.output.reviews.flatMap((review) => {
            const response = review.owner_reply ?? review.response;
            const text = typeof response === "string" ? response : response?.text ?? response?.snippet ?? review.ownerResponse ?? review.responseFromOwnerText;
            return text ? [{ text, url: review.url ?? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(run.domain)}&query_place_id=${encodeURIComponent(placeId)}` }] : [];
          }));
        }
        const result = exaAnswer.parse(await paid("exa.web.answer", {
          query: `Who is the owner of ${detail.account.name} at ${address}? Return a full name only when a cited page explicitly identifies the owner. Copy the evidence sentence verbatim.`, text: true,
          outputSchema: { type: "object", properties: { fullName: { type: ["string", "null"] }, quote: { type: "string" } }, required: ["fullName", "quote"], additionalProperties: false },
        }, 0.005));
        const { fullName, quote } = result.answer;
        const citation = result.citations.find((c) => quote && c.text?.includes(quote) && fullName && quote.includes(fullName));
        return fullName && fullName.trim().split(/\s+/).length >= 2 && citation ? [{ fullName, title: "Owner", quote, url: citation.url }] : [];
      };
      const result = await findCompanyPeople({
        paid: paidCallsAllowed(), address, context: { companyType: icp?.description ?? detail.account.industry ?? "Company", whatYouSell: icp?.offer ?? "Business services", buyerTitles: [...titles, ...(icp?.spec.persona.titles ?? [])], departments: icp?.spec.persona.departments ?? [] },
        find, model, suppressed: (name) => ctx.runQuery(internal.companyPeople.suppressed, { domain: run.domain, name }),
        existing: (person) => detail.contacts.some((c) => webPersonNameKey(c.fullName) === webPersonNameKey(person.fullName) || Boolean(person.linkedinUrl && c.linkedinUrl === person.linkedinUrl)),
        email: (person) => lookupWorkEmail(ctx, { orgId: run.orgId, fullName: person.fullName, domain: run.domain }),
        keep: async (person) => {
          const current = await ctx.runQuery(internal.companyPeople.inputs, { runId });
          if (!current || Date.now() - startedAt > 7 * 60_000 || await ctx.runQuery(internal.companyPeople.suppressed, { domain: run.domain, name: person.fullName })) return null;
          const live = await callerClient(ctx, current.caller).get(run.orgId, run.accountId);
          if (!live || companyRootDomain(live.account.domain) !== run.domain) throw new Error("Company changed or is unavailable.");
          if (live.contacts.some((p) => webPersonNameKey(p.fullName) === webPersonNameKey(person.fullName))) return null;
          const output = await client.upsertContacts(run.orgId, { records: [{ accountDomain: normDomain(live.account.domain), fullName: person.fullName, ...(person.title ? { title: person.title } : {}), ...(person.linkedinUrl ? { linkedinUrl: person.linkedinUrl } : {}), ...(person.email ? { email: person.email } : {}), emailStatus: person.emailStatus }], source: `company_people:${person.source}`, fill: "missing", idempotencyKey: `company-people:${runId}:${webPersonNameKey(person.fullName)}` });
          const contactId = output.rejected?.length ? null : output.ids[0];
          if (!contactId) return null;
          const landed = (await client.get(run.orgId, run.accountId))?.contacts.find((p) => p.id === contactId);
          if (!landed || live.contacts.some((p) => p.id === contactId)) return null;
          const kept = { ...person, email: landed.email ?? null, emailStatus: landed.email === person.email ? person.emailStatus : "not_checked" as const, sendable: landed.email === person.email && person.sendable };
          await ctx.runMutation(internal.companyPeople.saved, { runId, person: { ...kept, contactId } });
          return contactId;
        },
      });
      if (!model) result.notes.push("Model classification was unavailable. Unmatched titles are labelled other.");
      if (!icp) result.notes.push("No active ICP was available. Searched leadership titles; add an ICP for purchase-specific buyer roles.");
      if (!placeId && paidCallsAllowed()) result.notes.push("Google review replies skipped because no Maps place ID was available.");
      if (!facts?.staff) result.notes.push("Website staff was not available. Read the website facts before trying again.");
      await ctx.runMutation(internal.companyPeople.finish, { runId, failed: false, notes: result.notes });
    } catch {
      await ctx.runMutation(internal.companyPeople.finish, { runId, failed: true, notes: ["The run could not finish. Kept contacts remain and unused credits were returned."] });
    }
  },
});
