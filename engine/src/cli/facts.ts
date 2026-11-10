// `fullstackgtm facts`: the CanonCRM agent write gate. An agent proposes a
// batch of deal facts to the paired hosted app; a person reviews them (or an
// org's verified auto-accept rule accepts them). Nothing here writes a CRM.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readFactBatch, submitFactBatch, validateFactBatch } from "../hostedFacts.ts";

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

export async function factsCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const json = rest.includes("--json");
  if (sub === "propose") {
    const path = flagValue(rest, "--in");
    if (!path) fail("Usage: fullstackgtm facts propose --in <batch.json> [--json]");
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(resolve(process.cwd(), path), "utf8"));
    } catch (error) {
      fail(`Could not read ${path}: ${(error as Error).message}`);
    }
    const checked = validateFactBatch(raw);
    if (!checked.ok) fail(`Invalid batch: ${checked.reason}`);
    const out = await submitFactBatch(checked.batch);
    if (out.status === "unpaired") fail("Not paired with the hosted app. Run `fullstackgtm login` first.");
    if (out.status === "error") fail(`Submit failed: ${out.reason}`);
    const r = out.result;
    if (json) return void console.log(JSON.stringify(r, null, 2));
    console.log(`Batch ${r.patchPlanId}: ${r.proposed} proposed, ${r.unchanged} unchanged, ${r.rejected.length} rejected.`);
    for (const x of r.rejected) console.log(`  rejected facts[${x.index}] ${x.attribute}: ${x.reason}`);
    if (r.verifying) console.log(`${r.verifying} fact(s) match an auto-accept rule and are being checked against their evidence.`);
    console.log("Proposed facts change nothing until they are accepted in the review queue.");
    return;
  }
  if (sub === "status") {
    const id = rest.find((a) => !a.startsWith("--"));
    if (!id) fail("Usage: fullstackgtm facts status <batch-id> [--json]");
    const out = await readFactBatch(id);
    if (out.status === "unpaired") fail("Not paired with the hosted app. Run `fullstackgtm login` first.");
    if (out.status === "error") fail(`Status failed: ${out.reason}`);
    const r = out.result as { status: string; counts: Record<string, number> };
    if (json) return void console.log(JSON.stringify(r, null, 2));
    console.log(`Batch ${id}: ${r.status} (${Object.entries(r.counts).map(([k, n]) => `${n} ${k}`).join(", ")})`);
    return;
  }
  fail("Usage: fullstackgtm facts propose --in <batch.json> | status <batch-id> [--json]");
}
