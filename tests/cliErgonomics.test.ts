import assert from "node:assert/strict";
import { test } from "node:test";
import { main as gtmMain } from "../scripts/fsgtm.ts";
import { captureCli, cli } from "./support/cli.ts";

// In-process. The same commands run as real processes (stderr-clean, parseable,
// executed-script auto-run) in .github/workflows/ci.yml (typecheck job) on every PR.
const gtm = (args: string[]) => captureCli(() => gtmMain(args));

test("gtm capabilities --json is parseable and diagnostic-clean", async () => {
  const result = await gtm(["capabilities", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.tool, "gtm");
  assert.ok(payload.commands.some((command: { name: string }) => command.name === "doctor"));
  assert.ok(payload.exitCodes.toolEnvironmentError >= 3);
});

test("gtm unknown command in JSON mode returns a structured hint", async () => {
  const result = await gtm(["summry", "--json"]);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "UNKNOWN_COMMAND");
  assert.match(payload.error.hints.join("\n"), /summary/);
});

test("gtm surface --json exposes parity manifest", async () => {
  const result = await gtm(["surface", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.ok(payload.surfaces.length > 10);
  assert.ok(payload.surfaces.some((surface: { module: string; cli: string[]; mcp: string[] }) => surface.module === "Calls" && surface.cli.includes("calls") && surface.mcp.includes("gtm_calls")));
  assert.ok(payload.surfaces.some((surface: { module: string; api: string[] }) => surface.module === "Patch Plans" && surface.api.some((path) => path.includes("patch-plans"))));
});

test("gtm per-command help is machine-readable", async () => {
  const result = await gtm(["patch-plans", "--help", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.command, "patch-plans");
  assert.equal(payload.dryRunDefault, true);
  assert.ok(payload.options.some((option: { name: string }) => option.name.includes("--approve")));
});

test("gtm mutation surface defaults to an honest echo preview and keeps interaction parity green", async () => {
  const preview = await gtm(["mutation", "--name", "api.patchPlans.approve", "--args", '{"patchPlanId":"x","decision":"approved"}', "--json"]);
  assert.equal(preview.status, 0, preview.stderr);
  const previewPayload = JSON.parse(preview.stdout);
  assert.equal(previewPayload.ok, true);
  // Not a "dry run": args are echoed without schema validation, and the
  // payload says so instead of implying a typed preview happened.
  assert.equal(previewPayload.mode, "echo");
  assert.equal(previewPayload.validated, false);

  const audit = await gtm(["interaction-audit", "--json"]);
  assert.equal(audit.status, 0, audit.stderr);
  const auditPayload = JSON.parse(audit.stdout);
  assert.equal(auditPayload.ready, true);
  assert.equal(auditPayload.totals.fullParity, auditPayload.totals.interactions);
});

test("fullstackgtm capabilities --json is parseable, derived, and npx-phrased", async () => {
  const result = await cli(["capabilities", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.tool, "fullstackgtm");
  assert.equal(payload.contract.planFirst, true);
  // The command list is derived from the HELP table, not hand-maintained —
  // these memberships are the anti-drift gate (#156's hand-written lists
  // omitted merge, snapshot, health, suggest).
  const access = new Map(payload.commands.map((command: { name: string; access: string }) => [command.name, command.access]));
  for (const name of ["fix", "bulk-update", "dedupe", "reassign", "apply", "merge", "enrich", "draft", "schedule"]) {
    assert.equal(access.get(name), "write-shaped", `${name} must be write-shaped`);
  }
  for (const name of ["audit", "report", "snapshot", "diff", "rules", "doctor", "health", "suggest", "resolve"]) {
    assert.equal(access.get(name), "read-only", `${name} must be read-only`);
  }
  // Published-package phrasing, not monorepo-dev phrasing.
  assert.ok(payload.examples.every((example: string) => example.startsWith("npx fullstackgtm")));
  assert.ok(!result.stdout.includes("npm run fullstackgtm"));
});

test("fullstackgtm unknown command in JSON mode returns a structured hint", async () => {
  const result = await cli(["audt", "--json"]);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.match(payload.error.hints.join("\n"), /audit/);
});

test("fullstackgtm per-command help is machine-readable", async () => {
  const result = await cli(["audit", "--help", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.command, "audit");
  assert.equal(payload.access, "read-only");
  assert.equal(payload.phase, "Detect");
  assert.ok(payload.options.some((option: { flag: string }) => option.flag.includes("--input")));
});

test("fullstackgtm robot-docs prints the shipped SKILL.md agent guide", async () => {
  const result = await cli(["robot-docs"]);
  assert.equal(result.status, 0, result.stderr);
  // The one maintained agent guide, not a third parallel hand-written one.
  assert.match(result.stdout, /Non-negotiable invariants/);
});
