import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { extractReadableText, observationId, type MarketConfig, type ObservationSet } from "../../../src/market.ts";
import { marketMapToMarkdown } from "../../../src/marketReport.ts";
import { runAnthropicAgent, runOpenAICompatAgent, resolveProvider } from "./agent.ts";
import { getScenario } from "./fixtures/scenarios.ts";
import { gradeScenario, loadArtifacts } from "./grade.ts";
import { createExecutor, preloadCaptures, toolsForArm } from "./tools.ts";
import type { AgentLoopResult, Arm, RunResult, TranscriptEvent } from "./types.ts";

const BASE_SYSTEM =
  "You are a market-intelligence analyst creating a strategic market map. " +
  "Use only the frozen source pages exposed by tools. The benchmark grader reads final files and tool logs, not your self-report. " +
  "Evidence discipline matters: quote source text verbatim for every loud/quiet reading. " +
  "You are rewarded for valid artifacts and compact, discriminating claims, not for verbose taxonomies.";

const ARM_NOTES: Record<Arm, string> = {
  raw:
    "\n\nRAW ARM: you do not have the fullstackgtm CLI. Build the market map yourself from source pages and write the required files directly.",
  fsgtm:
    "\n\nFSGTM ARM: the fullstackgtm CLI is available and should be used. Start with `market schema` if you need the exact artifact shape. Write market.config.json using the exact MarketConfig schema from the user prompt, use `market worksheet` and/or `market hints --json` to inspect captured pages, candidate support snippets, and the loud/quiet/absent/unobservable rubric. Hints are retrieval support, not labels; judge whether the quote actually supports the claim. Use `market observe-template` when a config already exists, then fill the template, run `market review --from observations.json`, submit with `market observe`, and use `market fronts`/`market report` for deterministic outputs. If the CLI rejects a file, fix the schema and retry. Do not call nested LLM classification; you are filling observations.",
};

export type TaskMode = "create" | "classify";
export type RunOptions = { transcriptDir?: string; artifactDir?: string; trial?: number; keepWorkdir?: boolean; taskMode?: TaskMode };

export async function runOne(scenarioId: string, modelSpec: string, arm: Arm, options: RunOptions = {}): Promise<RunResult> {
  const scenario = getScenario(scenarioId);
  const tmp = await mkdtemp(path.join(os.tmpdir(), "market-eval-"));
  const home = path.join(tmp, "home");
  const workdir = path.join(tmp, "work");
  await mkdir(home, { recursive: true });
  await mkdir(workdir, { recursive: true });
  await preloadCaptures(scenario, home);
  const taskMode = options.taskMode ?? "create";
  if (taskMode === "classify") {
    await writeFile(path.join(workdir, "market.config.json"), JSON.stringify(goldConfig(scenarioId), null, 2) + "\n");
  }

  const execute = createExecutor(scenario, { workdir, home });
  const transcript: TranscriptEvent[] = [];
  const started = Date.now();
  let loop: AgentLoopResult = { turns: 0, toolCalls: 0, toolErrors: 0, inputTokens: 0, outputTokens: 0, finalText: "" };
  let runError: string | undefined;

  try {
    const provider = resolveProvider(modelSpec);
    if (provider.kind === "fixture") {
      loop = await runFixtureAgent(provider.mode, scenarioId, arm, execute, transcript);
    } else {
      const opts = {
        model: provider.model,
        system: BASE_SYSTEM + ARM_NOTES[arm],
        prompt: taskMode === "classify" ? classificationPrompt(scenario.prompt, arm) : scenario.prompt,
        tools: toolsForArm(arm),
        execute,
        maxTurns: scenario.maxTurns ?? 48,
        onEvent: (event: TranscriptEvent) => transcript.push(event),
      };
      loop = provider.kind === "anthropic" ? await runAnthropicAgent(opts) : await runOpenAICompatAgent(provider.endpoint, opts);
    }
  } catch (error) {
    runError = error instanceof Error ? error.message : String(error);
  }

  const artifacts = loadArtifacts(scenario, workdir, home);
  const grade = gradeScenario(scenario, artifacts, arm, transcript.filter((e): e is Extract<TranscriptEvent, { type: "tool_call" }> => e.type === "tool_call"));

  let transcriptPath: string | undefined;
  if (options.transcriptDir && transcript.length > 0) {
    await mkdir(options.transcriptDir, { recursive: true });
    const safeModel = modelSpec.replace(/[^a-zA-Z0-9.-]+/g, "_");
    transcriptPath = path.join(options.transcriptDir, `${scenario.id}--${safeModel}--${arm}${options.trial ? `--t${options.trial}` : ""}.json`);
    await writeFile(transcriptPath, JSON.stringify({ scenario: scenario.id, model: modelSpec, arm, trial: options.trial, events: transcript }, null, 2));
  }

  const preserved = options.artifactDir ? await preserveArtifacts(artifacts.paths, options.artifactDir, scenario.id, modelSpec, arm, options.trial) : { paths: artifacts.paths, artifactDir: undefined };
  const artifactWorkdir = options.keepWorkdir ? workdir : "";
  const result: RunResult = {
    scenario: scenario.id,
    model: modelSpec,
    arm,
    ...(options.trial ? { trial: options.trial } : {}),
    ...(transcriptPath ? { transcriptPath } : {}),
    ...grade,
    turns: loop.turns,
    toolCalls: loop.toolCalls,
    toolErrors: loop.toolErrors,
    inputTokens: loop.inputTokens,
    outputTokens: loop.outputTokens,
    costUsd: estimateCostUsd(modelSpec, loop.inputTokens, loop.outputTokens),
    durationMs: Date.now() - started,
    finalText: loop.finalText,
    artifacts: { workdir: artifactWorkdir, ...preserved.paths, ...(preserved.artifactDir ? { artifactDir: preserved.artifactDir } : {}) },
    ...(runError ? { error: runError } : {}),
  };

  if (!options.keepWorkdir) await rm(tmp, { recursive: true, force: true });
  return result;
}

const PRICE_PER_TOKEN: Record<string, { input: number; output: number }> = {
  "openrouter/deepseek/deepseek-v4-pro": { input: 0.000000435, output: 0.00000087 },
  "openrouter/z-ai/glm-5.2": { input: 0.00000091, output: 0.00000286 },
  "openrouter/qwen/qwen3.5-397b-a17b": { input: 0.000000385, output: 0.00000245 },
  "openrouter/moonshotai/kimi-k2.6": { input: 0.00000066, output: 0.00000341 },
};

function estimateCostUsd(modelSpec: string, inputTokens: number, outputTokens: number): number {
  const price = PRICE_PER_TOKEN[modelSpec];
  if (!price) return 0;
  return Math.round((inputTokens * price.input + outputTokens * price.output) * 1_000_000) / 1_000_000;
}

async function preserveArtifacts(
  paths: { marketConfigPath?: string; observationsPath?: string; reportPath?: string },
  root: string,
  scenarioId: string,
  modelSpec: string,
  arm: Arm,
  trial?: number,
): Promise<{ paths: typeof paths; artifactDir?: string }> {
  const safeModel = modelSpec.replace(/[^a-zA-Z0-9.-]+/g, "_");
  const dir = path.join(root, `${scenarioId}--${safeModel}--${arm}${trial ? `--t${trial}` : ""}`);
  await mkdir(dir, { recursive: true });
  const copied: typeof paths = {};
  for (const [key, src] of Object.entries(paths) as Array<[keyof typeof paths, string | undefined]>) {
    if (!src) continue;
    const dest = path.join(dir, path.basename(src));
    try {
      await copyFile(src, dest);
      copied[key] = dest;
    } catch {
      // If an artifact vanished between grading and preservation, leave it absent.
    }
  }
  await writeFile(path.join(dir, "artifact-index.json"), `${JSON.stringify(copied, null, 2)}\n`);
  return { paths: copied, artifactDir: dir };
}

function goldConfig(scenarioId: string): MarketConfig {
  const scenario = getScenario(scenarioId);
  return {
    category: scenario.category,
    anchorVendor: scenario.vendors[0]?.id,
    vendors: scenario.vendors.map((vendor) => ({
      id: vendor.id,
      name: vendor.name,
      urls: { home: vendor.urls.home, pricing: vendor.urls.pricing ?? null, product: vendor.urls.product ?? [] },
      aliases: vendor.aliases,
    })),
    claims: scenario.goldClaims.map((claim) => ({
      id: claim.id,
      capability: claim.capability,
      icp: "category buyer",
      pricingStructure: "unknown",
      definition: claim.definition,
      terms: claim.aliases,
    })),
    surfaceRule: "LOUD = hero/primary positioning or a named/dedicated product area; QUIET = supported but secondary/qualified/merely available; ABSENT = no support in usable captures; UNOBSERVABLE = no usable capture for the vendor.",
  };
}

function classificationPrompt(basePrompt: string, arm: Arm): string {
  const extra =
    "\n\nFIXED-TAXONOMY CLASSIFICATION TASK: market.config.json already exists in the working directory and is the fixed taxonomy. Do not change vendor ids or claim ids. Your job is to classify every vendor × claim cell from the frozen source pages, produce observations.json for run-1, and produce market-report.md. Use absent for unsupported claims when vendor pages were captured; use unobservable only for vendors with no usable captured pages.";
  const fsgtmExtra =
    "\n\nRecommended CLI path: run `fullstackgtm market observe-template --out observations.json`, inspect `fullstackgtm market hints --json` and/or per-vendor worksheets, fill observations.json, run `fullstackgtm market review --from observations.json`, fix errors/warnings you agree with, then `fullstackgtm market observe --from observations.json` and `fullstackgtm market report --format md --out market-report.md`.";
  return basePrompt + extra + (arm === "fsgtm" ? fsgtmExtra : "");
}

async function runFixtureAgent(mode: string, scenarioId: string, arm: Arm, execute: (name: string, input: any) => Promise<string>, transcript: TranscriptEvent[]): Promise<AgentLoopResult> {
  const scenario = getScenario(scenarioId);
  const config = fixtureConfig(scenarioId, mode);
  const observations = fixtureObservations(scenarioId, config, mode);
  const report = mode === "sloppy" ? "# Thin market report\n\nNo fronts computed.\n" : marketMapToMarkdown(config, observations);
  let toolCalls = 0;
  async function call(name: string, input: any) {
    toolCalls += 1;
    transcript.push({ type: "tool_call", turn: 1, name, input });
    const output = await execute(name, input);
    transcript.push({ type: "tool_result", turn: 1, name, output: output.slice(0, 4000) });
    return output;
  }
  await call("write_file", { path: "market.config.json", content: JSON.stringify(config, null, 2) + "\n" });
  await call("write_file", { path: "observations.json", content: JSON.stringify(observations, null, 2) + "\n" });
  if (arm === "fsgtm") {
    await call("fullstackgtm", { args: "market observe --from observations.json" });
    await call("fullstackgtm", { args: "market report --format md --out market-report.md" });
  } else {
    await call("write_file", { path: "market-report.md", content: report });
  }
  return { turns: 1, toolCalls, toolErrors: 0, inputTokens: 0, outputTokens: 0, finalText: `fixture ${mode}` };
}

function fixtureConfig(scenarioId: string, mode: string): MarketConfig {
  const scenario = getScenario(scenarioId);
  const claims = scenario.goldClaims.map((claim) => ({ id: claim.id, capability: claim.capability, icp: "category buyer", pricingStructure: "unknown", definition: claim.definition, terms: claim.aliases }));
  const vendors = scenario.vendors.map((vendor) => ({ id: vendor.id, name: vendor.name, urls: { home: vendor.urls.home, pricing: vendor.urls.pricing ?? null, product: vendor.urls.product ?? [] }, aliases: vendor.aliases }));
  const cfg: MarketConfig = { category: scenario.category, anchorVendor: vendors[0]?.id, vendors, claims, surfaceRule: "LOUD = hero/primary positioning; QUIET = mentioned but secondary; ABSENT = no support; UNOBSERVABLE = no readable capture." };
  if (mode === "sloppy") cfg.claims = cfg.claims.slice(0, Math.max(1, cfg.claims.length - 2));
  return cfg;
}

function fixtureObservations(scenarioId: string, config: MarketConfig, mode: string): ObservationSet {
  const scenario = getScenario(scenarioId);
  const cells = scenario.goldCells.filter((cell) => config.claims.some((c) => c.id === cell.claimId));
  return {
    id: `set_${scenario.id}_run1`,
    category: scenario.category,
    runLabel: "run-1",
    runAt: "2026-06-11T00:00:00.000Z",
    extractor: mode === "sloppy" ? "fixture:sloppy" : "fixture:perfect",
    observations: cells.map((cell) => {
      const intensity = mode === "sloppy" && cell.intensity === "loud" ? "absent" : cell.intensity;
      const quote = intensity === "loud" || intensity === "quiet" ? cell.evidence?.[0] : undefined;
      const found = quote ? findQuote(scenarioId, cell.vendorId, quote) : null;
      return {
        id: observationId(scenario.category, "run-1", cell.vendorId, cell.claimId),
        vendorId: cell.vendorId,
        claimId: cell.claimId,
        observedAt: "2026-06-11",
        intensity,
        confidence: "high" as const,
        reason: intensity === cell.intensity ? `Gold fixture: ${intensity}.` : "Sloppy fixture intentionally wrong.",
        evidence: quote && found
          ? [{ id: `ev_${cell.vendorId}_${cell.claimId}`, sourceSystem: "web", sourceObjectType: "page", sourceObjectId: found.url, text: quote, metadata: { url: found.url, captureHash: found.captureHash } }]
          : [],
      };
    }),
  };
}

function findQuote(scenarioId: string, vendorId: string, quote: string): { url: string; captureHash: string } | null {
  const scenario = getScenario(scenarioId);
  const vendor = scenario.vendors.find((v) => v.id === vendorId);
  if (!vendor) return null;
  const urls = [vendor.urls.home, vendor.urls.pricing, ...(vendor.urls.product ?? [])].filter(Boolean) as string[];
  for (const url of urls) {
    const text = extractReadableText(scenario.pages[url] ?? "");
    if (text.toLowerCase().replace(/\s+/g, " ").includes(quote.toLowerCase().replace(/\s+/g, " "))) {
      return { url, captureHash: createHash("sha256").update(text).digest("hex") };
    }
  }
  return null;
}
