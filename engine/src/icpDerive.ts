import { DEFAULT_MODELS, forcedToolCall, type LlmCallOptions } from "./llm.ts";
import { publicHttpGet } from "./publicHttp.ts";
import type { Icp } from "./icp.ts";
import {
  buildWebsiteIcpPrompt,
  buildWebsiteIcpRepairPrompt,
  IcpEvidenceError,
  normalizeWebsiteIcpModelResult,
  WEBSITE_ICP_DERIVE_SCHEMA,
  websiteIcpTraceSummaries,
  type WebsiteIcpDerivation,
  type WebsiteSource,
} from "./portable/icpDeriveContract.ts";

export type { WebsiteIcpDerivation, WebsiteIcpEvidence, WebsiteSource } from "./portable/icpDeriveContract.ts";
export { IcpEvidenceError } from "./portable/icpDeriveContract.ts";

export const DEFAULT_ICP_DERIVATION_MODEL = "z-ai/glm-5.2";
export const OPENROUTER_API_BASE = "https://openrouter.ai/api";

export type IcpDerivationProgress = {
  stage: "fetch" | "model" | "verify";
  message: string;
};

export { normalizeCompanyWebsite, websiteText, websiteMeta, keyPageLinks, MIN_SOURCE_CHARS } from "../../modules/kernel/websiteSources.ts";
import { normalizeCompanyWebsite, websiteText, websiteMeta, keyPageLinks, MIN_SOURCE_CHARS, PAGE_CHARS } from "../../modules/kernel/websiteSources.ts";

async function fetchPublicText(url: string): Promise<{ text: string; finalUrl: string } | null> {
  try {
    // Modern marketing homepages often exceed 1 MB of markup (linear.app is ~1.3 MB);
    // over the cap the request is aborted, so keep it well above that. Only the
    // first 28k characters of extracted text are used.
    const response = await publicHttpGet(url, { timeoutMs: 12_000, maxRedirects: 4, maxBytes: 4_000_000,
      headers: { "User-Agent": "fullstackgtm-icp-derive/1 (+https://github.com/fullstackgtm/core)" } });
    if (response.status < 200 || response.status >= 300) return null;
    return { text: new TextDecoder().decode(response.body), finalUrl: response.finalUrl };
  } catch { return null; }
}

export async function websiteSources(domain: string, fetchPage = fetchPublicText, onProgress?: (event: IcpDerivationProgress) => void): Promise<WebsiteSource[]> {
  const target = normalizeCompanyWebsite(domain);
  onProgress?.({ stage: "fetch", message: `Resolving and fetching ${target.url}` });
  const homepage = await fetchPage(target.url);
  if (!homepage) throw new Error(`icp derive: could not read ${target.domain}. Check the domain and try again.`);
  const homepageText = [websiteMeta(homepage.text), websiteText(homepage.text)].filter(Boolean).join(" ").slice(0, 28_000);
  onProgress?.({ stage: "fetch", message: `Fetched ${homepage.finalUrl} · extracted ${homepageText.length.toLocaleString("en-US")} readable characters` });
  const llmsUrl = new URL("/llms.txt", homepage.finalUrl).toString();
  const linked = keyPageLinks(homepage.text, homepage.finalUrl, target.domain);
  onProgress?.({ stage: "fetch", message: `Checking ${llmsUrl}${linked.length ? ` and ${linked.length} linked page${linked.length === 1 ? "" : "s"} (${linked.join(", ")})` : ""}` });
  const [llms, ...pages] = await Promise.all([fetchPage(llmsUrl), ...linked.map((url) => fetchPage(url).catch(() => null))]);
  // A site without /llms.txt often serves its HTML 404 page with a 200; only plain text counts.
  const llmsText = llms && !/^\s*</.test(llms.text) ? llms.text.slice(0, 28_000) : "";
  const sources: WebsiteSource[] = [{ id: "homepage", url: homepage.finalUrl, text: homepageText }];
  if (llmsText) sources.push({ id: "llms", url: llmsUrl, text: llmsText });
  pages.forEach((page, index) => {
    const text = page ? [websiteMeta(page.text), websiteText(page.text)].filter(Boolean).join(" ").slice(0, PAGE_CHARS) : "";
    if (text.length >= 80) sources.push({ id: `page-${index + 1}`, url: page!.finalUrl, text });
  });
  const totalChars = sources.reduce((sum, source) => sum + source.text.length, 0);
  onProgress?.({ stage: "fetch", message: `Read ${sources.length} source${sources.length === 1 ? "" : "s"} · ${totalChars.toLocaleString("en-US")} characters` });
  if (totalChars < MIN_SOURCE_CHARS) {
    throw new Error(`icp derive: ${target.domain} exposed too little readable content (${totalChars} characters across ${sources.length} page${sources.length === 1 ? "" : "s"}).`);
  }
  return sources;
}

export async function deriveWebsiteIcp(args: {
  domain: string;
  apiKey?: string;
  llm?: LlmCallOptions;
  model?: string;
  fetchPages?: (url: string) => Promise<{ text: string; finalUrl: string } | null>;
  derive?: (prompt: string, model: string) => Promise<Record<string, unknown>>;
  onProgress?: (event: IcpDerivationProgress) => void;
}): Promise<WebsiteIcpDerivation> {
  const target = normalizeCompanyWebsite(args.domain);
  const sources = await websiteSources(args.domain, args.fetchPages, args.onProgress);
  const totalChars = sources.reduce((sum, source) => sum + source.text.length, 0);
  const llm = args.llm ?? (args.apiKey ? { provider: "openai" as const, apiKey: args.apiKey, openaiBaseUrl: OPENROUTER_API_BASE } : undefined);
  if (!llm) throw new Error("icp derive: no LLM credential was provided.");
  const isOpenRouter = llm.provider === "openai" && llm.openaiBaseUrl?.startsWith(OPENROUTER_API_BASE);
  const model = args.model ?? llm.model ?? (isOpenRouter ? DEFAULT_ICP_DERIVATION_MODEL : DEFAULT_MODELS[llm.provider]);
  args.onProgress?.({ stage: "model", message: `Submitting ${totalChars.toLocaleString("en-US")} characters to ${model} with the structured ICP schema` });
  args.onProgress?.({ stage: "model", message: `${model} is analyzing offers, target accounts, buyer roles, timing signals, and exact supporting quotes` });
  const prompt = buildWebsiteIcpPrompt({ domain: target.domain, sources });
  const ask = async (text: string) => {
    const raw = args.derive
      ? await args.derive(text, model)
      : await forcedToolCall(text, "derive_website_icp", WEBSITE_ICP_DERIVE_SCHEMA, model, {
        ...llm,
        model,
        ...(isOpenRouter ? {
          onReasoningSummary: (summary: string) => args.onProgress?.({ stage: "model", message: `${model} reasoning summary: ${summary.slice(0, 240)}` }),
          onReasoningPhase: (phase: string) => args.onProgress?.({ stage: "model", message: `${model}: ${phase}` }),
        } : {}),
      }) as Record<string, unknown>;
    for (const summary of websiteIcpTraceSummaries(raw)) {
      args.onProgress?.({ stage: "model", message: `${model}: ${summary.slice(0, 220)}` });
    }
    return normalizeWebsiteIcpModelResult({ domain: target.domain, sources, raw, model });
  };
  let result: WebsiteIcpDerivation;
  try {
    result = await ask(prompt);
  } catch (error) {
    // Models paraphrase quotes now and then; one retry that names the failed quotes usually fixes it.
    if (!(error instanceof IcpEvidenceError)) throw error;
    args.onProgress?.({ stage: "verify", message: `${error.verified} quote${error.verified === 1 ? "" : "s"} matched the site; asking ${model} again for exact quotes` });
    result = await ask(buildWebsiteIcpRepairPrompt(prompt, error.rejected));
  }
  args.onProgress?.({ stage: "verify", message: `Verified ${result.evidence.length} verbatim evidence quotes against fetched source text` });
  return result;
}

export type IcpReviewSegment = { id: string; label: string; value: string; kind: "list" | "number" };
export function icpReviewSegments(icp: Icp): IcpReviewSegment[] {
  const list = (value: string[] | undefined) => value?.join(", ") || "—";
  return [
    ...(icp.motion === "investment" ? [
      { id: "investmentStages", label: "Investment stage", value: list(icp.investment?.stages), kind: "list" as const },
      { id: "fundingAmounts", label: "Funding bands", value: list(icp.investment?.fundingAmounts), kind: "list" as const },
      { id: "thesisKeywords", label: "Thesis keywords", value: list(icp.investment?.thesisKeywords), kind: "list" as const },
    ] : []),
    { id: "industries", label: "Industries", value: list(icp.firmographics.industries), kind: "list" },
    { id: "employeeBands", label: "Company size", value: list(icp.firmographics.employeeBands), kind: "list" },
    { id: "geos", label: "Geography", value: list(icp.firmographics.geos), kind: "list" },
    { id: "technologies", label: "Technologies", value: list(icp.firmographics.technologies), kind: "list" },
    { id: "titleKeywords", label: "Buyer titles", value: list(icp.persona.titleKeywords), kind: "list" },
    { id: "jobLevels", label: "Seniority", value: list(icp.persona.jobLevels), kind: "list" },
    { id: "departments", label: "Departments", value: list(icp.persona.departments), kind: "list" },
    { id: "intentTopics", label: "Why now", value: list(icp.signals?.intentTopics), kind: "list" },
    { id: "triggerHypotheses", label: "Behavioral triggers", value: list(icp.signals?.triggerHypotheses?.map((item) => item.label)), kind: "list" },
    { id: "threshold", label: "Fit threshold", value: String(icp.scoring?.threshold ?? 0.6), kind: "number" },
  ];
}
