// ─────────────────────────────────────────────────────────────────────────
// HOSTED-APP CLI. This drives the Next.js/Convex application (operating
// model, agent control plane). The engine CLI is scripts/fullstackgtm.ts
// (→ engine/src/cli.ts).
// ─────────────────────────────────────────────────────────────────────────
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";
import type { Id } from "../convex/_generated/dataModel.js";
import {
  currentMonthRange,
  currentQuarterRange,
} from "../src/lib/periods.ts";
import { getGtmOperatingModel } from "../src/lib/gtm-operating-model.ts";
import { getGtmSurfaceManifest, gtmSurfaceRequirements } from "../src/lib/gtm-surface-manifest.ts";
import { gtmErrorEnvelope, gtmExitCodes, type GtmErrorCode } from "../src/lib/gtm-error-envelope.ts";
import { getGtmMutationReference, gtmMutationNames, gtmMutationSurfaceManifest } from "../src/lib/gtm-mutation-registry.ts";
import { gtmHumanOnlyFunctions } from "../src/lib/gtm-human-only-mutations.ts";
import { gtmParityBaseline } from "../src/lib/gtm-parity-baseline.ts";

type OutputMode = "table" | "json";

const exitCodes = gtmExitCodes;

const cliEnvVars = [
  { name: "NEXT_PUBLIC_CONVEX_URL", required: true, description: "Convex deployment URL for CLI queries and mutations." },
  { name: "FSGTM_AUTH_TOKEN", required: false, description: "Bearer token for authenticated Convex deployments." },
  { name: "FSGTM_SMOKE_BYPASS_TOKEN", required: false, description: "Local/prod-like smoke-test bypass token." },
  { name: "NEXT_PUBLIC_SITE_URL", required: false, description: "Default site URL for UI/API smoke commands." },
  { name: "FSGTM_ENABLE_DEMO_DATA", required: false, description: "Enables local demo-data paths when configured on the backend." },
] as const;

const commandSummaries = [
  ["summary", "Show operating summary"],
  ["deals", "List or update deals"],
  ["abm", "List or generate ABM target-account lists"],
  ["leads", "List or generate lead scores and routing rules"],
  ["health", "List or generate customer health scores"],
  ["competitive", "List or generate competitive intel"],
  ["research", "List or generate account research enrichments"],
  ["icp", "List or generate ICP profiles and scores"],
  ["forecasting", "Show forecast rollups"],
  ["pipeline", "Show open pipeline"],
  ["team", "Show team roster"],
  ["integrations", "Show CRM connection status"],
  ["calls", "List call-intelligence recordings and insights"],
  ["settings", "Show organization defaults"],
  ["auth", "Inspect CLI authentication status"],
  ["find", "Run canonical gtm.find"],
  ["set", "Run canonical gtm.set; dry-run unless --apply"],
  ["do", "Run canonical gtm.do; dry-run unless --apply"],
  ["parse", "Run canonical gtm.parse; dry-run unless --apply"],
  ["patch-plans", "Review durable patch plans"],
  ["mutation", "Echo (unvalidated preview) or apply an allowlisted dashboard mutation"],
  ["describe", "Describe canonical operations"],
  ["operating-model", "Show GTM primitive registry"],
  ["mvp-audit", "Audit MVP module readiness"],
  ["interaction-audit", "Audit dashboard/API/CLI/MCP write parity"],
  ["cli-smoke", "Smoke-test CLI read commands"],
  ["ui-smoke", "Smoke-test dashboard routes"],
  ["api-smoke", "Smoke-test API routes"],
  ["mcp-smoke", "Smoke-test MCP tools"],
  ["seed-demo", "Seed local/demo workspace"],
  ["capabilities", "Print machine-readable CLI contract"],
  ["surface", "Print API/CLI/MCP surface manifest"],
  ["robot-docs", "Print paste-ready agent guide"],
  ["doctor", "Diagnose local CLI/API/MCP readiness"],
] as const;

const commandNames = commandSummaries.map(([name]) => name);

const globalCommandOptions = [
  { name: "--json", description: "Print parseable JSON to stdout." },
  { name: "--help", description: "Print command help; combine with --json for machine-readable help." },
] as const;

const commandHelpOverrides: Record<string, {
  usage?: string;
  options?: Array<{ name: string; description: string; required?: boolean }>;
  examples?: string[];
  mutates?: boolean;
  dryRunDefault?: boolean;
}> = {
  find: {
    usage: "npm run gtm -- find --resource <name> --args '<json>' --json",
    options: [
      { name: "--resource <name>", description: "Canonical resource to query.", required: true },
      { name: "--args <json>", description: "Resource arguments as a JSON object." },
    ],
    examples: ["npm run gtm -- find --resource deals --args '{}' --json"],
  },
  set: {
    usage: "npm run gtm -- set --operation <name> --args '<json>' [--apply] --json",
    options: [
      { name: "--operation <name>", description: "Canonical set operation to preview or apply.", required: true },
      { name: "--args <json>", description: "Operation arguments as a JSON object.", required: true },
      { name: "--apply", description: "Apply the operation; omitted means dry-run preview." },
    ],
    mutates: true,
    dryRunDefault: true,
    examples: ["npm run gtm -- set --operation updateDealForecast --args '{\"dealId\":\"...\",\"forecastCategory\":\"commit\"}' --json"],
  },
  do: {
    usage: "npm run gtm -- do --action <name> --args '<json>' [--apply] --json",
    options: [
      { name: "--action <name>", description: "Canonical action to preview or apply.", required: true },
      { name: "--args <json>", description: "Action arguments as a JSON object.", required: true },
      { name: "--apply", description: "Apply the action; omitted means dry-run preview." },
    ],
    mutates: true,
    dryRunDefault: true,
  },
  parse: {
    usage: "npm run gtm -- parse --input-type <name> --input '<json>' [--apply] --json",
    options: [
      { name: "--input-type <name>", description: "Parser input type.", required: true },
      { name: "--input <json>", description: "Parser input payload.", required: true },
      { name: "--apply", description: "Apply generated patch plan; omitted means dry-run preview." },
    ],
    mutates: true,
    dryRunDefault: true,
  },
  mutation: {
    usage: "npm run gtm -- mutation --name <api.module.mutation> --args '<json>' [--apply] --json",
    options: [
      { name: "--name <mutation>", description: "Allowlisted mutation name from the dashboard interaction registry.", required: true },
      { name: "--args <json>", description: "Mutation arguments as a JSON object." },
      { name: "--apply", description: "Apply the mutation; omitted means an unvalidated echo preview." },
    ],
    mutates: true,
    // Deliberately NOT dryRunDefault: the non-apply mode is an unvalidated
    // echo, not a typed dry-run preview.
    dryRunDefault: false,
    examples: ["npm run gtm -- mutation --name api.patchPlans.approve --args '{\"patchPlanId\":\"...\",\"decision\":\"approved\"}' --json"],
  },
  "patch-plans": {
    usage: "npm run gtm -- patch-plans [--patch-plan <id>] [--approve|--reject|--apply] --json",
    options: [
      { name: "--patch-plan <id>", description: "Inspect or act on a specific patch plan." },
      { name: "--approve", description: "Approve the selected patch plan." },
      { name: "--reject", description: "Reject the selected patch plan." },
      { name: "--apply", description: "Apply an already-approved patch plan." },
    ],
    mutates: true,
    dryRunDefault: true,
  },
  doctor: {
    usage: "npm run gtm -- doctor [--fix] --json",
    options: [{ name: "--fix", description: "Attempt safe local fixes when available; otherwise include exact remediation commands." }],
    examples: ["npm run gtm -- doctor --json"],
  },
  surface: {
    usage: "npm run gtm -- surface --json",
    examples: ["npm run gtm -- surface --json | jq '.surfaces[] | select(.cli|length==0)'"],
  },
  capabilities: {
    usage: "npm run gtm -- capabilities --json",
    examples: ["npm run gtm -- capabilities --json"],
  },
  "robot-docs": {
    usage: "npm run gtm -- robot-docs guide",
    examples: ["npm run gtm -- robot-docs guide"],
  },
  auth: {
    usage: "npm run gtm -- auth status --json",
    examples: ["npm run gtm -- auth status --json"],
  },
  calls: {
    usage: "npm run gtm -- calls [--call <id>|--analyze|--ingest|--propose-next-step] [--apply] --json",
    options: [
      { name: "--call <id>", description: "Inspect or mutate one call recording." },
      { name: "--analyze", description: "Analyze a call; requires --call and --apply to mutate." },
      { name: "--ingest", description: "Ingest a transcript; requires --title plus --transcript-text or --transcript-file and --apply to mutate." },
      { name: "--demo", description: "Ingest and analyze demo call data; requires --apply to mutate." },
      { name: "--propose-next-step", description: "Create a deal next-step patch plan from a call insight; requires --insight and --apply." },
    ],
    mutates: true,
    dryRunDefault: true,
    examples: ["npm run gtm -- calls --json", "npm run gtm -- calls --analyze --call <callId> --json"],
  },
};

function commandHelpPayload(command: string) {
  const summary = commandSummaries.find(([name]) => name === command);
  if (!summary) return null;
  const override = commandHelpOverrides[command] ?? {};
  return {
    ok: true,
    command,
    description: summary[1],
    usage: override.usage ?? `npm run gtm -- ${command} [options]`,
    mutates: Boolean(override.mutates),
    dryRunDefault: Boolean(override.dryRunDefault),
    options: [...globalCommandOptions, ...(override.options ?? [])],
    examples: override.examples ?? [`npm run gtm -- ${command} --json`],
    related: {
      capabilities: "npm run gtm -- capabilities --json",
      doctor: "npm run gtm -- doctor --json",
      surface: "npm run gtm -- surface --json",
    },
  };
}

function loadLocalEnv() {
  const envPath = resolve(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return;

  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

function smokeBypassToken() {
  return (
    process.env.FSGTM_SMOKE_BYPASS_TOKEN ??
    process.env.FSGTM_UI_SMOKE_BYPASS_TOKEN
  );
}

function applySmokeBypassHeaders(headers: Record<string, string>) {
  const token = smokeBypassToken();
  if (!token) return;
  headers["x-fsgtm-smoke-bypass"] = token;
  headers["x-fsgtm-ui-smoke"] = token;
}

function usage() {
  return `CanonCRM CLI

Usage:
  npm run gtm -- <command> [options]

Commands:
  summary           Show operating summary from the dashboard model
  deals             List CRM-inherited deals
  abm               List or generate ABM target-account lists
  leads             List or generate lead scores and routing rules
  health            List or generate customer health scores
  competitive       List or generate competitive intel
  research          List or generate account research enrichments
  icp               List or generate ICP profiles and scores
  forecasting       Show forecast rollups and rep coverage
  pipeline          Show open pipeline by forecast category
  team              Show team roster and operating coverage
  integrations      Show CRM connection and sync run status
  calls             List call-intelligence recordings and insights
  settings          Show organization operating defaults
  auth              Inspect CLI authentication status
  find              Run a canonical gtm.find resource query (--resource <name> --args '{...}')
  set               Run a canonical gtm.set operation (--operation <name> --args '{...}' --apply)
  do                Run a canonical gtm.do action (--action <name> --args '{...}' --apply)
  parse             Run a canonical gtm.parse operation (--input-type <name> --input '{...}' --apply)
  patch-plans       List, inspect, approve, reject, or apply patch plans
  mutation          Echo (unvalidated preview) or apply an allowlisted dashboard mutation
  describe          Show canonical find/set/do/parse operation registry
  operating-model   Show canonical GTM primitives, source-of-record policy, and CRM storage guidance
  mvp-audit         Check every MVP module for data, shared UI, defaults, and coverage
  interaction-audit Check dashboard write interactions for API/CLI/MCP parity
  cli-smoke         Smoke-test non-mutating GTM CLI read commands
  ui-smoke          Smoke-test GTM dashboard routes against a running site
  api-smoke         Smoke-test non-mutating GTM API routes against a running site
  mcp-smoke         Smoke-test non-mutating MCP read tools over stdio
  seed-demo         Seed the local/demo workspace when dev seeding is enabled
  capabilities      Print machine-readable CLI contract and exit-code dictionary
  surface           Print API/CLI/MCP parity manifest
  robot-docs        Print paste-ready guide for coding agents
  doctor            Diagnose env, Convex, auth, and surface-readiness issues

Options:
  --json            Print raw JSON
  --fix             For doctor, apply safe local fixes when available
  --no-color        Disable ANSI styling (also honored via NO_COLOR/CI/non-TTY)
  --resource <name> For find, choose the canonical resource
  --operation <name> For set, choose the canonical operation
  --action <name>   For do, choose the canonical action
  --args <json>     For find/set/do, pass operation arguments
  --input-type <name> For parse, choose the parser input type
  --input <json>    For parse, pass parser input
  --patch-plan <id> For patch-plans, inspect/approve/reject/apply a patch plan
  --apply           For set/do/parse or patch-plans, apply instead of dry-run preview
  --approve         For patch-plans, approve the selected patch plan
  --reject          For patch-plans, reject the selected patch plan
  --strict          For mvp-audit, exit nonzero if any module or gate is not ready
  --seed-demo       For mvp-audit, try seeding the demo workspace first
  --site-url <url>  For ui-smoke/api-smoke, set the site URL to test
  --timeout-ms <n>  For smoke commands, set per-check timeout
  --deal <id>       For deals, update a deal forecast category
  --list <id>       For ABM, show accounts and plays for a specific list id
  --model <id>      For leads, filter scores to a specific model id
  --competitor <id> For competitive, filter battlecards to a competitor id
  --account <id>    For research, show enrichment for a CRM account id
  --profile <id>    For ICP, filter scores to a profile id
  --user <id>       For team, update a team member
  --name <value>    For save/create/update commands, set the object name
  --title <value>   For team, update a team member title
  --manager <id>    For team, update a manager
  --active <bool>   For team, update active status
  --forecast-category <value> For deals, set omit/pipeline/best_case/commit/closed_won/closed_lost
  --currency <code> For settings, update default currency
  --timezone <tz>   For settings, update organization timezone
  --sync-schedule <value> For settings, set daily/weekly/monthly
  --hierarchy-source <value> For settings, set salesforce/hubspot/csv/manual
  --fiscal-start <n> For settings, set fiscal year start month
  --health <status> For health, filter scores by healthy, at_risk, or churning
  --generate        Generate CRM-derived defaults where supported
  --clear-manager   Clear manager with team --user <id>
  --call <id>       For calls, inspect one call recording

Auth:
  Uses NEXT_PUBLIC_CONVEX_URL from env or .env.local.
  Set FSGTM_AUTH_TOKEN to query authenticated deployments.
  Set FSGTM_SMOKE_BYPASS_TOKEN for local prod-like smoke checks.`;
}

function client() {
  loadLocalEnv();
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) {
    throw new Error("NEXT_PUBLIC_CONVEX_URL is required in env or .env.local");
  }

  const convex = new ConvexHttpClient(url);
  const token = process.env.FSGTM_AUTH_TOKEN;
  if (token) convex.setAuth(token);
  return convex;
}

function isLocalUrl(value: string | undefined) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "::1"
    );
  } catch {
    return false;
  }
}

function runtimeContext() {
  loadLocalEnv();
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL ?? "";
  const hasAuthToken = Boolean(process.env.FSGTM_AUTH_TOKEN);
  const hasClerkPublicKey = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
  const clerkIssuer = process.env.CLERK_JWT_ISSUER_DOMAIN ?? "";
  const isLocalConvex = isLocalUrl(convexUrl);
  const demoDataEnabled = process.env.FSGTM_ENABLE_DEMO_DATA === "true";
  const isDevBypassCandidate =
    demoDataEnabled ||
    !hasClerkPublicKey &&
      (!clerkIssuer || clerkIssuer === "https://dev-placeholder.clerk.accounts.dev");

  const warnings: string[] = [];
  if (!hasAuthToken && hasClerkPublicKey && !isLocalConvex) {
    warnings.push(
      "FSGTM_AUTH_TOKEN is not set. Authenticated cloud deployments will return empty data to the CLI even when production data exists.",
    );
  }
  if (isLocalConvex && !isDevBypassCandidate && !hasAuthToken) {
    warnings.push(
      "Local Convex is configured with Clerk auth and no FSGTM_AUTH_TOKEN. Either use auth-bypass demo settings or pass a token.",
    );
  }

  return {
    convexTarget: isLocalConvex ? "local" : convexUrl ? "cloud" : "missing",
    convexUrl,
    siteUrl: process.env.NEXT_PUBLIC_SITE_URL ?? "",
    authToken: hasAuthToken ? "set" : "missing",
    clerkPublicKey: hasClerkPublicKey ? "set" : "missing",
    clerkIssuer: clerkIssuer || null,
    demoDataEnabled,
    devBypassCandidate: isDevBypassCandidate,
    warnings,
  };
}

function mode(args: string[]): OutputMode {
  return args.includes("--json") ? "json" : "table";
}

function option(args: string[], name: string) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}

function printJson(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}

function printCommandHelp(command: string, args: string[]) {
  const payload = commandHelpPayload(command);
  if (!payload) return false;
  if (mode(args) === "json") {
    printJson(payload);
    return true;
  }
  console.log(`${payload.description}\n`);
  console.log(`Usage:\n  ${payload.usage}\n`);
  console.log("Options:");
  for (const option of payload.options) {
    console.log(`  ${option.name.padEnd(24)} ${option.description}`);
  }
  console.log("\nExamples:");
  for (const example of payload.examples) console.log(`  ${example}`);
  return true;
}

function wantsCommandHelp(args: string[]) {
  return args.slice(1).some((arg) => arg === "--help" || arg === "-h");
}

function packageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
    return String(pkg.version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
}

function commandRecords() {
  return commandSummaries.map(([name, description]) => ({
    name,
    description,
    json: true,
    dryRunDefault: ["set", "do", "parse"].includes(name),
  }));
}

function levenshtein(a: string, b: string) {
  const dp = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) dp[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
}

function suggestCommand(command: string) {
  if (!command) return null;
  const normalized = command.toLowerCase();
  const ranked = commandNames
    .map((candidate) => ({ candidate, distance: levenshtein(normalized, candidate) }))
    .sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate));
  return ranked[0] && ranked[0].distance <= 3 ? ranked[0].candidate : null;
}

function printCliError(code: GtmErrorCode, message: string, hints: string[], args: string[], exitCode = exitCodes.userInputError) {
  if (args.includes("--json")) {
    printJson(gtmErrorEnvelope(code, message, hints));
  } else {
    console.error(message);
    for (const hint of hints) console.error(`hint: ${hint}`);
  }
  process.exitCode = exitCode;
}

function capabilitiesPayload() {
  return {
    ok: true,
    tool: "gtm",
    package: "fullstackgtm",
    version: packageVersion(),
    contract: {
      stdout: "data only; JSON mode prints parseable JSON to stdout",
      stderr: "diagnostics only",
      jsonFlag: "--json",
      noColor: true,
      dryRunDefaultFor: ["set", "do", "parse"],
      dangerousWritesRequire: ["--apply", "reason when available", "patch-plan approval for high-risk operations"],
    },
    commands: commandRecords(),
    mutations: gtmMutationSurfaceManifest().mutations,
    exitCodes,
    env: cliEnvVars,
    mcp: {
      command: "npm run gtm:mcp",
      keyTools: ["gtm_surface_manifest", "gtm_mutation_manifest", "gtm_mutation", "gtm_operating_model", "gtm_find", "gtm_set", "gtm_do", "gtm_parse", "gtm_patch_plans"],
    },
    examples: [
      "npm run gtm -- capabilities --json",
      "npm run gtm -- doctor --json",
      "npm run gtm -- surface --json",
      "npm run gtm -- find --resource deals --args '{}' --json",
      "npm run gtm -- set --operation updateDealForecast --args '{\"dealId\":\"...\",\"forecastCategory\":\"commit\"}' --json",
    ],
  };
}

async function safeFetch(url: string) {
  const started = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const response = await fetch(url, { method: "GET", signal: controller.signal }).finally(() => clearTimeout(timer));
    return { ok: true, status: response.status, ms: Date.now() - started };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), ms: Date.now() - started };
  }
}

async function doctorPayload(args: string[]) {
  loadLocalEnv();
  const runtime = runtimeContext();
  const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
  const checks: Array<{ name: string; ok: boolean; severity: "info" | "warning" | "error"; detail: string; hint?: string }> = [];

  checks.push({
    name: "package-type-module",
    ok: pkg.type === "module",
    severity: pkg.type === "module" ? "info" : "warning",
    detail: pkg.type === "module" ? "package.json declares ESM module type" : "package.json does not declare type=module, which makes Node warn for TS ESM CLI entrypoints",
    hint: 'Add "type": "module" to package.json or move CLI entrypoints to .mts/.mjs wrappers.',
  });
  checks.push({
    name: "convex-url-configured",
    ok: Boolean(runtime.convexUrl),
    severity: runtime.convexUrl ? "info" : "error",
    detail: runtime.convexUrl || "NEXT_PUBLIC_CONVEX_URL is missing",
    hint: "Set NEXT_PUBLIC_CONVEX_URL in .env.local before running data-backed commands.",
  });
  if (runtime.convexUrl) {
    const health = await safeFetch(runtime.convexUrl);
    checks.push({
      name: "convex-url-reachable",
      ok: health.ok,
      severity: health.ok ? "info" : "error",
      detail: health.ok ? `reachable with HTTP ${health.status} in ${health.ms}ms` : `unreachable: ${health.error}`,
      hint: "For local development, run `docker compose up -d` and `npx convex dev --once`, then retry `npm run gtm -- doctor --json`.",
    });
  }
  checks.push({
    name: "auth-token-or-dev-bypass",
    ok: runtime.authToken === "set" || runtime.devBypassCandidate,
    severity: runtime.authToken === "set" || runtime.devBypassCandidate ? "info" : "warning",
    detail: runtime.authToken === "set" ? "FSGTM_AUTH_TOKEN is set" : runtime.devBypassCandidate ? "dev-mode auth bypass appears available" : "no auth token and no dev bypass detected",
    hint: "Set FSGTM_AUTH_TOKEN for authenticated cloud deployments.",
  });
  checks.push({
    name: "capabilities-json",
    ok: true,
    severity: "info",
    detail: "capabilities --json is available",
  });
  checks.push({
    name: "surface-manifest",
    ok: true,
    severity: "info",
    detail: `${surfaceRequirements.length} surface requirements are registered for parity auditing`,
  });

  const fixes: Array<{ name: string; applied: boolean; detail: string }> = [];
  if (args.includes("--fix")) {
    const envPath = resolve(process.cwd(), ".env.local");
    if (!runtime.convexUrl) {
      appendFileSync(envPath, `${existsSync(envPath) ? "\n" : ""}NEXT_PUBLIC_CONVEX_URL=http://127.0.0.1:3210\n`);
      fixes.push({
        name: "add-local-convex-url",
        applied: true,
        detail: "Added NEXT_PUBLIC_CONVEX_URL=http://127.0.0.1:3210 to .env.local",
      });
    }
    if (fixes.length === 0) {
      fixes.push({
        name: "no-safe-file-fixes",
        applied: false,
        detail: "No safe file edits were available. Start local services manually if convex-url-reachable is failing.",
      });
    }
  }

  return {
    ok: checks.every((check) => check.ok || check.severity !== "error"),
    generatedAt: new Date().toISOString(),
    runtime,
    fixRequested: args.includes("--fix"),
    fixes,
    checks,
    nextCommands: [
      "npm run gtm -- capabilities --json",
      "npm run gtm -- mvp-audit --json",
      "npm run gtm -- interaction-audit --json",
      "npm run gtm -- mcp-smoke --json",
    ],
  };
}

function robotGuide() {
  return `# CanonCRM CLI robot guide

Use this CLI as an agent-facing GTM operating harness. Prefer JSON mode for all automation.

## First commands

\`\`\`bash
npm run gtm -- capabilities --json
npm run gtm -- doctor --json
npm run gtm -- surface --json
npm run gtm -- describe --json
\`\`\`

## Read data

\`\`\`bash
npm run gtm -- summary --json
npm run gtm -- deals --json
npm run gtm -- find --resource deals --args '{}' --json
\`\`\`

## Preview writes safely

\`set\`, \`do\`, \`parse\`, and call write actions default to dry-run; the allowlisted \`mutation\` surface defaults to an unvalidated echo preview. Add \`--apply\` only after the plan is understood and approved.

\`\`\`bash
npm run gtm -- set --operation updateDealForecast --args '{"dealId":"...","forecastCategory":"commit"}' --json
npm run gtm -- mutation --name api.patchPlans.approve --args '{"patchPlanId":"...","decision":"approved"}' --json
\`\`\`

## Diagnose setup

If data-backed commands fail, run:

\`\`\`bash
npm run gtm -- doctor --json
\`\`\`

Exit codes: 0 success, 1 user input, 2 safety block, 3 local environment, 4 upstream service, 5 conflict.`;
}

function capabilities(args: string[]) {
  if (mode(args) === "json") return printJson(capabilitiesPayload());
  console.log(robotGuide());
}

function surfaceManifest(args: string[]) {
  const manifest = getGtmSurfaceManifest();
  if (mode(args) === "json") return printJson(manifest);
  for (const row of manifest.surfaces) {
    console.log(`${row.area} / ${row.module}: cli=${row.cli.join(",") || "-"} api=${row.api.join(",") || "-"} mcp=${row.mcp.join(",") || "-"}`);
  }
}

async function doctor(args: string[]) {
  const payload = await doctorPayload(args);
  if (!payload.ok) process.exitCode = exitCodes.toolEnvironmentError;
  if (mode(args) === "json") return printJson(payload);
  console.log(`CanonCRM doctor: ${payload.ok ? "ok" : "needs attention"}`);
  for (const check of payload.checks) {
    console.log(`${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}`);
    if (!check.ok && check.hint) console.log(`  hint: ${check.hint}`);
  }
}

function robotDocs(args: string[]) {
  const topic = args.slice(1).find((arg) => !arg.startsWith("--"));
  if (topic && topic !== "guide") {
    return printCliError(
      "USER_INPUT",
      `Unknown robot-docs topic: ${topic}`,
      ["Use `npm run gtm -- robot-docs guide` instead."],
      args,
    );
  }
  console.log(robotGuide());
}

function money(cents: number | null | undefined) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format((cents ?? 0) / 100);
}

function pct(value: number | null | undefined) {
  return `${Math.round((value ?? 0) * 100)}%`;
}

function label(value: string | null | undefined) {
  if (!value) return "-";
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function currentFiscalYear() {
  return String(new Date().getUTCFullYear());
}

function numericOption(args: string[], name: string) {
  const value = option(args, name);
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function booleanOption(args: string[], name: string) {
  const value = option(args, name);
  if (value === null) return undefined;
  if (/^(true|1|yes)$/i.test(value)) return true;
  if (/^(false|0|no)$/i.test(value)) return false;
  throw new Error(`${name} must be true or false`);
}

/** The dates given; without them the server reads the workspace's current fiscal quarter. */
function forecastPeriod(args: string[]) {
  return { periodStart: option(args, "--start") ?? undefined, periodEnd: option(args, "--end") ?? undefined };
}

function printRows(rows: Array<Record<string, string | number>>) {
  if (rows.length === 0) {
    console.log("No rows.");
    return;
  }

  const headers = Object.keys(rows[0]);
  const widths = headers.map((header) =>
    Math.max(
      header.length,
      ...rows.map((row) => String(row[header] ?? "").length),
    ),
  );

  console.log(
    headers
      .map((header, index) => header.padEnd(widths[index]))
      .join("  "),
  );
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) {
    console.log(
      headers
        .map((header, index) => String(row[header] ?? "").padEnd(widths[index]))
        .join("  "),
    );
  }
}

function operatingModel(args: string[]) {
  const model = getGtmOperatingModel();

  if (mode(args) === "json") {
    printJson(model);
    return;
  }

  printRows([
    { metric: "Product", value: model.product },
    { metric: "Version", value: model.version },
    { metric: "Primitives", value: model.primitives.length },
    { metric: "CLI", value: model.surfaces.cli },
    { metric: "MCP", value: model.surfaces.mcp },
    { metric: "API", value: model.surfaces.api },
  ]);
  console.log("");
  printRows(
    model.primitives.map((primitive) => ({
      primitive: primitive.name,
      source: primitive.sourceOfRecord,
      sync: primitive.syncDirection,
      convex: primitive.convexTables.join(", ") || "-",
      salesforce: primitive.providerSupport.salesforce,
      hubspot: primitive.providerSupport.hubspot,
    })),
  );
  console.log("\nStorage recommendations");
  printRows(
    model.recommendations.map((recommendation) => ({
      source: recommendation.sourceOfRecord,
      primitives: recommendation.primitiveIds.length,
      guidance: recommendation.guidance,
    })),
  );
}

type AuditStatus = "ready" | "partial" | "needs_data" | "error";

type AuditModule = {
  area: string;
  module: string;
  status: AuditStatus;
  signals: string[];
  gaps: string[];
  nextAction: string;
};

type UiPrimitiveCheck = {
  primitive: string;
  ready: boolean;
  signals: string[];
  gaps: string[];
};

type SourceViolation = {
  path: string;
  line: number;
  text: string;
};

type SharedUiAudit = {
  ready: boolean;
  checks: UiPrimitiveCheck[];
  dashboardPages: number;
  dataTablePages: string[];
  editableGridPages: string[];
  formulaInputPages: string[];
  emptyStatePages: string[];
  numberInputViolations: SourceViolation[];
};

type SurfaceModuleResult = {
  area: string;
  module: string;
  ready: boolean;
  signals: string[];
  gaps: string[];
};

type SurfaceAudit = {
  ready: boolean;
  totals: {
    ready: number;
    total: number;
  };
  modules: SurfaceModuleResult[];
};

type InteractionSurfaceResult = {
  area: string;
  module: string;
  dashboard: string;
  mutation: string;
  api: boolean;
  cli: boolean;
  mcp: boolean;
  gaps: string[];
};

type InteractionSurfaceAudit = {
  ready: boolean;
  totals: {
    interactions: number;
    fullParity: number;
    api: number;
    cli: number;
    mcp: number;
  };
  results: InteractionSurfaceResult[];
  /** Deliberately off the API/CLI/MCP surface (src/lib/gtm-human-only-mutations.ts). */
  humanOnly: Array<{ dashboard: string; mutation: string; why: string }>;
  /** Known uncovered functions (src/lib/gtm-parity-baseline.ts): shrink-only, not counted as gaps. */
  baselined: Array<{ dashboard: string; mutation: string; reason: string }>;
  /** Baseline entries that are now covered, human-only, or no longer called from the dashboard. Delete them. */
  staleBaseline: string[];
};

type ApiSmokeResult = {
  area: string;
  module: string;
  path: string;
  url: string;
  ok: boolean;
  status: number | null;
  durationMs: number;
  contentType: string;
  error: string | null;
};

type UiSmokeResult = {
  area: string;
  module: string;
  path: string;
  url: string;
  ok: boolean;
  status: number | null;
  durationMs: number;
  contentType: string;
  redirected: boolean;
  error: string | null;
};

type CliSmokeResult = {
  area: string;
  module: string;
  command: string;
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  error: string | null;
};

type McpSmokeResult = {
  area: string;
  module: string;
  tool: string;
  ok: boolean;
  listed: boolean;
  durationMs: number;
  error: string | null;
};

type Capture<T = unknown> = {
  name: string;
  data?: T;
  error?: string;
};

async function capture<T>(
  name: string,
  read: () => Promise<T>,
): Promise<Capture<T>> {
  try {
    return { name, data: await read() };
  } catch (error) {
    return {
      name,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function auditStatus(
  ready: boolean,
  partial: boolean,
  error?: string,
): AuditStatus {
  if (error) return "error";
  if (ready) return "ready";
  if (partial) return "partial";
  return "needs_data";
}

function auditModule(input: {
  area: string;
  module: string;
  ready: boolean;
  partial?: boolean;
  error?: string;
  signals: string[];
  gaps: string[];
  nextAction: string;
}): AuditModule {
  return {
    area: input.area,
    module: input.module,
    status: auditStatus(input.ready, input.partial ?? false, input.error),
    signals: input.signals,
    gaps: input.error ? [input.error] : input.gaps,
    nextAction: input.error ? "Fix query/auth/setup error" : input.nextAction,
  };
}

function dataFrom<T>(captures: Map<string, Capture>, name: string): T | undefined {
  return captures.get(name)?.data as T | undefined;
}

function errorFrom(captures: Map<string, Capture>, name: string) {
  return captures.get(name)?.error;
}

function rows(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function isPresent(value: unknown) {
  return value !== null && value !== undefined;
}

function repoPath(path: string) {
  return relative(process.cwd(), path).replace(/\\/g, "/");
}

function sourceFiles(root: string): string[] {
  if (!existsSync(root)) return [];

  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (entry.isFile() && /\.(tsx?|jsx?)$/.test(entry.name)) return [path];
    return [];
  });
}

function sourceText(path: string) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function pageFiles(root: string) {
  return sourceFiles(root).filter((path) => path.replace(/\\/g, "/").endsWith("/page.tsx"));
}

function filesUsing(files: string[], pattern: RegExp) {
  return files
    .filter((path) => pattern.test(sourceText(path)))
    .map(repoPath)
    .sort();
}

function sourceViolations(files: string[], pattern: RegExp): SourceViolation[] {
  return files.flatMap((path) =>
    sourceText(path)
      .split(/\r?\n/)
      .flatMap((line, index) =>
        pattern.test(line)
          ? [
              {
                path: repoPath(path),
                line: index + 1,
                text: line.trim(),
              },
            ]
          : [],
      ),
  );
}

function missingFeatures(component: string, features: Array<[string, boolean]>) {
  return features.flatMap(([feature, ready]) =>
    ready ? [] : [`${component} missing ${feature}`],
  );
}

const surfaceRequirements = gtmSurfaceRequirements;

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function commandExists(source: string, command: string) {
  return new RegExp(`command\\s*===\\s*["']${escapeRegExp(command)}["']`).test(
    source,
  );
}

function mcpToolExists(source: string, tool: string) {
  return new RegExp(`registerTool\\(\\s*["']${escapeRegExp(tool)}["']`).test(
    source,
  );
}

function countReady(values: boolean[]) {
  return values.filter(Boolean).length;
}

function moduleSurfaceAudit(): SurfaceAudit {
  const cliSource = sourceText(resolve(process.cwd(), "scripts/fsgtm.ts"));
  const mcpSource = sourceText(resolve(process.cwd(), "scripts/fsgtm-mcp.ts"));
  const modules = surfaceRequirements.map((requirement) => {
    const dashboardChecks = requirement.dashboard.map((path) =>
      existsSync(resolve(process.cwd(), path)),
    );
    const apiChecks = requirement.api.map((path) =>
      existsSync(resolve(process.cwd(), path)),
    );
    const cliChecks = requirement.cli.map((command) =>
      commandExists(cliSource, command),
    );
    const mcpChecks = requirement.mcp.map((tool) =>
      mcpToolExists(mcpSource, tool),
    );
    const gaps = [
      ...requirement.dashboard.flatMap((path, index) =>
        dashboardChecks[index] ? [] : [`Missing dashboard ${path}`],
      ),
      ...requirement.api.flatMap((path, index) =>
        apiChecks[index] ? [] : [`Missing API ${path}`],
      ),
      ...requirement.cli.flatMap((command, index) =>
        cliChecks[index] ? [] : [`Missing CLI command ${command}`],
      ),
      ...requirement.mcp.flatMap((tool, index) =>
        mcpChecks[index] ? [] : [`Missing MCP tool ${tool}`],
      ),
    ];

    return {
      area: requirement.area,
      module: requirement.module,
      ready: gaps.length === 0,
      signals: [
        `dashboard ${countReady(dashboardChecks)}/${dashboardChecks.length}`,
        `api ${countReady(apiChecks)}/${apiChecks.length}`,
        `cli ${countReady(cliChecks)}/${cliChecks.length}`,
        `mcp ${countReady(mcpChecks)}/${mcpChecks.length}`,
      ],
      gaps,
    };
  });

  return {
    ready: modules.every((module) => module.ready),
    totals: {
      ready: modules.filter((module) => module.ready).length,
      total: modules.length,
    },
    modules,
  };
}

function moduleForDashboardPage(pagePath: string) {
  const pageRoute = dashboardPathFromPage(repoPath(pagePath));
  let best:
    | {
        area: string;
        module: string;
        routeLength: number;
      }
    | null = null;

  for (const requirement of surfaceRequirements) {
    for (const dashboard of requirement.dashboard) {
      const route = dashboardPathFromPage(dashboard);
      const isMatch =
        pageRoute === route ||
        (route !== "/dashboard" && pageRoute.startsWith(`${route}/`));
      if (!isMatch || route.length <= (best?.routeLength ?? -1)) continue;
      best = {
        area: requirement.area,
        module: requirement.module,
        routeLength: route.length,
      };
    }
  }

  return {
    area: best?.area ?? "Unmapped",
    module: best?.module ?? pageRoute,
  };
}

function referencedApiMutation(source: string, mutation: string) {
  return new RegExp(`\\b${escapeRegExp(mutation)}\\b`).test(source);
}

export function interactionSurfaceAudit(): InteractionSurfaceAudit {
  // Every dashboard source that can call Convex: pages, and the components
  // they render (writes live in components too). Actions count like mutations,
  // so a write cannot escape parity by being an action.
  const dashboardFiles = [
    ...sourceFiles(resolve(process.cwd(), "src/app/dashboard")),
    ...sourceFiles(resolve(process.cwd(), "src/components")),
  ];
  const sourcesOf = (...roots: string[]) =>
    roots.flatMap((root) => sourceFiles(resolve(process.cwd(), root))).map((path) => sourceText(path)).join("\n");
  const mutationRegistrySource = sourceText(resolve(process.cwd(), "src/lib/gtm-mutation-registry.ts"));
  // The canon tools under src/app/mcp are the agent surface. The canon CLI is a
  // thin client of them, and /api/v1 is the REST face of the same functions.
  const canonSource = sourcesOf("src/app/mcp", "cli");
  const apiSource = `${sourcesOf("src/app/api/gtm", "src/app/api/v1")}\n${mutationRegistrySource}\n${canonSource}`;
  const cliSource = `${sourceText(resolve(process.cwd(), "scripts/fsgtm.ts"))}\n${mutationRegistrySource}\n${canonSource}`;
  const mcpSource = `${sourceText(resolve(process.cwd(), "scripts/fsgtm-mcp.ts"))}\n${mutationRegistrySource}\n${canonSource}`;
  const mutationPattern = /use(?:Mutation|Action)\(\s*api\.([A-Za-z0-9_.]+)/g;
  const seen = new Set<string>();
  const results: InteractionSurfaceResult[] = [];
  const humanOnly: InteractionSurfaceAudit["humanOnly"] = [];
  const baselined: InteractionSurfaceAudit["baselined"] = [];
  const stillUncovered = new Set<string>();

  for (const page of dashboardFiles) {
    const source = sourceText(page);
    const dashboard = repoPath(page);
    const moduleInfo = moduleForDashboardPage(page);

    for (const match of source.matchAll(mutationPattern)) {
      const mutation = `api.${match[1]}`;
      const key = `${dashboard}:${mutation}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (Object.hasOwn(gtmHumanOnlyFunctions, mutation)) {
        humanOnly.push({ dashboard, mutation, why: gtmHumanOnlyFunctions[mutation]! });
        continue;
      }

      const api = referencedApiMutation(apiSource, mutation);
      const cli = referencedApiMutation(cliSource, mutation);
      const mcp = referencedApiMutation(mcpSource, mutation);
      const gaps = [
        ...(api ? [] : ["missing API mutation surface"]),
        ...(cli ? [] : ["missing CLI mutation surface"]),
        ...(mcp ? [] : ["missing MCP mutation surface"]),
      ];

      if (gaps.length > 0 && Object.hasOwn(gtmParityBaseline, mutation)) {
        stillUncovered.add(mutation);
        baselined.push({ dashboard, mutation, reason: gtmParityBaseline[mutation]! });
        continue;
      }

      results.push({
        area: moduleInfo.area,
        module: moduleInfo.module,
        dashboard,
        mutation,
        api,
        cli,
        mcp,
        gaps,
      });
    }
  }

  results.sort((a, b) =>
    `${a.area}:${a.module}:${a.mutation}:${a.dashboard}`.localeCompare(
      `${b.area}:${b.module}:${b.mutation}:${b.dashboard}`,
    ),
  );

  const totals = {
    interactions: results.length,
    fullParity: results.filter((result) => result.api && result.cli && result.mcp)
      .length,
    api: results.filter((result) => result.api).length,
    cli: results.filter((result) => result.cli).length,
    mcp: results.filter((result) => result.mcp).length,
  };

  const staleBaseline = Object.keys(gtmParityBaseline).filter((name) => !stillUncovered.has(name)).sort();

  return {
    ready: totals.fullParity === totals.interactions && staleBaseline.length === 0,
    totals,
    results,
    humanOnly,
    baselined,
    staleBaseline,
  };
}

function apiPathFromRoute(routePath: string) {
  return `/${routePath
    .replace(/^src\/app\//, "")
    .replace(/\/route\.tsx?$/, "")}`;
}

function dashboardPathFromPage(pagePath: string) {
  const route = pagePath
    .replace(/^src\/app/, "")
    .replace(/\/page\.tsx?$/, "")
    .replace(/\/index$/, "");
  return route || "/";
}

function dashboardSmokeRoutes() {
  const seen = new Set<string>();
  return surfaceRequirements.flatMap((requirement) =>
    requirement.dashboard.flatMap((pagePath) => {
      const path = dashboardPathFromPage(pagePath);
      const key = `${requirement.module}:${path}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [
        {
          area: requirement.area,
          module: requirement.module,
          path,
        },
      ];
    }),
  );
}

function apiSmokeEndpoints() {
  const seen = new Set<string>();
  return surfaceRequirements.flatMap((requirement) =>
    requirement.api.flatMap((routePath) => {
      const path = apiPathFromRoute(routePath);
      const key = `${requirement.module}:${path}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [
        {
          area: requirement.area,
          module: requirement.module,
          path,
        },
      ];
    }),
  );
}

function cliSmokeCommands() {
  const seen = new Set<string>();
  return surfaceRequirements.flatMap((requirement) =>
    requirement.cli.flatMap((command) => {
      if (seen.has(command)) return [];
      seen.add(command);
      return [
        {
          area: requirement.area,
          module: requirement.module,
          command,
        },
      ];
    }),
  );
}

function isMutatingMcpTool(tool: string) {
  return (
    tool.startsWith("gtm_generate_") ||
    tool.startsWith("gtm_create_") ||
    tool.startsWith("gtm_assign_") ||
    tool.startsWith("gtm_update_")
  );
}

function mcpSmokeTools() {
  const seen = new Set<string>();
  return surfaceRequirements.flatMap((requirement) =>
    requirement.mcp.flatMap((tool) => {
      if (isMutatingMcpTool(tool) || seen.has(tool)) return [];
      seen.add(tool);
      return [
        {
          area: requirement.area,
          module: requirement.module,
          tool,
        },
      ];
    }),
  );
}

function siteUrl(args: string[]) {
  const configured =
    option(args, "--site-url") ??
    process.env.FSGTM_SITE_URL ??
    process.env.NEXT_PUBLIC_SITE_URL ??
    "http://localhost:3000";
  const withProtocol = /^https?:\/\//i.test(configured)
    ? configured
    : `http://${configured}`;
  return withProtocol.replace(/\/+$/, "");
}

function stringEnv() {
  return Object.fromEntries(
    Object.entries(process.env).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, value]],
    ),
  );
}

function runCliJsonCommand(
  command: { area: string; module: string; command: string },
  timeoutMs: number,
): Promise<CliSmokeResult> {
  const startedAt = Date.now();
  const scriptPath = resolve(process.cwd(), "scripts/fsgtm.ts");

  return new Promise((resolveResult) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", scriptPath, command.command, "--json"],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const finish = (result: CliSmokeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({
        area: command.area,
        module: command.module,
        command: command.command,
        ok: false,
        exitCode: null,
        durationMs: Date.now() - startedAt,
        error: `Timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", (error) => {
      finish({
        area: command.area,
        module: command.module,
        command: command.command,
        ok: false,
        exitCode: null,
        durationMs: Date.now() - startedAt,
        error: error.message,
      });
    });
    child.on("close", (exitCode) => {
      const durationMs = Date.now() - startedAt;
      const output = Buffer.concat(stdout).toString("utf8").trim();
      const errorOutput = Buffer.concat(stderr).toString("utf8").trim();

      if (exitCode !== 0) {
        finish({
          area: command.area,
          module: command.module,
          command: command.command,
          ok: false,
          exitCode,
          durationMs,
          error: errorOutput || output || `Exited with code ${exitCode}`,
        });
        return;
      }

      try {
        JSON.parse(output);
        finish({
          area: command.area,
          module: command.module,
          command: command.command,
          ok: true,
          exitCode,
          durationMs,
          error: null,
        });
      } catch (error) {
        finish({
          area: command.area,
          module: command.module,
          command: command.command,
          ok: false,
          exitCode,
          durationMs,
          error: error instanceof Error ? error.message : "Invalid JSON output",
        });
      }
    });
  });
}

function mcpTextContent(result: unknown) {
  if (!result || typeof result !== "object") return null;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  const text = content.find(
    (item): item is { type: "text"; text: string } =>
      Boolean(item) &&
      typeof item === "object" &&
      (item as { type?: unknown }).type === "text" &&
      typeof (item as { text?: unknown }).text === "string",
  );
  return text?.text ?? null;
}

async function callMcpReadTool(
  client: Client,
  tool: { area: string; module: string; tool: string },
  listedTools: Set<string>,
  timeoutMs: number,
): Promise<McpSmokeResult> {
  const startedAt = Date.now();
  if (!listedTools.has(tool.tool)) {
    return {
      area: tool.area,
      module: tool.module,
      tool: tool.tool,
      ok: false,
      listed: false,
      durationMs: 0,
      error: "Tool was not listed by MCP server",
    };
  }

  try {
    const result = await client.callTool(
      { name: tool.tool, arguments: {} },
      undefined,
      { timeout: timeoutMs },
    );
    const isError = Boolean((result as { isError?: unknown }).isError);
    const text = mcpTextContent(result);
    let parseError: string | null = null;

    try {
      JSON.parse(text ?? "");
    } catch (error) {
      parseError = error instanceof Error ? error.message : "Invalid JSON";
    }

    return {
      area: tool.area,
      module: tool.module,
      tool: tool.tool,
      ok: !isError && parseError === null,
      listed: true,
      durationMs: Date.now() - startedAt,
      error: isError ? text ?? "Tool returned an MCP error" : parseError,
    };
  } catch (error) {
    return {
      area: tool.area,
      module: tool.module,
      tool: tool.tool,
      ok: false,
      listed: true,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function smokeApiEndpoint(
  endpoint: { area: string; module: string; path: string },
  baseUrl: string,
  timeoutMs: number,
): Promise<ApiSmokeResult> {
  const url = `${baseUrl}${endpoint.path}`;
  const startedAt = Date.now();
  const headers: Record<string, string> = {};
  if (process.env.FSGTM_AUTH_TOKEN) {
    headers.Authorization = `Bearer ${process.env.FSGTM_AUTH_TOKEN}`;
  }
  applySmokeBypassHeaders(headers);

  try {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const durationMs = Date.now() - startedAt;
    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text();
    let parseError: string | null = null;
    let payload: unknown = null;

    try {
      payload = text ? JSON.parse(text) : null;
    } catch (error) {
      parseError = error instanceof Error ? error.message : "Invalid JSON";
    }

    const apiError =
      payload &&
      typeof payload === "object" &&
      "error" in payload &&
      typeof (payload as { error?: unknown }).error === "string"
        ? String((payload as { error: string }).error)
        : null;
    const ok = response.ok && parseError === null && apiError === null;

    return {
      area: endpoint.area,
      module: endpoint.module,
      path: endpoint.path,
      url,
      ok,
      status: response.status,
      durationMs,
      contentType,
      error: response.ok ? parseError ?? apiError : apiError ?? response.statusText,
    };
  } catch (error) {
    return {
      area: endpoint.area,
      module: endpoint.module,
      path: endpoint.path,
      url,
      ok: false,
      status: null,
      durationMs: Date.now() - startedAt,
      contentType: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function smokeDashboardRoute(
  route: { area: string; module: string; path: string },
  baseUrl: string,
  timeoutMs: number,
): Promise<UiSmokeResult> {
  const url = `${baseUrl}${route.path}`;
  const startedAt = Date.now();
  const headers: Record<string, string> = {};
  applySmokeBypassHeaders(headers);

  try {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const durationMs = Date.now() - startedAt;
    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text();
    const isHtml =
      contentType.includes("text/html") &&
      /<(html|body|script)\b/i.test(text);
    const redirected = response.redirected || response.url !== url;
    const ok = response.ok && isHtml && !redirected;
    const error = !response.ok
      ? response.statusText
      : redirected
        ? `Redirected to ${response.url}`
        : isHtml
          ? null
          : `Expected HTML response, got ${contentType || "unknown content type"}`;

    return {
      area: route.area,
      module: route.module,
      path: route.path,
      url,
      ok,
      status: response.status,
      durationMs,
      contentType,
      redirected,
      error,
    };
  } catch (error) {
    return {
      area: route.area,
      module: route.module,
      path: route.path,
      url,
      ok: false,
      status: null,
      durationMs: Date.now() - startedAt,
      contentType: "",
      redirected: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function sharedUiAudit(): SharedUiAudit {
  const dashboardRoot = resolve(process.cwd(), "src/app/dashboard");
  const componentRoot = resolve(process.cwd(), "src/components/dashboard");
  const pages = pageFiles(dashboardRoot);
  const componentFiles = sourceFiles(componentRoot);
  const dataTablePath = resolve(componentRoot, "data-table.tsx");
  const editableGridPath = resolve(componentRoot, "editable-grid.tsx");
  const formulaInputPath = resolve(componentRoot, "formula-input.tsx");
  const emptyStatePath = resolve(componentRoot, "empty-state.tsx");
  const dataTableSource = sourceText(dataTablePath);
  const editableGridSource = sourceText(editableGridPath);
  const formulaInputSource = sourceText(formulaInputPath);

  const dataTablePages = filesUsing(pages, /\bDataTable\b/);
  const editableGridPages = filesUsing(pages, /\bEditableGrid\b/);
  const formulaInputPages = filesUsing(pages, /\bFormulaInput\b/);
  const emptyStatePages = filesUsing(pages, /\bEmptyState\b/);
  const numberInputViolations = sourceViolations(
    [...pages, ...componentFiles],
    /type\s*=\s*["']number["']/,
  );

  const componentGaps = [
    [dataTablePath, "DataTable"],
    [editableGridPath, "EditableGrid"],
    [formulaInputPath, "FormulaInput"],
    [emptyStatePath, "EmptyState"],
  ].flatMap(([path, name]) =>
    existsSync(path) ? [] : [`Missing ${name} component`],
  );

  const dataTableFeatureGaps = missingFeatures("DataTable", [
    [
      "search",
      dataTableSource.includes("enableSearch") &&
        dataTableSource.includes("setSearch"),
    ],
    ["sorting", dataTableSource.includes("toggleSort")],
    ["CSV export", dataTableSource.includes("text/csv")],
    ["keyboard row activation", dataTableSource.includes("handleKeyDown")],
    ["filter slot", dataTableSource.includes("filters?: React.ReactNode")],
  ]);

  const editableGridFeatureGaps = missingFeatures("EditableGrid", [
    ["cell commits", editableGridSource.includes("onCellCommit")],
    [
      "tab/enter navigation",
      editableGridSource.includes("Tab") && editableGridSource.includes("Enter"),
    ],
    ["formula evaluation", editableGridSource.includes("evaluateSpreadsheetFormula")],
    ["add-row control", editableGridSource.includes("onAddRow")],
  ]);

  const formulaInputFeatureGaps = missingFeatures("FormulaInput", [
    ["formula resolution", formulaInputSource.includes("resolveSpreadsheetInputValue")],
    [
      "text input with decimal keyboard",
      formulaInputSource.includes('type="text"') &&
        formulaInputSource.includes("inputMode"),
    ],
    ["enter-to-commit", formulaInputSource.includes("event.key === \"Enter\"")],
  ]);

  const checks: UiPrimitiveCheck[] = [
    {
      primitive: "Shared component files",
      ready: componentGaps.length === 0,
      signals: [`components ${4 - componentGaps.length}/4`],
      gaps: componentGaps,
    },
    {
      primitive: "DataTable",
      ready: dataTablePages.length >= 30 && dataTableFeatureGaps.length === 0,
      signals: [
        `pages ${dataTablePages.length}/${pages.length}`,
        "search/sort/filter/export/keyboard",
      ],
      gaps: [
        ...(dataTablePages.length >= 30
          ? []
          : [`DataTable used on ${dataTablePages.length} dashboard pages; expected at least 30`]),
        ...dataTableFeatureGaps,
      ],
    },
    {
      primitive: "EditableGrid",
      ready: editableGridPages.length >= 2 && editableGridFeatureGaps.length === 0,
      signals: [
        `pages ${editableGridPages.length}`,
        "tab/enter entry with formulas",
      ],
      gaps: [
        ...(editableGridPages.length >= 2
          ? []
          : [`EditableGrid used on ${editableGridPages.length} dashboard pages; expected at least 2`]),
        ...editableGridFeatureGaps,
      ],
    },
    {
      primitive: "FormulaInput",
      ready: formulaInputPages.length >= 10 && formulaInputFeatureGaps.length === 0,
      signals: [
        `pages ${formulaInputPages.length}`,
        "formulas replace number inputs",
      ],
      gaps: [
        ...(formulaInputPages.length >= 10
          ? []
          : [`FormulaInput used on ${formulaInputPages.length} dashboard pages; expected at least 10`]),
        ...formulaInputFeatureGaps,
      ],
    },
    {
      primitive: "EmptyState",
      ready: emptyStatePages.length >= 30,
      signals: [`pages ${emptyStatePages.length}/${pages.length}`],
      gaps:
        emptyStatePages.length >= 30
          ? []
          : [`EmptyState used on ${emptyStatePages.length} dashboard pages; expected at least 30`],
    },
    {
      primitive: "No standalone number inputs",
      ready: numberInputViolations.length === 0,
      signals: [`violations ${numberInputViolations.length}`],
      gaps: numberInputViolations.map(
        (violation) => `${violation.path}:${violation.line} ${violation.text}`,
      ),
    },
  ];

  return {
    ready: checks.every((check) => check.ready),
    checks,
    dashboardPages: pages.length,
    dataTablePages,
    editableGridPages,
    formulaInputPages,
    emptyStatePages,
    numberInputViolations,
  };
}

function demoSeedHint() {
  const context = runtimeContext();
  const lines = [
    "Demo seeding is disabled for this Convex deployment.",
  ];

  if (context.convexTarget === "cloud") {
    lines.push(
      "The CLI is pointed at a cloud Convex URL. Do not enable demo data on a shared production deployment.",
      "For real cloud data, set FSGTM_AUTH_TOKEN instead of seeding demo data.",
    );
  } else {
    lines.push(
      "For local/demo workspaces, enable it with:",
      "  npx convex env set FSGTM_ENABLE_DEMO_DATA true",
      "Then rerun:",
      "  npm run gtm -- seed-demo",
    );
  }

  return lines.join("\n");
}

async function attemptDemoSeed(convex = client()) {
  try {
    return {
      ok: true as const,
      result: await convex.mutation(api.devSeed.ensureWorkspace, {}),
    };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : String(error),
      hint: demoSeedHint(),
    };
  }
}

async function summary(args: string[]) {
  const data = await client().query(api.dashboard.summary, {});
  if (mode(args) === "json") return printJson(data);
  if (!data) {
    console.log("No dashboard summary available. Check auth or demo seed settings.");
    return;
  }

  printRows([
    { metric: "Open pipeline", value: money(data.metrics.openPipeline) },
    { metric: "MTD revenue", value: money(data.metrics.mtdRevenue) },
    { metric: "Win rate", value: pct(data.metrics.winRate) },
    { metric: "Active team", value: data.metrics.activeTeam },
    { metric: "Open deals", value: data.metrics.openDeals },
    { metric: "CRM accounts", value: data.metrics.accounts },
    { metric: "CRM contacts", value: data.metrics.contacts },
  ]);
}

async function deals(args: string[]) {
  const convex = client();
  const dealId = option(args, "--deal");
  const forecastCategory = option(args, "--forecast-category");

  if (dealId || forecastCategory) {
    if (!dealId || !forecastCategory) {
      throw new Error(
        "deals forecast updates require --deal <id> --forecast-category <value>",
      );
    }
    const allowed = [
      "omit",
      "pipeline",
      "best_case",
      "commit",
      "closed_won",
      "closed_lost",
    ];
    if (!allowed.includes(forecastCategory)) {
      throw new Error(`--forecast-category must be one of ${allowed.join(", ")}`);
    }

    await convex.mutation(api.deals.updateForecast, {
      dealId: dealId as Id<"deals">,
      forecastCategory: forecastCategory as
        | "omit"
        | "pipeline"
        | "best_case"
        | "commit"
        | "closed_won"
        | "closed_lost",
    });
    const result = { dealId, forecastCategory };
    if (mode(args) === "json") return printJson(result);
    printRows([
      { field: "Deal", value: dealId },
      { field: "Forecast category", value: label(forecastCategory) },
    ]);
    return;
  }

  const data = await convex.query(api.deals.list, {});
  if (mode(args) === "json") return printJson(data);

  printRows(
    data.slice(0, 25).map((deal) => ({
      deal: deal.name,
      amount: money(deal.amount),
      closeDate: deal.closeDate,
      stage: deal.stage ?? "-",
      forecast: label(deal.forecastCategory),
    })),
  );
}

async function integrations(args: string[]) {
  const convex = client();
  const [hubspot, salesforce, syncRuns] = await Promise.all([
    convex.query(api.hubspot.getConnection, {}),
    convex.query(api.salesforce.getConnection, {}),
    convex.query(api.integrations.listSyncRuns, { limit: 10 }),
  ]);
  if (mode(args) === "json") {
    return printJson({ hubspot, salesforce, syncRuns });
  }

  printRows([
    {
      provider: "HubSpot",
      connected: hubspot ? "yes" : "no",
      status: label(hubspot?.lastSyncStatus),
      lastSync: hubspot?.lastSyncAt ?? "-",
    },
    {
      provider: "Salesforce",
      connected: salesforce ? "yes" : "no",
      status: label(salesforce?.lastSyncStatus),
      lastSync: salesforce?.lastSyncAt ?? "-",
    },
  ]);

  console.log("\nRecent sync runs");
  printRows(
    syncRuns.map((run) => ({
      provider: label(run.provider),
      trigger: label(run.trigger),
      status: label(run.status),
      deals: Number(run.counts?.deals ?? 0),
      accounts: Number(run.counts?.accounts ?? 0),
    })),
  );
}

function auth(args: string[]) {
  const subcommand = args[1] ?? "status";
  if (subcommand !== "status") {
    return printCliError(
      "USER_INPUT",
      `Unknown auth subcommand: ${subcommand}`,
      ["Use `npm run gtm -- auth status --json`.", "Token login is not yet implemented; set FSGTM_AUTH_TOKEN for cloud deployments."],
      args,
    );
  }
  const runtime = runtimeContext();
  const payload = {
    ok: true,
    status: runtime.authToken === "set" ? "authenticated" : runtime.devBypassCandidate ? "dev-bypass" : "unauthenticated",
    authToken: runtime.authToken,
    convexTarget: runtime.convexTarget,
    convexUrl: runtime.convexUrl,
    devBypassCandidate: runtime.devBypassCandidate,
    warnings: runtime.warnings,
    nextCommands: [
      "npm run gtm -- doctor --json",
      "export FSGTM_AUTH_TOKEN=<token>",
    ],
  };
  if (mode(args) === "json") return printJson(payload);
  printRows([
    { field: "Status", value: payload.status },
    { field: "Auth token", value: payload.authToken },
    { field: "Convex target", value: payload.convexTarget },
    { field: "Convex URL", value: payload.convexUrl || "-" },
  ]);
  for (const warning of runtime.warnings) console.error(`warning: ${warning}`);
}

async function calls(args: string[]) {
  const convex = client();
  const callId = option(args, "--call") ?? option(args, "--call-id");
  const apply = args.includes("--apply");

  if (args.includes("--analyze")) {
    if (!callId) throw new Error("calls --analyze requires --call <id>");
    if (!apply) return printJson({ ok: true, dryRun: true, action: "analyze", callId });
    const result = await convex.mutation(api.callIntelligence.analyzeCall, {
      callId: callId as Id<"callRecordings">,
    });
    return printJson(result);
  }

  if (args.includes("--ingest")) {
    const title = option(args, "--title");
    const transcriptText = option(args, "--transcript-text") ?? (option(args, "--transcript-file") ? readFileSync(resolve(process.cwd(), option(args, "--transcript-file")!), "utf8") : null);
    if (!title || !transcriptText) throw new Error("calls --ingest requires --title and --transcript-text or --transcript-file");
    const payload = {
      provider: (option(args, "--provider") ?? "manual") as "manual",
      title,
      callDate: option(args, "--call-date") ?? undefined,
      durationSeconds: numericOption(args, "--duration-seconds"),
      recordingUrl: option(args, "--recording-url") ?? undefined,
      transcriptText,
      dealId: (option(args, "--deal") ?? undefined) as Id<"deals"> | undefined,
      accountId: (option(args, "--account") ?? undefined) as Id<"crmAccounts"> | undefined,
    };
    if (!apply) return printJson({ ok: true, dryRun: true, action: "ingest", args: payload });
    const result = await convex.mutation(api.callIntelligence.ingestTranscript, payload);
    return printJson(result);
  }

  if (args.includes("--sync")) {
    const provider = option(args, "--provider");
    if (provider !== "gong" && provider !== "chorus" && provider !== "fathom" && provider !== "avoma" && provider !== "granola") {
      throw new Error("calls --sync requires --provider gong|chorus|fathom|avoma|granola");
    }
    if (!apply) return printJson({ ok: true, dryRun: true, action: "syncProvider", provider });
    return printJson(await convex.action(api.callProviderActions.syncProvider, { provider }));
  }

  if (args.includes("--demo")) {
    if (!apply) return printJson({ ok: true, dryRun: true, action: "ingestAndAnalyzeDemo" });
    const result = await convex.mutation(api.callIntelligence.ingestAndAnalyzeDemo, {});
    return printJson(result);
  }

  if (args.includes("--propose-next-step")) {
    const insightId = option(args, "--insight");
    const nextStep = option(args, "--next-step") ?? undefined;
    if (!insightId) throw new Error("calls --propose-next-step requires --insight <id>");
    if (!apply) return printJson({ ok: true, dryRun: true, action: "proposeDealNextStepPatchPlan", insightId, nextStep });
    const result = await convex.mutation(api.callIntelligence.proposeDealNextStepPatchPlan, {
      insightId: insightId as Id<"callInsights">,
      nextStep,
    });
    return printJson(result);
  }

  if (callId) {
    // getCall returns { call, segments, insights } (or null when the id is
    // unknown / cross-org) — render the nested record, not the envelope.
    const detail = await convex.query(api.callIntelligence.getCall, {
      callId: callId as Id<"callRecordings">,
    });
    if (mode(args) === "json") return printJson({ call: detail });
    if (!detail) {
      console.log("Call not found.");
      return;
    }
    printRows([
      { field: "Title", value: detail.call.title ?? "-" },
      { field: "Provider", value: label(detail.call.provider) },
      { field: "Date", value: detail.call.callDate ?? "-" },
      { field: "Duration", value: detail.call.durationSeconds ?? "-" },
      { field: "Segments", value: detail.segments.length },
      { field: "Insights", value: detail.insights.length },
    ]);
    return;
  }

  const [summary, callRows, insights] = await Promise.all([
    convex.query(api.callIntelligence.summary, {}),
    convex.query(api.callIntelligence.listCalls, { limit: 100 }),
    convex.query(api.callIntelligence.listInsights, { limit: 100 }),
  ]);

  if (mode(args) === "json") return printJson({ summary, calls: callRows, insights });

  printRows([
    { metric: "Calls", value: callRows.length },
    { metric: "Insights", value: insights.length },
    { metric: "Analyzed", value: summary.analyzedCalls ?? "-" },
  ]);
  console.log("\nRecent calls");
  printRows(
    callRows.slice(0, 25).map((call) => ({
      id: call._id,
      title: call.title ?? "-",
      provider: label(call.provider),
      date: call.callDate ?? "-",
    })),
  );
  console.log("\nUse `npm run gtm -- calls --call <id> --json` to inspect one call.");
}

async function abm(args: string[]) {
  const convex = client();
  const listId = option(args, "--list");

  if (args.includes("--generate")) {
    const result = await convex.mutation(api.abm.generateFromCrm, {});
    if (mode(args) === "json") return printJson(result);
    printRows([
      { metric: "Accounts added", value: result.accountsAdded },
      { metric: "Accounts updated", value: result.accountsUpdated },
      { metric: "Plays created", value: result.playsCreated },
      { metric: "List id", value: result.listId },
    ]);
    return;
  }

  const [stats, lists] = await Promise.all([
    convex.query(api.abm.getStats, {}),
    convex.query(api.abm.listLists, {}),
  ]);

  if (listId) {
    const typedListId = listId as Id<"abmLists">;
    const [list, accounts, candidateAccounts, plays] = await Promise.all([
      convex.query(api.abm.getList, { listId: typedListId }),
      convex.query(api.abm.listAccounts, { listId: typedListId }),
      convex.query(api.abm.listCandidateAccounts, { listId: typedListId }),
      convex.query(api.abm.listPlays, { listId: typedListId }),
    ]);
    if (mode(args) === "json") {
      return printJson({ stats, list, accounts, candidateAccounts, plays });
    }
    if (!list) {
      console.log("ABM list not found.");
      return;
    }
    printRows([
      { field: "Name", value: list.name },
      { field: "Tier", value: label(list.tier) },
      { field: "Status", value: label(list.status) },
      { field: "Accounts", value: accounts.length },
      { field: "Candidate accounts", value: candidateAccounts.length },
      { field: "Plays", value: plays.length },
    ]);
    console.log("\nAccounts");
    printRows(
      accounts.slice(0, 25).map((account) => ({
        account: account.accountName ?? "Unknown",
        owner: account.ownerName ?? "-",
        status: label(account.status),
        engagement: account.engagementScore ?? 0,
      })),
    );
    return;
  }

  if (mode(args) === "json") return printJson({ stats, lists });
  printRows([
    { metric: "ABM lists", value: stats.totalLists },
    { metric: "Target accounts", value: stats.totalAccounts },
  ]);
  console.log("\nLists");
  printRows(
    lists.map((list) => ({
      id: list._id,
      name: list.name,
      tier: label(list.tier),
      status: label(list.status),
      accounts: list.accountCount,
    })),
  );
  console.log("\nUse `npm run gtm -- abm --list <id>` for accounts and plays.");
}

async function leads(args: string[]) {
  const convex = client();
  const modelId = option(args, "--model");

  if (args.includes("--generate")) {
    const result = await convex.action(api.leadScoring.generateFromCrm, {});
    if (mode(args) === "json") return printJson(result);
    printRows([
      { metric: "Created", value: result.created },
      { metric: "Updated", value: result.updated },
      { metric: "Scored", value: result.scored },
      { metric: "Model id", value: result.modelId },
    ]);
    return;
  }

  const typedModelId = modelId as Id<"leadScoringModels"> | null;
  const [models, scores, routingRules] = await Promise.all([
    convex.query(api.leadScoring.listModels, {}),
    convex.query(api.leadScoring.listScores, {
      modelId: typedModelId ?? undefined,
    }),
    convex.query(api.leadScoring.listRoutingRules, {}),
  ]);
  if (mode(args) === "json") {
    return printJson({ models, scores, routingRules });
  }

  printRows([
    { metric: "Models", value: models.length },
    { metric: "Scores", value: scores.length },
    { metric: "Routing rules", value: routingRules.length },
  ]);
  console.log("\nTop scores");
  printRows(
    scores.slice(0, 25).map((score) => ({
      contact: score.contactName,
      account: score.accountName ?? "-",
      score: score.score,
      grade: label(score.grade),
      owner: score.ownerName ?? "-",
    })),
  );
}

async function health(args: string[]) {
  const convex = client();
  const healthFilter = option(args, "--health");
  const health =
    healthFilter === "healthy" ||
    healthFilter === "at_risk" ||
    healthFilter === "churning"
      ? healthFilter
      : undefined;

  if (args.includes("--generate")) {
    const result = await convex.mutation(api.customerHealth.generateFromCrm, {});
    if (mode(args) === "json") return printJson(result);
    printRows([
      { metric: "Created", value: result.created },
      { metric: "Updated", value: result.updated },
      { metric: "Scored", value: result.scored },
      { metric: "Config id", value: result.configId },
    ]);
    return;
  }

  const [configs, stats, scores] = await Promise.all([
    convex.query(api.customerHealth.listConfigs, {}),
    convex.query(api.customerHealth.getStats, {}),
    health
      ? convex.query(api.customerHealth.listByHealth, { health })
      : convex.query(api.customerHealth.listScores, {}),
  ]);
  if (mode(args) === "json") return printJson({ configs, stats, scores });

  printRows([
    { metric: "Healthy", value: stats.healthy },
    { metric: "At risk", value: stats.atRisk },
    { metric: "Churning", value: stats.churning },
    { metric: "ARR at risk", value: money(stats.totalArrAtRisk) },
    { metric: "Configs", value: configs.length },
  ]);
  console.log("\nScores");
  printRows(
    scores.slice(0, 25).map((score) => ({
      account: score.accountName,
      health: label(score.health),
      score: score.overallScore,
      arr: money(score.arrAmount),
      renewal: score.renewalDate ?? "-",
    })),
  );
}

async function competitive(args: string[]) {
  const convex = client();
  const competitorId = option(args, "--competitor");

  if (args.includes("--generate")) {
    const result = await convex.mutation(api.competitive.generateFromDeals, {});
    if (mode(args) === "json") return printJson(result);
    printRows([
      { metric: "Competitors created", value: result.competitorsCreated },
      { metric: "Competitors updated", value: result.competitorsUpdated },
      { metric: "Battlecards created", value: result.battlecardsCreated },
      { metric: "Win/loss created", value: result.winLossCreated },
    ]);
    return;
  }

  const typedCompetitorId = competitorId as Id<"competitors"> | null;
  const [stats, competitors, battlecards, winLoss] = await Promise.all([
    convex.query(api.competitive.getWinLossStats, {}),
    convex.query(api.competitive.listCompetitors, {}),
    convex.query(api.competitive.listBattlecards, {
      competitorId: typedCompetitorId ?? undefined,
    }),
    convex.query(api.competitive.listWinLoss, {}),
  ]);
  if (mode(args) === "json") {
    return printJson({ stats, competitors, battlecards, winLoss });
  }

  printRows([
    { metric: "Competitors", value: competitors.length },
    { metric: "Battlecards", value: battlecards.length },
    { metric: "Wins", value: stats.wins },
    { metric: "Losses", value: stats.losses },
  ]);
  console.log("\nCompetitors");
  printRows(
    competitors.map((competitor) => ({
      id: competitor._id,
      name: competitor.name,
      strengths: competitor.strengths?.length ?? 0,
      weaknesses: competitor.weaknesses?.length ?? 0,
    })),
  );
  console.log("\nRecent win/loss");
  printRows(
    winLoss.slice(0, 25).map((record) => ({
      deal: record.dealName,
      outcome: label(record.outcome),
      competitor: record.competitorName,
      reason: record.primaryReason ?? "-",
    })),
  );
}

async function research(args: string[]) {
  const convex = client();
  const accountId = option(args, "--account");

  if (args.includes("--generate")) {
    const result = await convex.mutation(api.research.generateFromCrm, {});
    if (mode(args) === "json") return printJson(result);
    printRows([
      { metric: "Created", value: result.created },
      { metric: "Updated", value: result.updated },
      { metric: "Enriched", value: result.enriched },
    ]);
    return;
  }

  if (accountId) {
    const enrichment = await convex.query(api.research.getForAccount, {
      accountId: accountId as Id<"crmAccounts">,
    });
    if (mode(args) === "json") return printJson({ enrichment });
    if (!enrichment) {
      console.log("Enrichment not found.");
      return;
    }
    printRows([
      { field: "Source", value: label(enrichment.source) },
      { field: "Signals", value: enrichment.signals?.length ?? 0 },
      { field: "Tech stack", value: enrichment.techStack?.length ?? 0 },
      { field: "Last enriched", value: enrichment.lastEnrichedAt },
    ]);
    return;
  }

  const enrichments = await convex.query(api.research.listEnrichments, {});
  if (mode(args) === "json") return printJson(enrichments);
  printRows(
    enrichments.map((enrichment) => ({
      account: enrichment.accountName ?? "-",
      source: label(enrichment.source),
      signals: enrichment.signals?.length ?? 0,
      tech: enrichment.techStack?.length ?? 0,
      lastEnriched: enrichment.lastEnrichedAt,
    })),
  );
}

async function icp(args: string[]) {
  const convex = client();
  const profileId = option(args, "--profile");

  if (args.includes("--generate")) {
    const result = await convex.action(api.icp.generateFromCrm, {});
    if (mode(args) === "json") return printJson(result);
    printRows([
      { metric: "Created", value: result.created },
      { metric: "Updated", value: result.updated },
      { metric: "Scored", value: result.scored },
      { metric: "Profile id", value: result.profileId },
    ]);
    return;
  }

  const typedProfileId = profileId as Id<"icpProfiles"> | null;
  const [profiles, scores, topAccounts] = await Promise.all([
    convex.query(api.icp.listProfiles, {}),
    convex.query(api.icp.listScores, {
      profileId: typedProfileId ?? undefined,
    }),
    convex.query(api.icp.getTopAccounts, { limit: 25 }),
  ]);
  if (mode(args) === "json") {
    return printJson({ profiles, scores, topAccounts });
  }

  printRows([
    { metric: "Profiles", value: profiles.length },
    { metric: "Scores", value: scores.length },
    { metric: "Top accounts", value: topAccounts.length },
  ]);
  console.log("\nProfiles");
  printRows(
    profiles.map((profile) => ({
      id: profile._id,
      name: profile.name,
      default: profile.isDefault ? "yes" : "no",
      attributes: profile.attributes.length,
    })),
  );
  console.log("\nTop accounts");
  printRows(
    topAccounts.map((score) => ({
      account: score.account?.name ?? "Unknown",
      score: score.score,
      industry: score.account?.industry ?? "-",
      owner: score.account?.ownerId ? "mapped" : "-",
    })),
  );
}

async function forecasting(args: string[]) {
  const convex = client();
  const period = forecastPeriod(args);
  const [forecast, byRep] = await Promise.all([
    convex.query(api.forecasting.getCurrentForecast, period),
    convex.query(api.forecasting.getForecastByRep, period),
  ]);
  const { periodStart, periodEnd } = forecast;
  if (mode(args) === "json") {
    return printJson({ periodStart, periodEnd, forecast, byRep });
  }

  printRows([
    { metric: "Period start", value: periodStart },
    { metric: "Period end", value: periodEnd },
    { metric: "Target", value: money(forecast.targetAmount) },
    { metric: "Weighted forecast", value: money(forecast.weightedForecast) },
    { metric: "Gap to target", value: money(forecast.gapToTarget) },
    { metric: "Weighted coverage", value: pct(forecast.weightedCoverage) },
    { metric: "Status", value: label(forecast.status) },
  ]);
  console.log("\nBy rep");
  printRows(
    byRep.map((rep) => ({
      rep: rep.repName,
      target: money(rep.targetAmount),
      weighted: money(rep.weighted),
      coverage: pct(rep.weightedCoverage),
      total: money(rep.total),
    })),
  );
}

async function pipeline(args: string[]) {
  const convex = client();
  const [deals, forecast] = await Promise.all([
    convex.query(api.deals.list, {}),
    convex.query(api.forecasting.getCurrentForecast, {}),
  ]);
  const openDeals = deals.filter((deal) => !deal.isClosed);
  const categories = [
    { key: "commit", label: "Commit", weight: 0.85 },
    { key: "best_case", label: "Best Case", weight: 0.5 },
    { key: "pipeline", label: "Pipeline", weight: 0.25 },
    { key: "omit", label: "Omitted", weight: 0 },
  ].map((option) => {
    const categoryDeals = openDeals.filter(
      (deal) => (deal.forecastCategory ?? "pipeline") === option.key,
    );
    const amount = categoryDeals.reduce((sum, deal) => sum + (deal.amount ?? 0), 0);
    return {
      ...option,
      count: categoryDeals.length,
      amount,
      weighted: Math.round(amount * option.weight),
    };
  });
  const totalPipeline = openDeals.reduce((sum, deal) => sum + (deal.amount ?? 0), 0);
  const weighted = categories.reduce((sum, row) => sum + row.weighted, 0);
  const target = forecast?.targetAmount ?? 0;

  if (mode(args) === "json") {
    return printJson({
      summary: {
        totalPipeline,
        weighted,
        target,
        coverage: target > 0 ? totalPipeline / target : 0,
      },
      categories,
      deals: openDeals,
    });
  }

  printRows([
    { metric: "Open pipeline", value: money(totalPipeline) },
    { metric: "Weighted pipeline", value: money(weighted) },
    { metric: "Target", value: money(target) },
    { metric: "Coverage", value: pct(target > 0 ? totalPipeline / target : 0) },
    { metric: "Open deals", value: openDeals.length },
  ]);
  console.log("\nCategories");
  printRows(
    categories.map((category) => ({
      category: category.label,
      deals: category.count,
      amount: money(category.amount),
      weighted: money(category.weighted),
    })),
  );
}

async function team(args: string[]) {
  const convex = client();
  const userId = option(args, "--user");

  if (userId) {
    const updates: {
      name?: string;
      title?: string;
      role?: "admin" | "manager" | "rep" | "other";
      managerId?: Id<"users"> | null;
      isActive?: boolean;
    } = {};
    const name = option(args, "--name");
    const title = option(args, "--title");
    const role = option(args, "--role");
    const managerId = option(args, "--manager");
    const isActive = booleanOption(args, "--active");

    if (name !== null) updates.name = name;
    if (title !== null) updates.title = title;
    if (role !== null) {
      if (!["admin", "manager", "rep", "other"].includes(role)) {
        throw new Error("--role must be admin, manager, rep, or other");
      }
      updates.role = role as "admin" | "manager" | "rep" | "other";
    }
    if (managerId !== null) updates.managerId = managerId as Id<"users">;
    if (args.includes("--clear-manager")) updates.managerId = null;
    if (isActive !== undefined) updates.isActive = isActive;

    if (Object.keys(updates).length === 0) {
      throw new Error(
        "team --user <id> requires one of --name, --title, --role, --manager, --clear-manager, or --active",
      );
    }

    await convex.mutation(api.users.update, {
      userId: userId as Id<"users">,
      ...updates,
    });
    const result = { userId, updates };
    if (mode(args) === "json") return printJson(result);
    printRows([
      { field: "User", value: userId },
      { field: "Updated fields", value: Object.keys(updates).join(", ") },
    ]);
    return;
  }

  const members = await convex.query(api.users.list, {});
  const activeMembers = members.filter((member) => member.isActive);
  const managers = activeMembers.filter(
    (member) => member.role === "admin" || member.role === "manager",
  );
  const reps = activeMembers.filter((member) => member.role === "rep");
  if (mode(args) === "json") {
    return printJson({
      summary: {
        members: members.length,
        activeMembers: activeMembers.length,
        managers: managers.length,
        reps: reps.length,
      },
      members,
    });
  }

  printRows([
    { metric: "Members", value: members.length },
    { metric: "Active members", value: activeMembers.length },
    { metric: "Managers", value: managers.length },
    { metric: "Reps", value: reps.length },
  ]);
  console.log("\nRoster");
  printRows(
    members.map((member) => ({
      id: member._id,
      name: member.name,
      role: label(member.role),
      title: member.title ?? "-",
      active: member.isActive ? "yes" : "no",
    })),
  );
}

async function settings(args: string[]) {
  const convex = client();
  const updates: {
    name?: string;
    industry?: string;
    fiscalYearStartMonth?: number;
    defaultCurrency?: string;
    timezone?: string;
    syncSchedule?: "daily" | "weekly" | "monthly";
    hierarchySource?: "salesforce" | "hubspot" | "csv" | "manual";
  } = {};
  const name = option(args, "--name");
  const industry = option(args, "--industry");
  const fiscalYearStartMonth = numericOption(args, "--fiscal-start");
  const defaultCurrency = option(args, "--currency");
  const timezone = option(args, "--timezone");
  const syncSchedule = option(args, "--sync-schedule");
  const hierarchySource = option(args, "--hierarchy-source");

  if (name !== null) updates.name = name;
  if (industry !== null) updates.industry = industry;
  if (fiscalYearStartMonth !== undefined) {
    updates.fiscalYearStartMonth = fiscalYearStartMonth;
  }
  if (defaultCurrency !== null) updates.defaultCurrency = defaultCurrency;
  if (timezone !== null) updates.timezone = timezone;
  if (syncSchedule !== null) {
    if (!["daily", "weekly", "monthly"].includes(syncSchedule)) {
      throw new Error("--sync-schedule must be daily, weekly, or monthly");
    }
    updates.syncSchedule = syncSchedule as "daily" | "weekly" | "monthly";
  }
  if (hierarchySource !== null) {
    if (!["salesforce", "hubspot", "csv", "manual"].includes(hierarchySource)) {
      throw new Error("--hierarchy-source must be salesforce, hubspot, csv, or manual");
    }
    updates.hierarchySource = hierarchySource as
      | "salesforce"
      | "hubspot"
      | "csv"
      | "manual";
  }

  if (Object.keys(updates).length > 0) {
    const organizationId = await convex.mutation(
      api.organizations.updateSettings,
      updates,
    );
    const result = { organizationId, updates };
    if (mode(args) === "json") return printJson(result);
    printRows([
      { field: "Organization", value: organizationId },
      { field: "Updated fields", value: Object.keys(updates).join(", ") },
    ]);
    return;
  }

  const data = await convex.query(api.organizations.current, {});
  if (mode(args) === "json") return printJson(data);
  if (!data) {
    console.log("No organization settings available. Check auth or demo seed settings.");
    return;
  }

  printRows([
    { setting: "Organization", value: data.name },
    { setting: "Industry", value: data.industry ?? "-" },
    { setting: "Fiscal year start", value: data.fiscalYearStartMonth },
    { setting: "Currency", value: data.defaultCurrency },
    { setting: "Timezone", value: data.timezone },
    { setting: "CRM hierarchy source", value: label(data.hierarchySource) },
    { setting: "Sync schedule", value: label(data.syncSchedule) },
  ]);
}

async function mvpAudit(args: string[]) {
  const convex = client();
  const context = runtimeContext();
  const uiAudit = sharedUiAudit();
  const surfaceAudit = moduleSurfaceAudit();
  const month = currentMonthRange();
  const quarter = currentQuarterRange();
  const fiscalYear = currentFiscalYear();
  const seedAttempt = args.includes("--seed-demo")
    ? await attemptDemoSeed(convex)
    : null;

  const captures = await Promise.all([
    capture("organization", () => convex.query(api.organizations.current, {})),
    capture("deals", () => convex.query(api.deals.list, {})),
    capture("users", () => convex.query(api.users.list, {})),
    capture("integrations", async () => {
      const [hubspot, salesforce, syncRuns] = await Promise.all([
        convex.query(api.hubspot.getConnection, {}),
        convex.query(api.salesforce.getConnection, {}),
        convex.query(api.integrations.listSyncRuns, { limit: 10 }),
      ]);
      return { hubspot, salesforce, syncRuns };
    }),
    capture("accounts", () => convex.query(api.accounts.context, {})),
    capture("forecasting", async () => {
      const [forecast, byRep] = await Promise.all([
        convex.query(api.forecasting.getCurrentForecast, {
          periodStart: quarter.start,
          periodEnd: quarter.end,
        }),
        convex.query(api.forecasting.getForecastByRep, {
          periodStart: quarter.start,
          periodEnd: quarter.end,
        }),
      ]);
      return { forecast, byRep };
    }),
    capture("abm", async () => {
      const [stats, lists] = await Promise.all([
        convex.query(api.abm.getStats, {}),
        convex.query(api.abm.listLists, {}),
      ]);
      const firstList = lists[0] ?? null;
      const accounts = firstList
        ? await convex.query(api.abm.listAccounts, { listId: firstList._id })
        : [];
      return { stats, lists, accounts };
    }),
    capture("leads", async () => {
      const [models, scores, routingRules] = await Promise.all([
        convex.query(api.leadScoring.listModels, {}),
        convex.query(api.leadScoring.listScores, {}),
        convex.query(api.leadScoring.listRoutingRules, {}),
      ]);
      return { models, scores, routingRules };
    }),
    capture("icp", async () => {
      const [profiles, scores, topAccounts] = await Promise.all([
        convex.query(api.icp.listProfiles, {}),
        convex.query(api.icp.listScores, {}),
        convex.query(api.icp.getTopAccounts, { limit: 25 }),
      ]);
      return { profiles, scores, topAccounts };
    }),
    capture("health", async () => {
      const [configs, stats, scores] = await Promise.all([
        convex.query(api.customerHealth.listConfigs, {}),
        convex.query(api.customerHealth.getStats, {}),
        convex.query(api.customerHealth.listScores, {}),
      ]);
      return { configs, stats, scores };
    }),
    capture("competitive", async () => {
      const [stats, competitors, battlecards, winLoss] = await Promise.all([
        convex.query(api.competitive.getWinLossStats, {}),
        convex.query(api.competitive.listCompetitors, {}),
        convex.query(api.competitive.listBattlecards, {}),
        convex.query(api.competitive.listWinLoss, {}),
      ]);
      return { stats, competitors, battlecards, winLoss };
    }),
    capture("research", () => convex.query(api.research.listEnrichments, {})),
  ]);

  const byName = new Map(captures.map((result) => [result.name, result]));
  const org = dataFrom<Record<string, any>>(byName, "organization");
  const dealRows = rows(dataFrom(byName, "deals"));
  const userRows = rows(dataFrom(byName, "users"));
  const integrationsData = dataFrom<Record<string, any>>(byName, "integrations");
  const accountsData = dataFrom<Record<string, any>>(byName, "accounts");
  const forecastData = dataFrom<Record<string, any>>(byName, "forecasting");
  const abmData = dataFrom<Record<string, any>>(byName, "abm");
  const leadData = dataFrom<Record<string, any>>(byName, "leads");
  const icpData = dataFrom<Record<string, any>>(byName, "icp");
  const healthData = dataFrom<Record<string, any>>(byName, "health");
  const competitiveData = dataFrom<Record<string, any>>(byName, "competitive");
  const enrichmentRows = rows(dataFrom(byName, "research"));

  const openDeals = dealRows.filter((deal) => !deal.isClosed);
  const wonDeals = dealRows.filter((deal) => deal.isWon);
  const activeUsers = userRows.filter((user) => user.isActive && !user.isHidden);
  const accountCount =
    accountsData?.summary?.accounts ?? rows(accountsData?.accounts).length;
  const connectedCrm =
    Boolean(integrationsData?.hubspot) || Boolean(integrationsData?.salesforce);
  const syncRuns = rows(integrationsData?.syncRuns);

  const modules: AuditModule[] = [
    auditModule({
      area: "CRM",
      module: "Integrations",
      ready: connectedCrm || accountCount > 0 || dealRows.length > 0,
      partial: syncRuns.length > 0,
      error: errorFrom(byName, "integrations"),
      signals: [
        `connections ${connectedCrm ? "yes" : "no"}`,
        `syncRuns ${syncRuns.length}`,
        `accounts ${accountCount}`,
        `deals ${dealRows.length}`,
      ],
      gaps: connectedCrm || accountCount > 0 ? [] : ["No CRM connection or synced/demo CRM objects"],
      nextAction: "Connect or seed CRM data",
    }),
    auditModule({
      area: "Admin",
      module: "Settings",
      ready:
        Boolean(org) &&
        Boolean(org?.defaultCurrency) &&
        Boolean(org?.timezone) &&
        isPresent(org?.fiscalYearStartMonth),
      partial: Boolean(org),
      error: errorFrom(byName, "organization"),
      signals: [
        `organization ${org ? "yes" : "no"}`,
        `currency ${org?.defaultCurrency ?? "-"}`,
        `timezone ${org?.timezone ?? "-"}`,
        `fiscalStart ${org?.fiscalYearStartMonth ?? "-"}`,
      ],
      gaps:
        org &&
        org.defaultCurrency &&
        org.timezone &&
        isPresent(org.fiscalYearStartMonth)
          ? []
          : ["Missing organization operating defaults"],
      nextAction: "Set organization defaults",
    }),
    auditModule({
      area: "CRM",
      module: "Accounts",
      ready: accountCount > 0,
      partial: Boolean(accountsData),
      error: errorFrom(byName, "accounts"),
      signals: [
        `accounts ${accountCount}`,
        `assigned ${accountsData?.summary?.assignedAccounts ?? 0}`,
        `contacts ${accountsData?.summary?.contacts ?? 0}`,
      ],
      gaps: accountCount > 0 ? [] : ["No CRM account rows"],
      nextAction: "Sync CRM accounts or seed demo data",
    }),
    auditModule({
      area: "CRM",
      module: "Team",
      ready: activeUsers.length > 0,
      partial: userRows.length > 0,
      error: errorFrom(byName, "users"),
      signals: [
        `users ${userRows.length}`,
        `active ${activeUsers.length}`,
        `reps ${activeUsers.filter((user) => user.role === "rep").length}`,
      ],
      gaps: activeUsers.length > 0 ? [] : ["No active team members"],
      nextAction: "Sync CRM owners or seed team data",
    }),
    auditModule({
      area: "Revenue",
      module: "Deals",
      ready: dealRows.length > 0,
      partial: wonDeals.length > 0 || openDeals.length > 0,
      error: errorFrom(byName, "deals"),
      signals: [
        `deals ${dealRows.length}`,
        `open ${openDeals.length}`,
        `won ${wonDeals.length}`,
      ],
      gaps: dealRows.length > 0 ? [] : ["No CRM-inherited opportunities"],
      nextAction: "Sync opportunities from CRM",
    }),
    auditModule({
      area: "Revenue",
      module: "Pipeline",
      ready: openDeals.length > 0,
      partial: dealRows.length > 0,
      error: errorFrom(byName, "deals"),
      signals: [
        `openDeals ${openDeals.length}`,
        `openPipeline ${money(openDeals.reduce((sum, deal) => sum + (deal.amount ?? 0), 0))}`,
      ],
      gaps: openDeals.length > 0 ? [] : ["No open opportunities"],
      nextAction: "Sync open pipeline or review closed statuses",
    }),
    auditModule({
      area: "Revenue",
      module: "Forecasting",
      ready: rows(forecastData?.byRep).length > 0,
      partial: isPresent(forecastData?.forecast),
      error: errorFrom(byName, "forecasting"),
      signals: [
        `repRows ${rows(forecastData?.byRep).length}`,
        `weighted ${money(forecastData?.forecast?.weightedForecast ?? 0)}`,
        `status ${label(forecastData?.forecast?.status)}`,
      ],
      gaps: rows(forecastData?.byRep).length > 0 ? [] : ["No rep forecast rows"],
      nextAction: "Sync period deals and owner mappings",
    }),
    auditModule({
      area: "Intelligence",
      module: "Research",
      ready: enrichmentRows.length > 0,
      partial: accountCount > 0,
      error: errorFrom(byName, "research"),
      signals: [`enrichments ${enrichmentRows.length}`, `accounts ${accountCount}`],
      gaps: enrichmentRows.length > 0 ? [] : ["No account enrichments"],
      nextAction: "Enrich CRM accounts",
    }),
    auditModule({
      area: "Intelligence",
      module: "ICP",
      ready: rows(icpData?.profiles).length > 0 && rows(icpData?.scores).length > 0,
      partial: rows(icpData?.profiles).length > 0 || rows(icpData?.topAccounts).length > 0,
      error: errorFrom(byName, "icp"),
      signals: [
        `profiles ${rows(icpData?.profiles).length}`,
        `scores ${rows(icpData?.scores).length}`,
        `topAccounts ${rows(icpData?.topAccounts).length}`,
      ],
      gaps: rows(icpData?.scores).length > 0 ? [] : ["No scored accounts"],
      nextAction: "Generate ICP profile and account scores",
    }),
    auditModule({
      area: "Intelligence",
      module: "Lead Scoring",
      ready: rows(leadData?.models).length > 0 && rows(leadData?.scores).length > 0,
      partial: rows(leadData?.models).length > 0 || rows(leadData?.routingRules).length > 0,
      error: errorFrom(byName, "leads"),
      signals: [
        `models ${rows(leadData?.models).length}`,
        `scores ${rows(leadData?.scores).length}`,
        `routing ${rows(leadData?.routingRules).length}`,
      ],
      gaps: rows(leadData?.scores).length > 0 ? [] : ["No scored leads"],
      nextAction: "Generate lead scores and routing defaults",
    }),
    auditModule({
      area: "Intelligence",
      module: "ABM",
      ready: rows(abmData?.lists).length > 0,
      partial: rows(abmData?.accounts).length > 0 || (abmData?.stats?.totalAccounts ?? 0) > 0,
      error: errorFrom(byName, "abm"),
      signals: [
        `lists ${rows(abmData?.lists).length}`,
        `accounts ${abmData?.stats?.totalAccounts ?? rows(abmData?.accounts).length}`,
      ],
      gaps: rows(abmData?.lists).length > 0 ? [] : ["No ABM target lists"],
      nextAction: "Generate ABM from CRM accounts",
    }),
    auditModule({
      area: "Intelligence",
      module: "Competitive",
      ready: rows(competitiveData?.competitors).length > 0,
      partial:
        rows(competitiveData?.battlecards).length > 0 ||
        rows(competitiveData?.winLoss).length > 0,
      error: errorFrom(byName, "competitive"),
      signals: [
        `competitors ${rows(competitiveData?.competitors).length}`,
        `battlecards ${rows(competitiveData?.battlecards).length}`,
        `winLoss ${rows(competitiveData?.winLoss).length}`,
      ],
      gaps: rows(competitiveData?.competitors).length > 0 ? [] : ["No competitors"],
      nextAction: "Generate competitive intel from closed deals",
    }),
    auditModule({
      area: "Intelligence",
      module: "Customer Health",
      ready: rows(healthData?.scores).length > 0,
      partial: rows(healthData?.configs).length > 0 || Boolean(healthData?.stats),
      error: errorFrom(byName, "health"),
      signals: [
        `configs ${rows(healthData?.configs).length}`,
        `scores ${rows(healthData?.scores).length}`,
        `atRisk ${healthData?.stats?.atRiskCount ?? 0}`,
      ],
      gaps: rows(healthData?.scores).length > 0 ? [] : ["No health scores"],
      nextAction: "Generate customer health scores",
    }),
  ];

  const totals = {
    ready: modules.filter((module) => module.status === "ready").length,
    partial: modules.filter((module) => module.status === "partial").length,
    needsData: modules.filter((module) => module.status === "needs_data").length,
    error: modules.filter((module) => module.status === "error").length,
    total: modules.length,
  };
  const generatedAt = new Date().toISOString();
  const result = {
    generatedAt,
    organization: org
      ? {
          id: org._id,
          name: org.name,
          fiscalYearStartMonth: org.fiscalYearStartMonth,
          syncSchedule: org.syncSchedule,
        }
      : null,
    runtime: context,
    periods: {
      month: month.label,
      quarter: quarter.label,
      fiscalYear,
    },
    seedAttempt,
    totals,
    uiPrimitives: uiAudit,
    surfaces: surfaceAudit,
    strictPass:
      totals.ready === totals.total && uiAudit.ready && surfaceAudit.ready,
    modules,
  };

  if (mode(args) === "json") {
    printJson(result);
  } else {
    printRows([
      { metric: "Ready modules", value: `${totals.ready}/${totals.total}` },
      { metric: "Partial modules", value: totals.partial },
      { metric: "Needs data", value: totals.needsData },
      { metric: "Errors", value: totals.error },
      { metric: "Shared UI", value: uiAudit.ready ? "ready" : "needs data" },
      {
        metric: "Module surfaces",
        value: `${surfaceAudit.totals.ready}/${surfaceAudit.totals.total}`,
      },
      { metric: "Convex target", value: context.convexTarget },
      { metric: "Auth token", value: context.authToken },
      { metric: "Month", value: month.label },
      { metric: "Quarter", value: quarter.label },
    ]);
    if (context.warnings.length > 0) {
      console.log(`\nWarnings\n${context.warnings.map((warning) => `- ${warning}`).join("\n")}`);
    }
    if (seedAttempt && !seedAttempt.ok) {
      console.log(`\n${seedAttempt.hint}\n`);
    }
    console.log("");
    printRows(
      modules.map((module) => ({
        area: module.area,
        module: module.module,
        status: module.status,
        signals: module.signals.join("; "),
        gaps: module.gaps.length > 0 ? module.gaps.join("; ") : "-",
        next: module.nextAction,
      })),
    );
    console.log("\nShared UI primitives");
    printRows(
      uiAudit.checks.map((check) => ({
        primitive: check.primitive,
        status: check.ready ? "ready" : "needs_data",
        signals: check.signals.join("; "),
        gaps: check.gaps.length > 0 ? check.gaps.slice(0, 5).join("; ") : "-",
      })),
    );
    console.log("\nModule surfaces");
    printRows(
      surfaceAudit.modules.map((module) => ({
        area: module.area,
        module: module.module,
        status: module.ready ? "ready" : "needs_data",
        signals: module.signals.join("; "),
        gaps: module.gaps.length > 0 ? module.gaps.join("; ") : "-",
      })),
    );
  }

  if (args.includes("--strict") && !result.strictPass) {
    process.exitCode = 1;
  }
}

async function seedDemo(args: string[]) {
  const seed = await attemptDemoSeed();
  if (mode(args) === "json") {
    if (!seed.ok) process.exitCode = 1;
    return printJson(seed);
  }
  if (!seed.ok) {
    console.error(seed.error);
    console.error(`\n${seed.hint}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Seeded demo workspace for org ${seed.result.orgId}`);
}

async function interactionAudit(args: string[]) {
  const audit = interactionSurfaceAudit();
  const output = {
    generatedAt: new Date().toISOString(),
    ...audit,
  };

  if (mode(args) === "json") {
    printJson(output);
  } else {
    printRows([
      {
        metric: "Dashboard interactions",
        value: audit.totals.interactions,
      },
      {
        metric: "Full API/CLI/MCP parity",
        value: `${audit.totals.fullParity}/${audit.totals.interactions}`,
      },
      {
        metric: "API coverage",
        value: `${audit.totals.api}/${audit.totals.interactions}`,
      },
      {
        metric: "CLI coverage",
        value: `${audit.totals.cli}/${audit.totals.interactions}`,
      },
      {
        metric: "MCP coverage",
        value: `${audit.totals.mcp}/${audit.totals.interactions}`,
      },
    ]);
    console.log("");
    printRows(
      audit.results.map((result) => ({
        area: result.area,
        module: result.module,
        mutation: result.mutation.replace(/^api\./, ""),
        api: result.api ? "yes" : "no",
        cli: result.cli ? "yes" : "no",
        mcp: result.mcp ? "yes" : "no",
        gaps: result.gaps.length > 0 ? result.gaps.join("; ") : "-",
        dashboard: result.dashboard,
      })),
    );
  }

  if (args.includes("--strict") && !audit.ready) {
    process.exitCode = 1;
  }
}

async function cliSmoke(args: string[]) {
  loadLocalEnv();
  const timeoutMs = numericOption(args, "--timeout-ms") ?? 15_000;
  const commands = cliSmokeCommands();
  const results: CliSmokeResult[] = [];

  for (const command of commands) {
    results.push(await runCliJsonCommand(command, timeoutMs));
  }

  const totals = {
    ready: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    total: results.length,
  };
  const output = {
    generatedAt: new Date().toISOString(),
    convexUrl: process.env.NEXT_PUBLIC_CONVEX_URL ?? "",
    authToken: process.env.FSGTM_AUTH_TOKEN ? "set" : "missing",
    timeoutMs,
    totals,
    results,
  };

  if (mode(args) === "json") {
    printJson(output);
  } else {
    printRows([
      { metric: "CLI commands ready", value: `${totals.ready}/${totals.total}` },
      { metric: "Failures", value: totals.failed },
      { metric: "Convex URL", value: output.convexUrl || "-" },
      { metric: "Auth token", value: output.authToken },
    ]);
    console.log("");
    printRows(
      results.map((result) => ({
        area: result.area,
        module: result.module,
        status: result.ok ? "ready" : "error",
        command: result.command,
        exit: result.exitCode ?? "-",
        ms: result.durationMs,
        error: result.error ?? "-",
      })),
    );
  }

  if (totals.failed > 0) process.exitCode = 1;
}

async function apiSmoke(args: string[]) {
  loadLocalEnv();
  const baseUrl = siteUrl(args);
  const timeoutMs = numericOption(args, "--timeout-ms") ?? 10_000;
  const endpoints = apiSmokeEndpoints();
  const results = await Promise.all(
    endpoints.map((endpoint) => smokeApiEndpoint(endpoint, baseUrl, timeoutMs)),
  );
  const totals = {
    ready: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    total: results.length,
  };
  const output = {
    generatedAt: new Date().toISOString(),
    siteUrl: baseUrl,
    authToken: process.env.FSGTM_AUTH_TOKEN ? "set" : "missing",
    timeoutMs,
    totals,
    results,
  };

  if (mode(args) === "json") {
    printJson(output);
  } else {
    printRows([
      { metric: "API routes ready", value: `${totals.ready}/${totals.total}` },
      { metric: "Failures", value: totals.failed },
      { metric: "Site URL", value: baseUrl },
      { metric: "Auth token", value: output.authToken },
    ]);
    console.log("");
    printRows(
      results.map((result) => ({
        area: result.area,
        module: result.module,
        status: result.ok ? "ready" : "error",
        path: result.path,
        http: result.status ?? "-",
        ms: result.durationMs,
        error: result.error ?? "-",
      })),
    );
  }

  if (totals.failed > 0) process.exitCode = 1;
}

async function uiSmoke(args: string[]) {
  loadLocalEnv();
  const baseUrl = siteUrl(args);
  const timeoutMs = numericOption(args, "--timeout-ms") ?? 10_000;
  const routes = dashboardSmokeRoutes();
  const results = await Promise.all(
    routes.map((route) => smokeDashboardRoute(route, baseUrl, timeoutMs)),
  );
  const totals = {
    ready: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    total: results.length,
  };
  const output = {
    generatedAt: new Date().toISOString(),
    siteUrl: baseUrl,
    timeoutMs,
    totals,
    results,
  };

  if (mode(args) === "json") {
    printJson(output);
  } else {
    printRows([
      { metric: "Dashboard routes ready", value: `${totals.ready}/${totals.total}` },
      { metric: "Failures", value: totals.failed },
      { metric: "Site URL", value: baseUrl },
    ]);
    console.log("");
    printRows(
      results.map((result) => ({
        area: result.area,
        module: result.module,
        status: result.ok ? "ready" : "error",
        path: result.path,
        http: result.status ?? "-",
        ms: result.durationMs,
        error: result.error ?? "-",
      })),
    );
  }

  if (totals.failed > 0) process.exitCode = 1;
}

async function mcpSmoke(args: string[]) {
  loadLocalEnv();
  const timeoutMs = numericOption(args, "--timeout-ms") ?? 15_000;
  const tools = mcpSmokeTools();
  const client = new Client(
    { name: "fullstackgtm-mcp-smoke", version: "0.1.0" },
    { capabilities: {} },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--experimental-strip-types",
      resolve(process.cwd(), "scripts/fsgtm-mcp.ts"),
    ],
    cwd: process.cwd(),
    env: stringEnv(),
    stderr: "pipe",
  });
  const stderrChunks: Buffer[] = [];
  transport.stderr?.on("data", (chunk) => {
    stderrChunks.push(Buffer.from(chunk));
  });

  const results: McpSmokeResult[] = [];
  try {
    await client.connect(transport, { timeout: timeoutMs });
    const listed = await client.listTools({}, { timeout: timeoutMs });
    const listedTools = new Set(listed.tools.map((tool) => tool.name));
    for (const tool of tools) {
      results.push(await callMcpReadTool(client, tool, listedTools, timeoutMs));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const tool of tools) {
      results.push({
        area: tool.area,
        module: tool.module,
        tool: tool.tool,
        ok: false,
        listed: false,
        durationMs: 0,
        error: message,
      });
    }
  } finally {
    await client.close().catch(() => {});
  }

  const stderrText = Buffer.concat(stderrChunks).toString("utf8").trim();
  const totals = {
    ready: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    total: results.length,
  };
  const output = {
    generatedAt: new Date().toISOString(),
    convexUrl: process.env.NEXT_PUBLIC_CONVEX_URL ?? "",
    authToken: process.env.FSGTM_AUTH_TOKEN ? "set" : "missing",
    timeoutMs,
    serverStderr: stderrText,
    totals,
    results,
  };

  if (mode(args) === "json") {
    printJson(output);
  } else {
    printRows([
      { metric: "MCP tools ready", value: `${totals.ready}/${totals.total}` },
      { metric: "Failures", value: totals.failed },
      { metric: "Convex URL", value: output.convexUrl || "-" },
      { metric: "Auth token", value: output.authToken },
    ]);
    if (stderrText) console.log(`\nServer stderr\n${stderrText}`);
    console.log("");
    printRows(
      results.map((result) => ({
        area: result.area,
        module: result.module,
        status: result.ok ? "ready" : "error",
        tool: result.tool,
        listed: result.listed ? "yes" : "no",
        ms: result.durationMs,
        error: result.error ?? "-",
      })),
    );
  }

  if (totals.failed > 0) process.exitCode = 1;
}

function jsonOption(args: string[], name: string) {
  const value = option(args, name);
  if (!value) return {};
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

async function mutationCommand(args: string[]) {
  const name = option(args, "--name") ?? args[1];
  if (!name) throw new Error("mutation requires --name <api.module.mutation>");
  const mutationRef = getGtmMutationReference(name);
  if (!mutationRef) {
    return printCliError(
      "USER_INPUT",
      `Mutation is not allowlisted: ${name}`,
      ["Run `npm run gtm -- mutation --help --json` or inspect `npm run gtm -- capabilities --json` for the allowlist."],
      args,
    );
  }
  const payload = jsonOption(args, "--args");
  if (!args.includes("--apply")) {
    // Echo, not "dry run": args are not validated against the mutation's
    // schema (Convex's generated api is anyApi — no runtime arg metadata), so
    // the preview is named honestly. Typed previews are the patch-plan surface.
    return printJson({ ok: true, mode: "echo", validated: false, mutation: name, args: payload, allowedMutations: gtmMutationNames() });
  }
  const result = await client().mutation(mutationRef as any, payload as any);
  return printJson(result);
}

async function patchPlans(args: string[]) {
  const patchPlanId = option(args, "--patch-plan") ?? args[1];
  const status = option(args, "--status");
  if (args.includes("--approve") || args.includes("--reject")) {
    if (!patchPlanId) throw new Error("patch-plans --approve/--reject requires --patch-plan <id>");
    const result = await client().mutation(api.patchPlans.approve, {
      patchPlanId: patchPlanId as Id<"patchPlans">,
      decision: args.includes("--approve") ? "approved" : "rejected",
    });
    printJson(result);
    return;
  }
  if (args.includes("--apply")) {
    if (!patchPlanId) throw new Error("patch-plans --apply requires --patch-plan <id>");
    const result = await client().action(api.patchPlanActions.apply, {
      patchPlanId: patchPlanId as Id<"patchPlans">,
    });
    printJson(result);
    return;
  }
  if (patchPlanId) {
    const result = await client().query(api.patchPlans.get, {
      patchPlanId: patchPlanId as Id<"patchPlans">,
    });
    printJson(result);
    return;
  }
  const result = await client().query(api.patchPlans.list, {
    limit: Number(option(args, "--limit") ?? 50),
    status: status as any,
  });
  printJson(result);
}

async function describeOperations(_args: string[]) {
  const result = await client().query(api.gtm.describe, {});
  printJson(result);
}

async function findOperation(args: string[]) {
  const resource = option(args, "--resource") ?? args[1];
  if (!resource) throw new Error("find requires --resource <name>");
  const result = await client().query(api.gtm.find, {
    resource,
    args: jsonOption(args, "--args"),
  });
  printJson(result);
}

async function setOperation(args: string[]) {
  const operation = option(args, "--operation") ?? args[1];
  if (!operation) throw new Error("set requires --operation <name>");
  const result = await client().mutation(api.gtm.set, {
    operation,
    args: jsonOption(args, "--args"),
    mode: args.includes("--apply") ? "apply" : "dry_run",
  });
  printJson(result);
}

async function doOperation(args: string[]) {
  const actionName = option(args, "--action") ?? args[1];
  if (!actionName) throw new Error("do requires --action <name>");
  const result = await client().action(api.gtm.doAction, {
    action: actionName,
    args: jsonOption(args, "--args"),
    mode: args.includes("--apply") ? "apply" : "dry_run",
  });
  printJson(result);
}

async function parseOperation(args: string[]) {
  const inputType = option(args, "--input-type") ?? args[1];
  if (!inputType) throw new Error("parse requires --input-type <name>");
  const input = option(args, "--input");
  if (!input) throw new Error("parse requires --input <json>");
  const result = await client().action(api.gtm.parse, {
    inputType,
    input: JSON.parse(input),
    mode: args.includes("--apply") ? "apply" : "dry_run",
  });
  printJson(result);
}

export async function main(args: string[] = process.argv.slice(2)) {
  const command = args[0] ?? "help";

  if (command === "help" || command === "--help" || command === "-h") {
    console.log(usage());
    return;
  }

  if (wantsCommandHelp(args) && printCommandHelp(command, args)) return;

  if (command === "summary") return summary(args);
  if (command === "deals") return deals(args);
  if (command === "abm") return abm(args);
  if (command === "leads") return leads(args);
  if (command === "health") return health(args);
  if (command === "competitive") return competitive(args);
  if (command === "research") return research(args);
  if (command === "icp") return icp(args);
  if (command === "forecasting") return forecasting(args);
  if (command === "pipeline") return pipeline(args);
  if (command === "team") return team(args);
  if (command === "integrations") return integrations(args);
  if (command === "calls") return calls(args);
  if (command === "settings") return settings(args);
  if (command === "auth") return auth(args);
  if (command === "describe") return describeOperations(args);
  if (command === "find") return findOperation(args);
  if (command === "set") return setOperation(args);
  if (command === "do") return doOperation(args);
  if (command === "parse") return parseOperation(args);
  if (command === "mutation") return mutationCommand(args);
  if (command === "patch-plans") return patchPlans(args);
  if (command === "operating-model") return operatingModel(args);
  if (command === "capabilities") return capabilities(args);
  if (command === "surface") return surfaceManifest(args);
  if (command === "robot-docs") return robotDocs(args);
  if (command === "doctor") return doctor(args);
  if (command === "mvp-audit") return mvpAudit(args);
  if (command === "interaction-audit") return interactionAudit(args);
  if (command === "cli-smoke") return cliSmoke(args);
  if (command === "ui-smoke") return uiSmoke(args);
  if (command === "api-smoke") return apiSmoke(args);
  if (command === "mcp-smoke") return mcpSmoke(args);
  if (command === "seed-demo") return seedDemo(args);

  const suggestion = suggestCommand(command);
  printCliError(
    "UNKNOWN_COMMAND",
    `Unknown command: ${command}`,
    [
      suggestion
        ? `Did you mean: npm run gtm -- ${suggestion} ${args.includes("--json") ? "--json" : ""}`.trim()
        : "Run `npm run gtm -- capabilities --json` to inspect supported commands.",
      "Run `npm run gtm -- robot-docs guide` for the agent quickstart.",
    ],
    args,
  );
}

// Run only when executed (npm run gtm), not when imported (tests call main(args) in-process).
if (process.argv[1] && realpathSync(process.argv[1]) === import.meta.filename) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    printCliError("USER_INPUT", message, ["Run `npm run gtm -- doctor --json` if this looks like an environment issue."], process.argv.slice(2));
  });
}
