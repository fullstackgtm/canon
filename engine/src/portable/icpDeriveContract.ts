import { parseIcp, type Icp } from "../icp.ts";

export type WebsiteIcpEvidence = { label: string; excerpt: string; sourceUrl: string };
/** One page of the company's own site the model reads: the homepage, /llms.txt, or a linked key page. */
export type WebsiteSource = { id: string; url: string; text: string };

/** The model's quotes matched fewer than two sources verbatim; `rejected` are the ones that didn't match. */
export class IcpEvidenceError extends Error {
  readonly verified: number;
  readonly rejected: string[];
  constructor(verified: number, rejected: string[]) {
    super("icp derive: model returned fewer than two website-verifiable evidence quotes.");
    this.verified = verified;
    this.rejected = rejected;
  }
}
export type WebsiteIcpDerivation = {
  company: { name: string; domain: string; summary: string };
  icp: Icp;
  evidence: WebsiteIcpEvidence[];
  confidence: number;
  derivation: { mode: "model"; model: string };
};

export const WEBSITE_ICP_DERIVE_SCHEMA = {
  type: "object",
  required: ["companyName", "summary", "motion", "investmentStages", "fundingAmounts", "thesisKeywords", "industries", "employeeBands", "geos", "technologies", "jobLevels", "departments", "titleKeywords", "intentTopics", "triggerHypotheses", "confidence", "traceSummary", "evidence"],
  properties: {
    companyName: { type: "string" }, summary: { type: "string" },
    motion: { type: "string", enum: ["sales", "investment"], description: "Use investment for VC, PE, accelerators, and funds sourcing companies to invest in." },
    investmentStages: { type: "array", description: "Stages of TARGET COMPANIES when this fund invests. Never infer later stages from the fund's own fund number, AUM, or portfolio companies' current maturity.", items: { type: "string", enum: ["pre-seed", "seed", "series-a", "series-b", "growth", "bootstrapped"] } },
    fundingAmounts: { type: "array", description: "TOTAL FUNDING ALREADY RAISED BY TARGET COMPANIES before this investment. This is not fund size, AUM, check size, or capital deployed. A fund being $250M must never produce 100m_250m here. Use unknown when the website does not support a target-company range.", items: { type: "string", enum: ["under_1m", "1m_5m", "5m_10m", "10m_25m", "25m_50m", "50m_100m", "100m_250m", "over_250m", "unknown"] } },
    thesisKeywords: { type: "array", items: { type: "string" }, description: "Concrete keywords expected in an investment target company's description." },
    industries: { type: "array", items: { type: "string" } },
    employeeBands: { type: "array", items: { type: "string", enum: ["1-10", "11-50", "51-200", "201-500", "501-1000", "1001-5000", "5001-10000", "10001+"] } },
    geos: { type: "array", items: { type: "string" } }, technologies: { type: "array", items: { type: "string" } },
    jobLevels: { type: "array", items: { type: "string", enum: ["cxo", "vp", "director", "head", "manager", "owner", "founder", "senior"] } },
    departments: { type: "array", items: { type: "string" } },
    titleKeywords: { type: "array", items: { type: "string" } }, intentTopics: { type: "array", items: { type: "string" } },
    triggerHypotheses: { type: "array", maxItems: 5, description: "Observable, testable public behaviors that indicate timing or pain at a target account. Prefer concrete projects, operating changes, and role responsibilities over demographics.", items: {
      type: "object", required: ["id", "label", "positiveEvidence", "activeProjects", "buyerFunctions", "negativeEvidence", "preferredSources"], properties: {
        id: { type: "string" }, label: { type: "string" },
        positiveEvidence: { type: "array", items: { type: "string" } },
        activeProjects: { type: "array", items: { type: "string" } },
        buyerFunctions: { type: "array", items: { type: "string" } },
        negativeEvidence: { type: "array", items: { type: "string" } },
        preferredSources: { type: "array", items: { type: "string", enum: ["job", "news", "company", "social", "review", "legal"] } },
      },
    } },
    confidence: { type: "number" },
    traceSummary: { type: "array", items: { type: "string" }, description: "2-5 concise, user-facing observations that explain which offer, account, and buyer signals drove the ICP. Do not reveal hidden chain-of-thought." },
    evidence: { type: "array", items: { type: "object", required: ["label", "quote", "source"], properties: {
      label: { type: "string" }, quote: { type: "string" }, source: { type: "string", description: "The id of the <source> the quote is copied from." },
    } } },
  },
} as const;

function strings(value: unknown, max = 10): string[] {
  return [...new Set((Array.isArray(value) ? value : []).filter((item): item is string => typeof item === "string")
    .map((item) => item.trim()).filter(Boolean))].slice(0, max);
}

/** Whitespace, case and typographic quotes and dashes don't make a quote unverifiable; any other change does. */
function normalized(value: string): string {
  return value.replace(/[\u2018\u2019\u201b\u2032]/g, "'").replace(/[\u201c\u201d\u201f\u2033]/g, '"').replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...").replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeTriggerHypotheses(value: unknown): NonNullable<Icp["signals"]>["triggerHypotheses"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const label = typeof row.label === "string" ? row.label.replace(/\s+/g, " ").trim().slice(0, 160) : "";
    const positiveEvidence = strings(row.positiveEvidence, 12);
    const activeProjects = strings(row.activeProjects, 10);
    if (!label || (!positiveEvidence.length && !activeProjects.length)) return [];
    const idRaw = typeof row.id === "string" ? row.id : label;
    const id = idRaw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || `trigger-${index + 1}`;
    const allowed = new Set(["job", "news", "company", "social", "review", "legal"]);
    const preferredSources = strings(row.preferredSources, 6).filter((source) => allowed.has(source)) as Array<"job" | "news" | "company" | "social" | "review" | "legal">;
    return [{ id, label, positiveEvidence, activeProjects, buyerFunctions: strings(row.buyerFunctions, 10),
      negativeEvidence: strings(row.negativeEvidence, 10), preferredSources }];
  }).slice(0, 5);
}

export { buildWebsiteIcpPrompt, buildWebsiteIcpRepairPrompt } from "./websiteIcpPrompt.ts";

export function normalizeWebsiteIcpModelResult(args: {
  domain: string;
  sources: WebsiteSource[];
  raw: Record<string, unknown>;
  model: string;
}): WebsiteIcpDerivation {
  const { raw } = args;
  const companyName = typeof raw.companyName === "string" ? raw.companyName.trim().slice(0, 100) : args.domain;
  const motion = raw.motion === "investment" ? "investment" : "sales";
  const icp = parseIcp(JSON.stringify({ name: `Website-derived ICP for ${companyName}`, motion,
    ...(motion === "investment" ? { investment: { stages: strings(raw.investmentStages, 6), fundingAmounts: strings(raw.fundingAmounts, 9), thesisKeywords: strings(raw.thesisKeywords, 12) } } : {}), firmographics: {
    industries: strings(raw.industries, 6), employeeBands: strings(raw.employeeBands, 8),
    geos: strings(raw.geos, 8).map((value) => value.toLowerCase()), technologies: strings(raw.technologies, 8).map((value) => value.toLowerCase()),
  }, persona: { jobLevels: strings(raw.jobLevels, 8), departments: strings(raw.departments, 8).map((value) => value.toLowerCase()),
    titleKeywords: strings(raw.titleKeywords, 10) }, signals: { intentTopics: strings(raw.intentTopics, 10), triggerHypotheses: normalizeTriggerHypotheses(raw.triggerHypotheses) }, scoring: { threshold: 0.6 } }));
  const evidence: WebsiteIcpEvidence[] = [];
  const rejected: string[] = [];
  const haystacks = args.sources.map((source) => ({ ...source, text: normalized(source.text) }));
  for (const item of Array.isArray(raw.evidence) ? raw.evidence : []) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const quote = typeof row.quote === "string" ? row.quote.replace(/\s+/g, " ").trim() : "";
    if (!quote) continue;
    // The named source first; a quote filed under the wrong id is still on the site.
    const needle = normalized(quote);
    const found = quote.length >= 12
      ? [...haystacks].sort((a, b) => Number(b.id === row.source) - Number(a.id === row.source)).find((source) => source.text.includes(needle))
      : undefined;
    if (!found) { rejected.push(quote); continue; }
    evidence.push({ label: typeof row.label === "string" ? row.label.slice(0, 80) : "Website evidence", excerpt: quote.slice(0, 320), sourceUrl: found.url });
  }
  if (evidence.length < 2) throw new IcpEvidenceError(evidence.length, rejected);
  const confidence = typeof raw.confidence === "number" ? Math.max(0, Math.min(1, raw.confidence)) : 0.5;
  return { company: { name: companyName, domain: args.domain, summary: typeof raw.summary === "string" ? raw.summary.slice(0, 400) : "" },
    icp, evidence: evidence.slice(0, 6), confidence, derivation: { mode: "model", model: args.model } };
}

export function websiteIcpTraceSummaries(raw: Record<string, unknown>): string[] {
  return strings(raw.traceSummary, 5);
}
