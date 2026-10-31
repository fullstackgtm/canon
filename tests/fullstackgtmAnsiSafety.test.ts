import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cli } from "./support/cli.ts";

// The TUI layer's safety contract: ANSI styling and animation exist ONLY on
// interactive TTYs. Test-runner stdio is piped (no TTY), so any escape byte in
// the output is a contract violation — an agent transcript, a shell pipe, or a
// CI log would see it. The env-precedence rules themselves are unit-tested in
// fullstackgtmUi.test.ts; this file checks the CLI actually honors them. The
// same invocations run as real piped processes in .github/workflows/ci.yml (typecheck job).

const ESC = "\u001b";

// Hermetic home: no host credentials/plans/health leak into assertions.
const home = mkdtempSync(join(tmpdir(), "fsgtm-ansi-"));
const PIPED_ENV = { FSGTM_HOME: home, NO_COLOR: undefined, FORCE_COLOR: undefined, CI: undefined };

const PLAIN_INVOCATIONS: string[][] = [
  ["--help"],
  ["help", "audit"],
  ["doctor"],
  ["health"],
  ["rules"],
  ["plans", "list"],
  ["audit", "--demo"],
  ["audit", "--demo", "--full"],
  ["--version"],
];

const JSON_INVOCATIONS: string[][] = [
  ["doctor", "--json"],
  ["health", "--json"],
  ["capabilities", "--json"],
  ["audit", "--demo", "--json"],
  ["rules", "--json"],
];

test("piped human and --json invocations emit zero ANSI bytes; --json stays parseable", async () => {
  for (const args of [...PLAIN_INVOCATIONS, ...JSON_INVOCATIONS]) {
    const result = await cli(args, PIPED_ENV);
    assert.ok(!result.stdout.includes(ESC), `${args.join(" ")}: stdout carries ANSI: ${JSON.stringify(result.stdout.slice(0, 200))}`);
    assert.ok(!result.stderr.includes(ESC), `${args.join(" ")}: stderr carries ANSI: ${JSON.stringify(result.stderr.slice(0, 200))}`);
    if (args.includes("--json")) {
      assert.doesNotThrow(() => JSON.parse(result.stdout), `${args.join(" ")}: not JSON: ${result.stdout.slice(0, 200)}`);
    }
  }
});

test("FORCE_COLOR=1 opts piped stdout into color; NO_COLOR keeps it off", async () => {
  const forced = await cli(["--help"], { ...PIPED_ENV, FORCE_COLOR: "1" });
  assert.ok(forced.stdout.includes(ESC), "FORCE_COLOR=1 should enable styling");
  const noColor = await cli(["--help"], { ...PIPED_ENV, NO_COLOR: "1" });
  assert.ok(!noColor.stdout.includes(ESC));
});
