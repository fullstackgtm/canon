/**
 * Minimal TypeSafe (Jev) client for the default Convex runtime (fetch only).
 * Onboarding makes a handful of requests per domain, so there is no pacing;
 * 429 and 5xx are retried with backoff. The key is never logged.
 */
import type { JevAsk } from "./marketSegments";

export const JEV_MODEL = "jev-1.13.0"; // pinned: thresholds are tuned per version

/**
 * Jev rejects "invalid Unicode text". Truncated site text can end in half of a
 * surrogate pair (emoji), and scraped pages carry control characters.
 */
export function cleanForJev(value: unknown): unknown {
  if (typeof value === "string") {
    // Lone surrogates -> U+FFFD (String.prototype.toWellFormed, without relying on the lib target).
    const wellFormed = value.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
    return wellFormed.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ");
  }
  if (Array.isArray(value)) return value.map(cleanForJev);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cleanForJev(v)]));
  return value;
}

/** Any System One question (https://docs.typesafe.ai/api). */
export type SystemOneQuestion =
  | { type: "noul"; instructions: unknown; criteria?: { true?: unknown; false?: unknown } }
  | { type: "choice"; instructions: unknown; criteria: Record<string, unknown> };
export type SystemOneAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number };
export type SystemOneResponse = { model: string; answers: Record<string, SystemOneAnswer>; usage?: { input_tokens: number; output_tokens: number } };

/** One systemOne request with typed answers and token usage. */
export async function jevSystemOne(
  apiKey: string,
  state: unknown,
  questions: Record<string, SystemOneQuestion>,
  opts: { fetch?: typeof fetch; model?: string } = {},
): Promise<SystemOneResponse> {
  const f = opts.fetch ?? fetch;
  const body = JSON.stringify(cleanForJev({ model: opts.model ?? JEV_MODEL, state, questions }));
  for (let attempt = 0; ; attempt++) {
    const res = await f("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body,
    });
    if (res.ok) return (await res.json()) as SystemOneResponse;
    if (!(res.status === 429 || res.status >= 500) || attempt >= 3) {
      throw new Error(`jev ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const ra = Number(res.headers.get("retry-after"));
    await new Promise((r) => setTimeout(r, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 500 * 2 ** attempt));
  }
}

export function jevAsk(apiKey: string, opts: { fetch?: typeof fetch; model?: string } = {}): JevAsk {
  return async (state, questions) => {
    const json = await jevSystemOne(apiKey, state, questions, opts);
    return Object.fromEntries(Object.entries(json.answers).map(([k, a]) => [k, "noul" in a ? a.noul : 0]));
  };
}
