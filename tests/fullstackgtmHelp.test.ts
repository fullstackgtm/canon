import assert from "node:assert/strict";
import test from "node:test";
import { cli } from "./support/cli.ts";

// Help/guidance behavior, not wording: which views exist, which stream they go
// to, and that bad flags fail closed. `Authentication (checked in order)` is
// the marker of the full reference.
const FULL_REFERENCE = /Authentication \(checked in order\)/;
const out = async (argv: string[]) => (await cli(argv)).stdout;

test("bare invoke, --help and help show one short front door; --full escapes to the reference", async () => {
  const bare = await out([]);
  assert.ok(bare.split("\n").length < 80, "front door should be compact");
  assert.doesNotMatch(bare, FULL_REFERENCE);
  assert.equal(await out(["--help"]), bare);
  assert.equal(await out(["help"]), bare);

  const full = await out(["help", "--full"]);
  assert.match(full, FULL_REFERENCE);
  assert.equal(await out(["--help", "--full"]), full);
});

test("<verb> --help and help <verb> give focused per-command help, with --full as the escape hatch", async () => {
  const focused = await out(["audit", "--help"]);
  assert.match(focused, /^fullstackgtm audit —/);
  assert.doesNotMatch(focused, FULL_REFERENCE);
  assert.match(await out(["audit", "--help", "--full"]), FULL_REFERENCE);

  assert.match(await out(["help", "resolve"]), /^fullstackgtm resolve —/);
  assert.match(await out(["help", "resolve", "--full"]), FULL_REFERENCE);
});

test("bulk-update help is intercepted before object parsing or data-source access", async () => {
  for (const args of [["bulk-update", "--help"], ["bulk-update", "-h"]]) {
    const result = await cli(args);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /--where/);
    assert.equal(result.stderr, "");
  }
});

test("unknown verb --help falls back to the short map instead of dead-ending", async () => {
  assert.equal(await out(["definitely-not-a-command", "--help"]), await out([]));
});

test("unknown command flags fail closed, even after a missing option value", async () => {
  const misspelled = await cli(["audit", "--demo", "--fail-on-critical"]);
  assert.notEqual(misspelled.status, 0, "misspelled CI gate flag must not silently pass");
  assert.match(misspelled.stderr, /Unknown flag for audit: --fail-on-critical/);
  assert.match(misspelled.stderr, /Did you mean --fail-on\?/);

  const hidden = await cli(["audit", "--out", "--fail-on-critical", "--demo"]);
  assert.notEqual(hidden.status, 0, "unknown flag must not be hidden by a prior missing --out value");
  assert.match(hidden.stderr, /Unknown flag for audit: --fail-on-critical/);

  const short = await cli(["audit", "--demo", "-x"]);
  assert.notEqual(short.status, 0, "unknown short flag must not be silently ignored");
  assert.match(short.stderr, /Unknown flag for audit: -x/);
});

test("audit's next-step guidance goes to stderr only, and not at all under --json", async () => {
  const human = await cli(["audit", "--demo", "--today", "2026-05-03"]);
  assert.match(human.stderr, /Next:/);
  assert.doesNotMatch(human.stdout, /Next:/);
  const json = await cli(["audit", "--demo", "--today", "2026-05-03", "--json"]);
  assert.doesNotMatch(json.stderr, /Next:/);
});

test("audit defaults to a compact summary; --full restores the per-operation dump", async () => {
  const summary = await out(["audit", "--demo", "--today", "2026-05-03"]);
  assert.ok(summary.split("\n").length < 40, "summary should be compact");
  assert.doesNotMatch(summary, /## Proposed Patch Operations/);

  const full = await out(["audit", "--demo", "--today", "2026-05-03", "--full"]);
  assert.ok(full.split("\n").length > summary.split("\n").length * 10, "full should be far longer");
  assert.match(full, /## Proposed Patch Operations/);
});
