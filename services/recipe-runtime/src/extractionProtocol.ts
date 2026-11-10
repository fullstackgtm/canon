import type { ExtractRequest } from "./extraction.ts";

export const CLAIRIC_MODEL = "@cf/cloudflare/clairic";
export const EXTRACT_STATE_MAX = 24_000;
export const EXTRACT_BODY_MAX = 160_000;
export const EXTRACT_TIMEOUT_MS = 20_000;
export function clairicInput(body: ExtractRequest) {
  return {
    model: "clairic", state: body.state,
    fields: {
      value: { type: body.answerType, instructions: `Subject: ${body.subject}\nQuestion: ${body.question}\nUse only the source text. Return null when unstated. Never guess.` },
      evidence: { type: "text", instructions: `Copy one complete passage from the source text that states the answer to "${body.question}" about ${body.subject}. Return null when unstated.` },
    },
  };
}
