import type { MarketConfig, ObservationSet } from "../../../src/market.ts";

export const TODAY = "2026-06-11";

export type Arm = "raw" | "fsgtm";

export type Violation = {
  code:
    | "missing_artifact"
    | "invalid_config"
    | "invented_vendor"
    | "coverage_gap"
    | "bad_evidence"
    | "false_loud"
    | "classification_error"
    | "tool_misuse"
    | string;
  detail: string;
};

export type MarketEvalVendor = {
  id: string;
  name: string;
  domain: string;
  urls: { home: string; pricing?: string | null; product?: string[] };
  aliases?: string[];
};

export type GoldClaim = {
  id: string;
  capability: string;
  aliases: string[];
  definition: string;
};

export type GoldCell = {
  vendorId: string;
  claimId: string;
  intensity: "loud" | "quiet" | "absent" | "unobservable";
  /** One or more verbatim snippets that support non-absent labels. */
  evidence?: string[];
};

export type MarketEvalScenario = {
  id: string;
  title: string;
  category: string;
  prompt: string;
  vendors: MarketEvalVendor[];
  pages: Record<string, string>;
  goldClaims: GoldClaim[];
  goldCells: GoldCell[];
  maxTurns?: number;
};

export type Grade = {
  taskScore: number;
  maxScore: number;
  violations: Violation[];
  notes: string[];
  metrics: {
    hardGatePass: boolean;
    vendorRecall: number;
    vendorPrecision: number;
    claimRecall: number;
    claimPrecision: number;
    classificationAccuracy: number;
    macroF1: number;
    loudPrecision: number;
    falseLoudRate: number;
    evidenceVerificationRate: number;
    cellsEvaluated: number;
  };
};

export type RunResult = Grade & {
  scenario: string;
  model: string;
  arm: Arm;
  trial?: number;
  transcriptPath?: string;
  turns: number;
  toolCalls: number;
  toolErrors: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  finalText: string;
  artifacts: {
    workdir: string;
    marketConfigPath?: string;
    observationsPath?: string;
    reportPath?: string;
    artifactDir?: string;
  };
  error?: string;
};

export type ArtifactBundle = {
  config: MarketConfig | null;
  observations: ObservationSet | null;
  reportText: string;
  paths: { marketConfigPath?: string; observationsPath?: string; reportPath?: string };
};

export type ToolDef = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export type ToolExecutor = (name: string, input: unknown) => Promise<string>;

export type TranscriptEvent =
  | { type: "assistant"; turn: number; text: string }
  | { type: "tool_call"; turn: number; name: string; input: unknown }
  | { type: "tool_result"; turn: number; name: string; output: string };

export type AgentLoopOptions = {
  model: string;
  system: string;
  prompt: string;
  tools: ToolDef[];
  execute: ToolExecutor;
  maxTurns: number;
  onEvent?: (event: TranscriptEvent) => void;
};

export type AgentLoopResult = {
  turns: number;
  toolCalls: number;
  toolErrors: number;
  inputTokens: number;
  outputTokens: number;
  finalText: string;
};
