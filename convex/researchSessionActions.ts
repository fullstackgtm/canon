"use node";

import { integrationEnabled } from "./lib/integrationsAvailable.ts";

import { v } from "convex/values";
import type { FunctionArgs } from "convex/server";
import { internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
// Node-free module imports (never the package barrel) — established pattern.
import { deriveWebsiteIcp, websiteText, websiteSources, DEFAULT_ICP_DERIVATION_MODEL, OPENROUTER_API_BASE } from "../engine/src/icpDerive.ts";
import { publicHttpGet } from "../engine/src/publicHttp.ts";
import { createMemoryRecordStore, recordClient } from "./lib/recordClient";
import { icpGeosToCountries, ResearchFailure, runResearchPipeline, type ResearchStatus } from "./lib/researchPipeline";
import { quickEnrichTam } from "./lib/quickenrich";
import { jevAsk } from "./lib/segments/jev";
import { paidCallsAllowed } from "./lib/treg";
import { marketSegments } from "./lib/segments/marketSegments";
import { fetchHomepage } from "./lib/homepageFetch";
import { discoverBrand } from "./lib/onboardingBrand";
import { researchTeamShape } from "./lib/teamShape";
import { forcedToolCall } from "../engine/src/llm";
import { briefPrompt, briefToolSchema, buyerTargets, exampleAccounts, verifyBrief } from "./lib/onboardingBrief";

/** Same fetch as icpDerive's default. */
const directFetch = (url: string) =>
  publicHttpGet(url, {
    timeoutMs: 12_000, maxRedirects: 4, maxBytes: 4_000_000,
    headers: { "User-Agent": "fullstackgtm-icp-derive/1 (+https://github.com/fullstackgtm/core)" },
  }).then((r) => (r.status >= 200 && r.status < 300 ? { text: new TextDecoder().decode(r.body), finalUrl: r.finalUrl } : null)).catch(() => null);

/**
 * Memoized so ICP derivation and segments share one request per URL. The
 * homepage gets the fallback chain (fetch Worker, then ScrapingBee where paid
 * calls are allowed) when a direct fetch can't read it; other URLs (e.g.
 * /llms.txt) are fetched directly. ScrapingBee calls are filed under `ledgerOrgId`.
 */
export function memoFetcher(ctx: ActionCtx, ledgerOrgId: string, feature: string) {
  const cache = new Map<string, Promise<{ text: string; finalUrl: string } | null>>();
  return (url: string) => {
    if (!cache.has(url)) {
      const u = new URL(url);
      cache.set(url, u.pathname === "/"
        ? fetchHomepage(u.hostname.replace(/^www\./, ""), {
            direct: directFetch,
            workerToken: process.env.FETCH_TOKEN,
            workerUrl: process.env.FETCH_URL,
            scrapingBeeKey: paidCallsAllowed() && integrationEnabled("scrapingbee") ? process.env.SCRAPINGBEE_API_KEY : undefined,
            onScrapingBee: ({ costMicro, hit }) => ctx.runMutation(internal.records.recordProviderCall, {
              orgId: ledgerOrgId, provider: "scrapingbee", endpoint: "scrapingbee.render_js", feature, costMicro, outcome: hit ? "hit" : "miss",
            }),
          }).then((p) => p && { text: p.text, finalUrl: p.finalUrl })
        : directFetch(url));
    }
    return cache.get(url)!;
  };
}

/**
 * Anonymous research pipeline: deriveWebsiteIcp -> QuickEnrich TAM search
 * through treg.to (free; the PDL shared index when TREG_TOKEN is unset) ->
 * score -> segments. When no ICP can be derived (no OPENROUTER_API_KEY, an
 * unreadable site, unverifiable quotes) the session fails with the reason and
 * the failure is logged to researchFailures. Contacts are not shown before sign-up.
 */
export const run = internalAction({
  args: { sessionId: v.id("researchSessions") },
  handler: async (ctx, args) => {
    const session = await ctx.runQuery(internal.researchSessions.getInternal, { sessionId: args.sessionId });
    if (!session || session.status === "ready" || session.status === "failed") return null;
    const apiKey = process.env.OPENROUTER_API_KEY;
    const jevKey = process.env.JEV_API_KEY;
    const tregToken = process.env.TREG_TOKEN;
    const fetchPage = memoFetcher(ctx, `research:${args.sessionId}`, "onboarding_research");
    // Shared PDL search needs no workspace store; the fake reads the fixture.
    const client = recordClient({ store: createMemoryRecordStore() });
    let stage: ResearchStatus = "deriving";
    const finding = async (patch: FunctionArgs<typeof internal.researchSessions.patchFromPipeline>) =>
      ctx.runMutation(internal.researchSessions.patchFromPipeline, patch);
    const homepage = apiKey ? fetchPage(`https://${session.domain}/`) : Promise.resolve(null);
    const teamPromise = researchTeamShape({ domain: session.domain, homepage, fetchPage: directFetch }).then(async (teamShape) => {
      const own = await client.searchShared({ q: session.domain }, 5).catch(() => null);
      const company = own?.rows.find((r) => r.domain.replace(/^www\./, "") === session.domain);
      if (company?.employees !== undefined) teamShape.sizeBand = {
        value: `${company.employees} employees`,
        evidence: [{ url: "", quote: `Prospect index: ${company.employees} employees` }],
      };
      await finding({ sessionId: args.sessionId, teamShape, event: { kind: "team", text: "Checked CRM fingerprints, pricing and public hiring." } });
    }).catch(async () => {
      await finding({ sessionId: args.sessionId, event: { kind: "team", text: "Using a simple account-first setup. You can adjust it later." } });
    });
    try {
      await runResearchPipeline({
        domain: session.domain,
        client,
        // The free source is QuickEnrich (Leadsforge is paid now); the pipeline
        // falls back to the PDL index if it fails.
        searchTam: tregToken
          ? (icp) => quickEnrichTam({
              token: tregToken, icp, meta: { customer: "anonymous", feature: "tam_preview" }, baseUrl: process.env.TREG_BASE_URL,
              countryName: (iso) => icpGeosToCountries([iso.toLowerCase()])[0],
            })
          : undefined,
        deriveIcp: async (domain) => {
          if (!apiKey) throw new Error("icp derive: OPENROUTER_API_KEY is not configured.");
          let lastStage = "";
          let progressWrites = Promise.resolve();
          const derived = await deriveWebsiteIcp({ domain, apiKey, fetchPages: fetchPage, onProgress: (event) => {
            if (event.stage === lastStage && event.stage !== "fetch") return;
            lastStage = event.stage;
            const text = event.stage === "fetch" ? event.message : event.stage === "model" ? "Identifying what you sell and who buys it." : "Checking the findings against quotes from your website.";
            progressWrites = progressWrites.then(async () => {
              await finding({ sessionId: args.sessionId, event: { kind: event.stage, text } });
            }).catch(() => undefined);
          } }).finally(() => progressWrites);
          const page = await homepage;
          const brand = page ? await discoverBrand(page, directFetch).catch(() => undefined) : undefined;
          await finding({ sessionId: args.sessionId, companyFinding: {
            name: derived.company.name, summary: derived.company.summary,
            ...(brand ? { brand } : {}),
            evidence: derived.evidence.map((e) => ({ url: e.sourceUrl, quote: e.excerpt })),
          }, event: { kind: "company", text: derived.company.summary || `Read ${domain} and verified its customer profile.`, evidence: derived.evidence.map((e) => ({ url: e.sourceUrl, quote: e.excerpt })) } });
          return derived.icp;
        },
        deriveSegments: jevKey
          ? async (domain) => {
              const page = await fetchPage(`https://${domain}/`);
              const text = page ? websiteText(page.text).slice(0, 12_000) : "";
              if (text.length < 200) throw new Error(`could not read enough of ${domain}`);
              return marketSegments(jevAsk(jevKey), domain, text);
            }
          : undefined,
        onFinding: async (patch) => { await finding({ sessionId: args.sessionId, ...patch, event: { kind: "segments", text: "Identified buyer segments from your website." } }); },
        onStatus: async (status, patch) => {
          if (status === "ready") await teamPromise;
          stage = status;
          await ctx.runMutation(internal.researchSessions.patchFromPipeline, {
            sessionId: args.sessionId,
            status,
            ...patch,
            event: { kind: status, text: status === "deriving" ? `Reading ${session.domain}` : status === "building_tam" ? "Finding companies that match your buyers." : status === "sampling_contacts" ? `Found ${patch?.tamTotal?.toLocaleString() ?? "matching"} companies. Scoring fit and sizing segments.` : "Your workspace setup is ready." },
          });
        },
      });
    } catch (error) {
      const message = error instanceof ResearchFailure
        ? error.message
        : `Research for ${session.domain} failed while ${stage === "deriving" ? "deriving its ICP" : "finding the companies in its market"}. We logged it so we can fix it.`;
      const detail = error instanceof ResearchFailure ? error.detail : error instanceof Error ? error.message : String(error);
      await ctx.runMutation(internal.researchSessions.patchFromPipeline, { sessionId: args.sessionId, status: "failed", error: message, event: { kind: "failed", text: message } });
      await ctx.runMutation(internal.researchSessions.logFailure, {
        domain: session.domain, stage: error instanceof ResearchFailure ? error.stage : stage, message, detail, sessionId: args.sessionId,
      });
      return null;
    }
    return null;
  },
});

export const buildBrief = internalAction({
  args: { sessionId: v.id("researchSessions") },
  handler: async (ctx, args) => {
    if (!(await ctx.runMutation(internal.researchSessions.reserveBrief, args)))
      return null;
    try {
      const session = await ctx.runQuery(
        internal.researchSessions.getInternal,
        args,
      );
      if (!session?.companyFinding || !process.env.OPENROUTER_API_KEY)
        throw new Error("Brief research is unavailable.");
      const sources = (await websiteSources(session.domain, memoFetcher(ctx, `research:${args.sessionId}`, "onboarding_brief"))).map(
        ({ url, text }) => ({ url, text }),
      );
      const targets = buyerTargets(
        session.icp,
        session.segments ?? [],
        exampleAccounts(session.preview ?? []),
      );
      const raw = await forcedToolCall(
        briefPrompt(session.companyFinding, sources, targets),
        "onboarding_brief",
        briefToolSchema,
        DEFAULT_ICP_DERIVATION_MODEL,
        {
          provider: "openai",
          apiKey: process.env.OPENROUTER_API_KEY,
          openaiBaseUrl: OPENROUTER_API_BASE,
        },
      );
      const brief = verifyBrief(raw, sources, targets);
      await ctx.runMutation(internal.researchSessions.saveBrief, {
        ...args,
        brief,
        status: "ready",
      });
    } catch {
      await ctx.runMutation(internal.researchSessions.saveBrief, {
        ...args,
        status: "unavailable",
      });
    }
    return null;
  },
});
