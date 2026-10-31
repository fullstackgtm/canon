import { v } from "convex/values";
import { coerceAnswer, locateQuote, UNKNOWN, type AgentSpec, type FetchedPage, type Finding, type Subject } from "./agentLoop.ts";
import { canonicalJson } from "../artifactVersioning.ts";

export const piFinding = v.union(
  v.object({ status: v.literal("answered"), value: v.string(), quote: v.string(), sourceUrl: v.string(), confidence: v.number() }),
  v.object({ status: v.literal("unknown"), reason: v.string() }),
  v.object({ status: v.literal("no_evidence"), reason: v.string() }),
  v.object({ status: v.literal("error"), reason: v.string() }),
);
export type PiFinding = typeof piFinding.type;
export type PiRecord = { stepId: string; spec: AgentSpec; subject: Subject };
export type PiNext = { kind: "record"; record: PiRecord } | { kind: "advance"; finished: boolean; completed: number };
export type PiLanding = { finished: boolean; completed: number };
export type PiRead = { page: FetchedPage | null };

export function piEligible(run: { runtime?: string; trigger?: string; onCredits?: boolean }, spec: AgentSpec): boolean {
  return run.runtime === "pi" && !run.trigger && !run.onCredits && spec.entityType !== "contact" && spec.kind === "qa" && (spec.answerType ?? "text") === "text" && !spec.judgment;
}

export function piVerifiedFinding(spec: AgentSpec, raw: PiFinding, canonServedPages: readonly FetchedPage[]): Finding | { status: "error"; reason: string } {
  if (raw.status !== "answered") return { status: raw.status, reason: raw.reason.slice(0, 200) };
  const value = coerceAnswer(spec, raw.value);
  const page = locateQuote(raw.quote, canonServedPages, raw.sourceUrl);
  if (!page || value === null || value === UNKNOWN || typeof value !== "string" || value.length > 4000 || !Number.isFinite(raw.confidence)) {
    return { status: "no_evidence", reason: "Canon could not verify the answer against a page served to this step." };
  }
  return { status: "answered", value, quote: raw.quote.slice(0, 4000), sourceUrl: page.url, confidence: Math.max(0, Math.min(1, raw.confidence)), ...(page.snippet ? { snippet: true } : {}) };
}

export function piContextStamp(loaded: { spec: AgentSpec | null; agent: { updatedAt: number } | null; principals: unknown; standing: unknown }): string {
  return canonicalJson(JSON.parse(JSON.stringify([loaded.spec, loaded.agent?.updatedAt, loaded.principals, loaded.standing])));
}

export const piSpecJson = (spec: AgentSpec) => canonicalJson(JSON.parse(JSON.stringify(spec)));
