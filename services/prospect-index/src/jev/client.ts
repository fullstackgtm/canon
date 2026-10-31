// Minimal TypeSafe (Jev) client: POST /v1/systemone with typed questions.
// Paces requests under the account limits (40 req/s, 100K input tokens/s),
// retries 429/5xx with backoff (honoring retry-after), and records usage.
// The key comes from JEV_API_KEY or ~/.fullstackgtm/jev.key; it is never logged.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Noul = { type: "noul"; instructions: unknown; criteria?: { true?: unknown; false?: unknown } };
export type Choice = { type: "choice"; instructions: unknown; criteria: Record<string, unknown> };
export type Score = { type: "score"; instructions: unknown; criteria: unknown[] };
export type Question = Noul | Choice | Score;

export type NoulAnswer = { type: "noul"; noul: number };
export type ChoiceAnswer = { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> };
export type Answer = NoulAnswer | ChoiceAnswer | { type: "score"; score: number; confidence: number };

export const MODEL = process.env.JEV_MODEL ?? "jev-1.13.0"; // pinned: thresholds are tuned per version

function apiKey() {
  if (process.env.JEV_API_KEY) return process.env.JEV_API_KEY;
  return readFileSync(join(homedir(), ".fullstackgtm", "jev.key"), "utf8").trim();
}

export const usage = { requests: 0, inputTokens: 0, retries: 0 };

// Token-bucket pacing for both limits. Defaults stay under the published caps.
const RPS = Number(process.env.JEV_RPS ?? 35);
const TPS = Number(process.env.JEV_TPS ?? 90_000);
let reqTokens = RPS, tokTokens = TPS, last = Date.now();
async function pace(estTokens: number) {
  for (;;) {
    const now = Date.now();
    const dt = (now - last) / 1000;
    last = now;
    reqTokens = Math.min(RPS, reqTokens + dt * RPS);
    tokTokens = Math.min(TPS, tokTokens + dt * TPS);
    if (reqTokens >= 1 && tokTokens >= Math.min(estTokens, TPS)) {
      reqTokens -= 1;
      tokTokens -= estTokens;
      return;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Jev rejects "invalid Unicode text". Truncating text can split a surrogate
 * pair (emoji), and scraped pages carry control characters; clean every string.
 */
export function cleanForJev(value: unknown): unknown {
  if (typeof value === "string") return value.toWellFormed().replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ");
  if (Array.isArray(value)) return value.map(cleanForJev);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cleanForJev(v)]));
  return value;
}

export async function systemOne(state: unknown, questions: Record<string, Question>, estTokens = 2000) {
  const key = apiKey();
  const body = JSON.stringify(cleanForJev({ model: MODEL, state, questions }));
  for (let attempt = 0; ; attempt++) {
    await pace(estTokens);
    const res = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body,
    });
    if (res.ok) {
      const json = (await res.json()) as { answers: Record<string, Answer>; usage?: { input_tokens: number }; model: string };
      usage.requests++;
      usage.inputTokens += json.usage?.input_tokens ?? 0;
      return json;
    }
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= 6) {
      throw new Error(`jev ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    usage.retries++;
    const ra = Number(res.headers.get("retry-after"));
    await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(30_000, 500 * 2 ** attempt));
  }
}

/** Cost in USD at the published $0.042 per million input tokens (output is free). */
export const costUsd = (inputTokens: number) => (inputTokens / 1e6) * 0.042;
