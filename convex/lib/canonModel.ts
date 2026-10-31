import { integrationEnabled } from "./integrationsAvailable.ts";
import type { LlmCallOptions } from "../../engine/src/llm.ts";

/**
 * Canon's own research model: a cheap open model on OpenRouter, for research a person starts without a
 * ChatGPT plan connected. Canon pays for it, so such a run spends credits (docs/credits.md CR4). gpt-oss-120b
 * answered 7 of 8 sites at about $0.0003 a record (2026-10-13), well under a credit's $0.01.
 */
export const CANON_RESEARCH_MODEL = "openai/gpt-oss-120b";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/** The model's call options, or null when the deployment has no OpenRouter key. */
export function canonResearchLlm(): LlmCallOptions | null {
  const apiKey = process.env.OPENROUTER_API_KEY;
  return integrationEnabled("openrouter") ? { provider: "openai", apiKey: apiKey!, openaiBaseUrl: OPENROUTER_URL, model: process.env.CANON_RESEARCH_MODEL || CANON_RESEARCH_MODEL } : null;
}
