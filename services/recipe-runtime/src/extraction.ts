import { z } from "zod";
import { CLAIRIC_MODEL, EXTRACT_STATE_MAX, EXTRACT_TIMEOUT_MS, clairicInput } from "./extractionProtocol.ts";
export { CLAIRIC_MODEL, EXTRACT_STATE_MAX, EXTRACT_BODY_MAX, EXTRACT_TIMEOUT_MS, clairicInput } from "./extractionProtocol.ts";

export const extractRequest = z.object({
  op: z.literal("extract"),
  state: z.string().min(1).max(EXTRACT_STATE_MAX),
  subject: z.string().min(1).max(1000),
  question: z.string().min(1).max(1000),
  answerType: z.enum(["text", "number"]),
}).strict();
export type ExtractRequest = z.infer<typeof extractRequest>;

const span = z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]);
const probability = z.number().min(0).max(1);
const common = { confidence: probability, p_null: probability };
const textAnswer = z.object({ ...common, type: z.literal("text"), value: z.string().max(1000).nullable(), span: span.nullish() });
const numberAnswer = z.object({ ...common, type: z.literal("number"), value: z.number().finite().nullable() });
const providerResult = z.object({
  model: z.literal("clairic"), truncated: z.literal(false),
  answers: z.object({ value: z.union([textAnswer, numberAnswer]), evidence: textAnswer }),
});
export const extractResult = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("declined") }).strict(),
  z.object({ kind: z.literal("found"), value: z.union([z.string().min(1).max(500), z.number().finite()]), evidence: z.string().min(1).max(1000), evidenceSpan: span, valueSpan: span.optional(), confidence: probability }).strict(),
]);
export type ExtractResult = z.infer<typeof extractResult>;

/** The AI binding returns the result itself, without the REST API envelope. */
export function parseClairic(raw: unknown, answerType: ExtractRequest["answerType"]): ExtractResult {
  const parsed = providerResult.safeParse(raw);
  if (!parsed.success) throw new Error("Invalid Clairic response");
  const { value, evidence } = parsed.data.answers;
  if (value.type !== answerType) throw new Error("Invalid Clairic answer type");
  if (value.value === null || evidence.value === null) return { kind: "declined" };
  if (!evidence.span || (value.type === "text" && !value.span)) throw new Error("Missing Clairic evidence span");
  const out = extractResult.safeParse({
    kind: "found", value: value.value, evidence: evidence.value, evidenceSpan: evidence.span,
    ...(value.type === "text" ? { valueSpan: value.span } : {}), confidence: value.confidence,
  });
  if (!out.success) throw new Error("Invalid Clairic candidate");
  return out.data;
}

export type ExtractionAI = { run(model: typeof CLAIRIC_MODEL, input: ReturnType<typeof clairicInput>): Promise<unknown> };

export async function extract(text: string, ai: ExtractionAI | undefined): Promise<Response> {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return Response.json({ error: "Invalid extraction request" }, { status: 400 }); }
  const body = extractRequest.safeParse(raw);
  if (!body.success) return Response.json({ error: "Invalid extraction request" }, { status: 400 });
  if (!ai) return Response.json({ error: "Clairic binding unavailable" }, { status: 503 });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      ai.run(CLAIRIC_MODEL, clairicInput(body.data)),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), EXTRACT_TIMEOUT_MS); }),
    ]);
    return Response.json(parseClairic(result, body.data.answerType));
  } catch {
    return Response.json({ error: "Clairic extraction failed" }, { status: 502 });
  } finally { clearTimeout(timer); }
}
