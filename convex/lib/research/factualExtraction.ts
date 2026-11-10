import { CLAIRIC_MODEL, EXTRACT_TIMEOUT_MS, clairicInput, extractRequest, extractResult, type ExtractResult } from "../../../services/recipe-runtime/src/extraction.ts";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, sign } from "../../../services/recipe-runtime/src/protocol.ts";
import { pageAllowances, type AgentSpec, type FetchedPage, type Subject } from "./agentLoop.ts";

export type FactualCandidate = { kind: "declined" } | { kind: "found"; value: string | number; quote: string; sourceUrl: string; confidence: number };
export type FactualExtractor = (spec: AgentSpec, subject: Subject, pages: readonly FetchedPage[]) => Promise<FactualCandidate>;

/** Ranges count Unicode code points, as Clairic does. */
export function extractionState(pages: readonly FetchedPage[]) {
  const allowances = pageAllowances(pages.map((p) => p.text.length + 2));
  let state = "";
  const ranges = pages.map((page, i) => {
    const text = page.text.slice(0, Math.max(0, allowances[i] - 2));
    state += "\n\n";
    const start = Array.from(state).length;
    state += text;
    const end = Array.from(state).length;
    return { page, start, end };
  });
  return { state, ranges };
}

export function candidateFromResult(out: ExtractResult, source: ReturnType<typeof extractionState>): FactualCandidate {
  if (out.kind === "declined") return out;
  const points = Array.from(source.state);
  const [start, end] = out.evidenceSpan;
  const range = source.ranges.find((r) => start >= r.start && end <= r.end && end > start);
  if (!range || points.slice(start, end).join("") !== out.evidence) return { kind: "declined" };
  if (typeof out.value === "string") {
    if (!out.valueSpan) throw new Error("Clairic returned text without a span");
    const [from, to] = out.valueSpan;
    if (from < start || to > end || to <= from || points.slice(from, to).join("") !== out.value) return { kind: "declined" };
  } else {
    if (out.valueSpan) throw new Error("Clairic returned a numeric text span");
    const numbers = out.evidence.matchAll(/(?<![\p{L}\p{N}_.])[+-]?(?:\d{1,3}(?:,\d{3})+|\d+|\.\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?(?![\p{L}\p{N}_,]|\.\d)/gu);
    if (!Array.from(numbers).some(([literal]) => Number(literal.replaceAll(",", "")) === out.value)) return { kind: "declined" };
  }
  return { kind: "found", value: out.value, quote: out.evidence, sourceUrl: range.page.url, confidence: out.confidence };
}

export function runtimeExtractor(options: { signal?: AbortSignal; chargeBeforeDispatch: (prompt: string) => void; fetchImpl?: typeof fetch; url?: string; secret?: string }): FactualExtractor {
  const url = options.url ?? process.env.RECIPE_RUNTIME_URL;
  const secret = options.secret ?? process.env.RECIPE_RUNTIME_SECRET;
  if (!url || !secret) throw new Error("Clairic factual fields require RECIPE_RUNTIME_URL and RECIPE_RUNTIME_SECRET");
  return async (spec, subject, pages) => {
    options.signal?.throwIfAborted();
    const source = extractionState(pages);
    const request = extractRequest.parse({
      op: "extract", state: source.state,
      subject: `${subject.name} (${subject.domain})${subject.person ? `; person ${subject.person.name}${subject.person.title ? `, ${subject.person.title}` : ""}` : ""}`,
      question: spec.question, answerType: spec.answerType ?? "text",
    });
    const body = JSON.stringify(request);
    const timestamp = String(Date.now());
    const signature = await sign(secret, timestamp, body);
    options.signal?.throwIfAborted();
    options.chargeBeforeDispatch(JSON.stringify(clairicInput(request)));
    const signal = AbortSignal.any([AbortSignal.timeout(EXTRACT_TIMEOUT_MS), ...(options.signal ? [options.signal] : [])]);
    try {
      const res = await (options.fetchImpl ?? fetch)(new URL("/extract", url), {
        method: "POST", body, signal,
        headers: { "content-type": "application/json", [TIMESTAMP_HEADER]: timestamp, [SIGNATURE_HEADER]: signature },
      });
      if (!res.ok) throw new Error("provider failed");
      const out = extractResult.safeParse(await res.json());
      if (!out.success || (out.data.kind === "found" && typeof out.data.value !== (request.answerType === "text" ? "string" : "number"))) throw new Error("invalid response");
      signal.throwIfAborted();
      return candidateFromResult(out.data, source);
    } catch {
      throw new Error(signal.aborted ? "Clairic extraction stopped or timed out" : "Clairic extraction failed");
    }
  };
}

export const factualModel = (navigatorModel: string) => `${CLAIRIC_MODEL}; navigator=${navigatorModel}`;
