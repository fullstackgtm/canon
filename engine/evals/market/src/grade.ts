import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { computeFrontStates, extractReadableText, parseMarketConfig, validateObservationSet, type ClaimIntensity, type MarketClaim, type MarketConfig, type MarketObservation, type ObservationSet } from "../../../src/market.ts";
import type { ArtifactBundle, GoldClaim, Grade, MarketEvalScenario, Violation } from "./types.ts";

const INTENSITIES: ClaimIntensity[] = ["loud", "quiet", "absent", "unobservable"];

export function loadArtifacts(scenario: MarketEvalScenario, workdir: string, home: string): ArtifactBundle {
  const configPath = path.join(workdir, "market.config.json");
  let config: MarketConfig | null = null;
  if (existsSync(configPath)) {
    try { config = parseMarketConfig(readFileSync(configPath, "utf8")); } catch { config = null; }
  }

  const observationsPath = findObservationPath(scenario, workdir, home);
  let observations: ObservationSet | null = null;
  if (observationsPath) {
    try { observations = JSON.parse(readFileSync(observationsPath, "utf8")) as ObservationSet; } catch { observations = null; }
  }

  const reportPath = ["market-report.md", `${scenario.category}-report.md`, "report.md"].map((p) => path.join(workdir, p)).find((p) => existsSync(p));
  const reportText = reportPath ? readFileSync(reportPath, "utf8") : "";
  return {
    config,
    observations,
    reportText,
    paths: {
      ...(existsSync(configPath) ? { marketConfigPath: configPath } : {}),
      ...(observationsPath ? { observationsPath } : {}),
      ...(reportPath ? { reportPath } : {}),
    },
  };
}

function findObservationPath(scenario: MarketEvalScenario, workdir: string, home: string): string | undefined {
  const direct = ["observations.json", "observation-set.json", "market.observations.json"].map((p) => path.join(workdir, p)).find((p) => existsSync(p));
  if (direct) return direct;
  const obsDir = path.join(home, "market", scenario.category, "observations");
  try {
    const names = readdirSync(obsDir).filter((n) => n.endsWith(".json")).sort();
    return names.length ? path.join(obsDir, names[names.length - 1]) : undefined;
  } catch {
    return undefined;
  }
}

function norm(s: string): string {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function includesLoose(haystack: string, needle: string): boolean {
  const h = norm(haystack);
  const n = norm(needle);
  return !!n && h.includes(n);
}

function tokens(s: string): string[] {
  return norm(s)
    .split(" ")
    .filter((t) => t.length > 2)
    .map((t) => t.replace(/s$/, ""));
}

function conceptMatchScore(haystack: string, concept: string): number {
  if (includesLoose(haystack, concept)) return 1;
  const h = new Set(tokens(haystack));
  const c = tokens(concept);
  if (c.length === 0) return 0;
  const overlap = c.filter((t) => h.has(t)).length / c.length;
  // A concept phrase like "video clipping" vs "clips/highlights" should get
  // partial credit; one generic shared token should not map a claim by itself.
  return overlap >= 0.67 || (c.length <= 2 && overlap === 1) ? overlap : 0;
}

function f1(precision: number, recall: number): number {
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

function claimText(claim: MarketClaim): string {
  return [claim.id, claim.capability, claim.definition, claim.icp, claim.pricingStructure, ...(claim.terms ?? [])].join(" ");
}

export function mapClaims(config: MarketConfig | null, goldClaims: GoldClaim[]): Map<string, string> {
  const out = new Map<string, string>();
  if (!config) return out;
  for (const claim of config.claims) {
    const text = claimText(claim);
    let best: GoldClaim | null = null;
    let bestScore = 0;
    for (const gold of goldClaims) {
      const aliases = [gold.id, gold.capability, ...gold.aliases];
      const score = aliases.reduce((n, alias) => n + conceptMatchScore(text, alias), 0);
      if (score > bestScore) { best = gold; bestScore = score; }
    }
    if (best && bestScore > 0 && !Array.from(out.values()).includes(best.id)) out.set(claim.id, best.id);
  }
  return out;
}

function vendorMap(config: MarketConfig | null, scenario: MarketEvalScenario): Map<string, string> {
  const out = new Map<string, string>();
  if (!config) return out;
  for (const vendor of config.vendors) {
    const text = norm([vendor.id, vendor.name, vendor.urls?.home, vendor.urls?.pricing, ...(vendor.urls?.product ?? []), ...(vendor.aliases ?? [])].join(" "));
    const exact = scenario.vendors.find((v) => vendor.id === v.id || text.includes(norm(v.domain)) || text.includes(norm(v.name)) || (v.aliases ?? []).some((a) => text.includes(norm(a))));
    if (exact && !Array.from(out.values()).includes(exact.id)) out.set(vendor.id, exact.id);
  }
  return out;
}

function pageTextByVendor(scenario: MarketEvalScenario): Map<string, string> {
  const out = new Map<string, string>();
  for (const vendor of scenario.vendors) {
    const urls = [vendor.urls.home, vendor.urls.pricing, ...(vendor.urls.product ?? [])].filter(Boolean) as string[];
    out.set(vendor.id, urls.map((url) => extractReadableText(scenario.pages[url] ?? "")).join("\n"));
  }
  return out;
}

function obsKey(vendorId: string, claimId: string): string { return `${vendorId}|${claimId}`; }

function confusionMacroF1(rows: Array<{ expected: ClaimIntensity; actual: ClaimIntensity | null }>): number {
  if (rows.length === 0) return 0;
  const labels = INTENSITIES.filter((label) => rows.some((row) => row.expected === label || row.actual === label));
  const f1s = labels.map((label) => {
    let tp = 0, fp = 0, fn = 0;
    for (const row of rows) {
      if (row.expected === label && row.actual === label) tp += 1;
      else if (row.expected !== label && row.actual === label) fp += 1;
      else if (row.expected === label && row.actual !== label) fn += 1;
    }
    return f1(tp / Math.max(1, tp + fp), tp / Math.max(1, tp + fn));
  });
  return f1s.reduce((a, b) => a + b, 0) / f1s.length;
}

export function gradeScenario(scenario: MarketEvalScenario, artifacts: ArtifactBundle, arm: "raw" | "fsgtm", toolCalls: Array<{ name: string }> = []): Grade {
  const violations: Violation[] = [];
  const notes: string[] = [];
  const config = artifacts.config;
  const set = artifacts.observations;

  if (!config) violations.push({ code: "missing_artifact", detail: "Missing or invalid market.config.json" });
  if (!set) violations.push({ code: "missing_artifact", detail: "Missing or invalid observations.json / stored observation run" });
  if (!artifacts.reportText) violations.push({ code: "missing_artifact", detail: "Missing market-report.md" });
  if (arm === "fsgtm" && !toolCalls.some((c) => c.name === "fullstackgtm")) {
    violations.push({ code: "tool_misuse", detail: "fsgtm arm did not call the fullstackgtm CLI" });
  }

  const vMap = vendorMap(config, scenario);
  const cMap = mapClaims(config, scenario.goldClaims);
  const vendorRecall = vMap.size / scenario.vendors.length;
  const vendorPrecision = config ? vMap.size / Math.max(1, config.vendors.length) : 0;
  const claimRecall = new Set(cMap.values()).size / scenario.goldClaims.length;
  const claimPrecision = config ? cMap.size / Math.max(1, config.claims.length) : 0;

  if (config) {
    for (const v of config.vendors) if (!vMap.has(v.id)) violations.push({ code: "invented_vendor", detail: `Unknown or off-scenario vendor in config: ${v.id}` });
  }

  if (config && set) {
    const problems = validateObservationSet(config, set);
    for (const p of problems.slice(0, 10)) violations.push({ code: "coverage_gap", detail: p });
  }

  const actualByGold = new Map<string, MarketObservation>();
  if (set) {
    for (const obs of set.observations ?? []) {
      const gv = vMap.get(obs.vendorId);
      const gc = cMap.get(obs.claimId);
      if (gv && gc) actualByGold.set(obsKey(gv, gc), obs);
    }
  }

  const rows: Array<{ expected: ClaimIntensity; actual: ClaimIntensity | null }> = [];
  let correct = 0;
  let falseLoud = 0;
  let actualLoud = 0;
  let correctLoud = 0;
  for (const gold of scenario.goldCells) {
    const actual = actualByGold.get(obsKey(gold.vendorId, gold.claimId));
    const actualIntensity = actual?.intensity ?? null;
    rows.push({ expected: gold.intensity, actual: actualIntensity });
    if (actualIntensity === gold.intensity) correct += 1;
    else if (actualIntensity) {
      violations.push({ code: actualIntensity === "loud" ? "false_loud" : "classification_error", detail: `${gold.vendorId} × ${gold.claimId}: expected ${gold.intensity}, got ${actualIntensity}` });
    }
    if (actualIntensity === "loud") {
      actualLoud += 1;
      if (gold.intensity === "loud") correctLoud += 1;
      else falseLoud += 1;
    }
  }

  const classificationAccuracy = correct / Math.max(1, scenario.goldCells.length);
  const macroF1 = confusionMacroF1(rows);
  const loudPrecision = actualLoud === 0 ? 0 : correctLoud / actualLoud;
  const falseLoudRate = falseLoud / Math.max(1, scenario.goldCells.length);

  const pages = pageTextByVendor(scenario);
  let evidenceTotal = 0;
  let evidenceOk = 0;
  if (set) {
    for (const obs of set.observations ?? []) {
      if (obs.intensity !== "loud" && obs.intensity !== "quiet") continue;
      const gv = vMap.get(obs.vendorId);
      const pageText = gv ? pages.get(gv) ?? "" : "";
      const evs = obs.evidence ?? [];
      if (evs.length === 0) {
        evidenceTotal += 1;
        violations.push({ code: "bad_evidence", detail: `${obs.vendorId} × ${obs.claimId}: non-absent observation has no evidence` });
        continue;
      }
      for (const ev of evs) {
        evidenceTotal += 1;
        if (includesLoose(pageText, ev.text)) evidenceOk += 1;
        else violations.push({ code: "bad_evidence", detail: `${obs.vendorId} × ${obs.claimId}: quote not found in frozen source text: ${String(ev.text).slice(0, 80)}` });
      }
    }
  }
  const evidenceVerificationRate = evidenceTotal === 0 ? 0 : evidenceOk / evidenceTotal;

  let reportBonus = 0;
  if (artifacts.reportText && config && set) {
    const fronts = computeFrontStates(config, set);
    if (fronts.some((f) => artifacts.reportText.toLowerCase().includes(f.state))) reportBonus = 1;
  }

  const quality =
    15 * ((vendorRecall + vendorPrecision) / 2) +
    25 * ((claimRecall + claimPrecision) / 2) +
    40 * macroF1 +
    15 * evidenceVerificationRate +
    5 * reportBonus;
  const taskScore = Math.round(Math.max(0, Math.min(100, quality)) * 10) / 10;

  const hardGatePass = !!config && !!set && !!artifacts.reportText && vendorRecall === 1 && vendorPrecision === 1 && evidenceVerificationRate === 1 && !violations.some((v) => ["missing_artifact", "invalid_config", "invented_vendor", "coverage_gap", "bad_evidence", "tool_misuse"].includes(v.code));
  if (!hardGatePass) notes.push("One or more hard gates failed; quality score is still shown for diagnosis.");

  return {
    taskScore,
    maxScore: 100,
    violations,
    notes,
    metrics: { hardGatePass, vendorRecall, vendorPrecision, claimRecall, claimPrecision, classificationAccuracy, macroF1, loudPrecision, falseLoudRate, evidenceVerificationRate, cellsEvaluated: scenario.goldCells.length },
  };
}
