"use node";
import { siteUrl } from "./lib/siteUrl";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { publicHttpGet } from "../engine/src/publicHttp.ts";
import { extractCompanyWebsite, type CompanyWebFacts } from "./lib/tam/siteExtract";
import { DEFAULT_ICP_DERIVATION_MODEL, OPENROUTER_API_BASE } from "../engine/src/icpDerive.ts";
import { forcedToolCall } from "../engine/src/llm.ts";

const STAFF_SCHEMA = {
  type: "object", properties: { staff: { type: "array", maxItems: 25, items: {
    type: "object", properties: { fullName: { type: "string" }, title: { type: "string" } }, required: ["fullName"], additionalProperties: false,
  } } }, required: ["staff"], additionalProperties: false,
};

export const extract = internalAction({
  args: { domain: v.string(), startedAt: v.number() },
  handler: async (ctx, { domain, startedAt }) => {
    const apiKey = process.env.OPENROUTER_API_KEY;
    let facts: CompanyWebFacts;
    try {
      facts = await extractCompanyWebsite(domain, {
        now: Date.now(),
        staffModel: apiKey ? (prompt) => forcedToolCall(prompt, "website_staff", STAFF_SCHEMA, DEFAULT_ICP_DERIVATION_MODEL, {
          provider: "openai", apiKey, openaiBaseUrl: OPENROUTER_API_BASE,
        }) : undefined,
        fetchPage: async (url) => {
          if (Date.now() - startedAt > 120_000) return null;
          const r = await publicHttpGet(url, {
            timeoutMs: 8_000, maxRedirects: 3, maxBytes: 2_000_000,
            headers: { "User-Agent": `CanonCRM-WebsiteFacts/1 (+${siteUrl()})`, ...(new URL(url).hostname === "rdap.org" ? { Accept: "application/rdap+json, application/json" } : {}) },
          });
          return r.status >= 200 && r.status < 300 ? { text: new TextDecoder().decode(r.body), finalUrl: r.finalUrl } : null;
        },
      });
    } catch {
      facts = { domain, status: "error", error: "The website read failed.", fetchedAt: Date.now(), pages: [], socials: [], addresses: [], emails: [], staff: [] };
    }
    await ctx.runMutation(internal.companyWebFacts.finish, { facts, startedAt });
  },
});
