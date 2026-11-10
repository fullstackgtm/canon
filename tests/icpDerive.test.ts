import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveWebsiteIcp, DEFAULT_ICP_DERIVATION_MODEL } from "../engine/src/icpDerive.ts";

test("model derivation emits a schema-bound, evidence-verified ICP", async () => {
  const progress: string[] = [];
  const modelResult = {
    companyName: "Acme",
    summary: "Acme governs AI agents working in CRM systems.",
    industries: ["B2B software"],
    employeeBands: ["201-500", "501-1000"],
    geos: ["us"],
    technologies: ["salesforce", "hubspot"],
    jobLevels: ["vp", "director"],
    departments: ["operations"],
    titleKeywords: ["revenue operations", "crm operations"],
    intentTopics: ["AI agents", "CRM governance"],
    triggerHypotheses: [{
      id: "unsafe-crm-agents", label: "AI agents are being introduced into CRM workflows",
      positiveEvidence: ["AI agents", "CRM governance"], activeProjects: ["deploy AI agents"],
      buyerFunctions: ["revenue operations"], negativeEvidence: [], preferredSources: ["job", "company"],
    }],
    confidence: 0.83,
    traceSummary: ["The offer governs AI agents in CRM systems.", "Revenue operations leaders are the named operational buyer."],
    evidence: [
      { label: "CRM surface", quote: "Govern AI agents working in Salesforce and HubSpot.", source: "homepage" },
      { label: "Buyer", quote: "Revenue operations leaders use it for CRM data quality and enrichment.", source: "llms" },
    ],
  };
  const result = await deriveWebsiteIcp({
    apiKey: "test-key",
    domain: "acme.com",
    model: DEFAULT_ICP_DERIVATION_MODEL,
    fetchPages: async (url) => url.endsWith("/llms.txt")
      ? { text: "Acme serves B2B SaaS teams. Revenue operations leaders use it for CRM data quality and enrichment.", finalUrl: url }
      : { text: "Acme. Govern AI agents working in Salesforce and HubSpot. Revenue operations without unsafe CRM writes.", finalUrl: url },
    derive: async (_prompt, model) => {
      assert.equal(model, DEFAULT_ICP_DERIVATION_MODEL);
      return modelResult;
    },
    onProgress: (event) => progress.push(event.message),
  });
  assert.equal(result.company.name, "Acme");
  assert.equal(result.derivation.model, "z-ai/glm-5.2");
  assert.ok(result.icp.firmographics.industries?.includes("B2B software"));
  assert.ok(result.icp.persona.titleKeywords?.includes("revenue operations"));
  assert.ok(result.icp.firmographics.technologies?.includes("salesforce"));
  assert.equal(result.icp.signals?.triggerHypotheses?.[0].id, "unsafe-crm-agents");
  assert.equal(result.evidence.length, 2);
  assert.equal(result.confidence, 0.83);
  assert.ok(progress.some((message) => message.includes("analyzing")));
  assert.ok(progress.some((message) => message.includes("Revenue operations leaders")));
});

test("model derivation fails loudly when evidence is not verbatim", async () => {
  const invalid = {
    companyName: "Acme", summary: "Acme", industries: [], employeeBands: [], geos: [], technologies: [],
    jobLevels: ["vp"], departments: [], titleKeywords: ["buyer"], intentTopics: [], confidence: 0.5,
    traceSummary: ["A generic buyer was inferred."],
    evidence: [
      { label: "Fake", quote: "This quote is not on the page.", source: "homepage" },
      { label: "Also fake", quote: "Neither is this fabricated evidence.", source: "homepage" },
    ],
  };
  await assert.rejects(deriveWebsiteIcp({
    apiKey: "test-key", domain: "acme.com",
    fetchPages: async (url) => ({ text: "Real website content only. This company sells a carefully described product to a clearly named buyer, with enough source text to reach the model evidence gate.", finalUrl: url }),
    derive: async () => invalid,
  }), /fewer than two website-verifiable evidence/);
});

test("investment firms derive an executable investment thesis", async () => {
  const source = "We partner with pre-seed founders building AI agents and developer infrastructure. We invest at the earliest stages.";
  const result = await deriveWebsiteIcp({
    apiKey: "test-key", domain: "fund.example",
    fetchPages: async (url) => ({ text: source, finalUrl: url }),
    derive: async () => ({
      companyName: "Example Ventures", summary: "Early-stage AI fund", motion: "investment",
      investmentStages: ["pre-seed", "seed"], fundingAmounts: ["under_1m", "1m_5m"],
      thesisKeywords: ["AI agents", "developer infrastructure"], industries: ["software"],
      employeeBands: ["1-10", "11-50"], geos: [], technologies: [], jobLevels: ["founder", "cxo"],
      departments: ["executive"], titleKeywords: ["Founder", "Co-founder", "CEO", "CTO"],
      intentTopics: ["pre-seed fundraising"], confidence: 0.9, traceSummary: ["The site explicitly describes an early-stage investment thesis."],
      evidence: [
        { label: "Stage", quote: "We partner with pre-seed founders building AI agents and developer infrastructure.", source: "homepage" },
        { label: "Timing", quote: "We invest at the earliest stages.", source: "llms" },
      ],
    }),
  });
  assert.equal(result.icp.motion, "investment");
  assert.deepEqual(result.icp.investment?.fundingAmounts, ["under_1m", "1m_5m"]);
  assert.ok(result.icp.investment?.thesisKeywords?.includes("AI agents"));
});

test("a thin homepage is derived from the key pages it links to, and a paraphrased quote gets one retry", async () => {
  // google.com's homepage is a search box: ~130 characters of text, no /llms.txt.
  const homepage = `<html><head><title>Google</title></head><body><a href="https://accounts.google.com/ServiceLogin">Sign in</a>
    <a href="/intl/en/ads/">Advertising</a> <a href="/services/">Business Solutions</a> <a href="/intl/en/policies/privacy/">Privacy</a>
    <a href="https://example.org/about">Elsewhere</a> <a href="https://google.com/">Home</a></body></html>`;
  const ads = "<title>Google Ads</title><p>Get your business in front of customers searching on Google. Reach people when they search for what you offer.</p>";
  const services = "<p>Grow your business with Google: tools for advertisers, retailers and app developers of every size.</p>";
  const fetched: string[] = [];
  const prompts: string[] = [];
  const quote = (text: string) => ({ label: "Offer", quote: text, source: "page-2" });
  const answer = (evidence: unknown[]) => ({
    companyName: "Google", summary: "Ads", industries: ["retail"], employeeBands: [], geos: [], technologies: [], jobLevels: ["vp"],
    departments: ["marketing"], titleKeywords: ["head of marketing"], intentTopics: [], confidence: 0.7, traceSummary: [], evidence,
  });
  const result = await deriveWebsiteIcp({
    apiKey: "test-key", domain: "google.com",
    fetchPages: async (url) => {
      fetched.push(url);
      if (url === "https://google.com/") return { text: homepage, finalUrl: url };
      if (url.endsWith("/intl/en/ads/")) return { text: ads, finalUrl: url };
      if (url.endsWith("/services/")) return { text: services, finalUrl: url };
      return null;
    },
    derive: async (prompt) => {
      prompts.push(prompt);
      return prompts.length === 1
        ? answer([quote("Put your business in front of searching customers."), quote("Reach people when they search for what you offer.")])
        : answer([quote("Get your business in front of customers searching on Google."), { ...quote("tools for advertisers, retailers and app developers"), source: "homepage" }]);
    },
  });
  assert.deepEqual(fetched.sort(), ["https://google.com/", "https://google.com/intl/en/ads/", "https://google.com/llms.txt", "https://google.com/services/"]);
  assert.match(prompts[0], /<source id="page-1" url="https:\/\/google.com\/services\/">/);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /Put your business in front of searching customers/);
  assert.deepEqual(result.evidence.map((e) => e.sourceUrl), ["https://google.com/intl/en/ads/", "https://google.com/services/"]);
});
