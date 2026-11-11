/**
 * Census: every function that appends to a ledger, so a rule added to the writer applies to every record at once. The
 * object ledger (`ledgerEntries`) takes entries only from lib/objects/write.ts: `save`, which runs every rule (field
 * ownership, unique claims, CAS, a person's hold against a CRM, a CRM's follows), and `appendHistory`, which copies a
 * history verbatim. The `facts` ledger holds what a record with no stream yet says, and the mirror of what a stream
 * says. A new appender fails here until it is listed with the reason it is allowed. tests/ledgerWriterPins.test.ts
 * pins the rules per object kind.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { IMPORT_TABLES } from "../convex/lib/workspaceArchive/importRows.ts";

const ROOT = join(import.meta.dirname, "..");

const sources = (...dirs: string[]) => dirs.flatMap((dir) => existsSync(join(ROOT, dir))
  ? readdirSync(join(ROOT, dir), { recursive: true, encoding: "utf8" }).map((f) => `${dir}/${f}`).filter((f) => /\.tsx?$/.test(f) && !f.includes("/_generated/") && !f.includes("node_modules"))
  : []);

/** `file#function` for each call `pattern` matches, by the top-level declaration it sits in. */
function callers(pattern: RegExp): string[] {
  const out = new Set<string>();
  for (const file of sources("convex", "modules", "services/record-service/src", "src")) {
    const text = readFileSync(join(ROOT, file), "utf8");
    const starts = [...text.matchAll(/^(?:export )?(?:const|async function|function|class) (\w+)/gm)];
    for (const call of text.matchAll(pattern)) {
      if (/(?:function|async)\s+$/.test(text.slice(0, call.index).split("\n").at(-1)!)) continue;
      const at = starts.findLastIndex((s) => s.index! < call.index!);
      out.add(`${file}#${at < 0 ? "(top)" : starts[at]![1]}`);
    }
  }
  return [...out].sort();
}

/** The listed functions whose file is in this tree (the public export leaves some out). */
const sorted = (o: Record<string, string>) => Object.keys(o).filter((k) => existsSync(join(ROOT, k.split("#")[0]!))).sort();

/** Who appends an entry to a stream (ObjectStore.appendEntry), and who stores it. */
const APPENDS: Record<string, string> = {
  "convex/lib/objects/write.ts#append": "save's one append, after every rule",
  "convex/lib/objects/write.ts#appendHistory": "a history copied verbatim (below)",
};
const STORES_ENTRIES: Record<string, string> = {
  "convex/objects.ts#convexObjectStore": "ObjectStore.appendEntry: the one insert into ledgerEntries",
};
/** appendHistory skips the rules: it copies a history that already happened. */
const COPIES_HISTORY: Record<string, string> = {
  "convex/lib/canon/streamLedger.ts#ensureStream": "a record's `facts` history converted onto its stream",
  "convex/workspaceImport.ts#replayLedger": "an exported workspace's ledger replayed",
};
/** Who stores a `facts` row (LedgerStore.insertFact), and who calls it. */
const STORES_FACTS: Record<string, string> = {
  "convex/canon.ts#convexLedgerStore": "LedgerStore.insertFact: the one insert into facts",
  "convex/devSeed.ts#seedDealProspectsDb": "the local stack's seed",
};
const INSERTS_FACTS: Record<string, string> = {
  "convex/lib/canon/ledger.ts#ingestObservations": "a source's values for a record with no stream yet, and agent proposals",
  "convex/lib/canon/streamLedger.ts#mirrorAppended": "the mirror of an entry save appended",
};
/** ingestObservations runs the hold against a CRM itself, on `facts`. */
const INGESTS: Record<string, string> = {
  "convex/canonGate.ts#submitProposalBatch": "an agent's proposal enters the `facts` gate, then reaches the stream through save (mirrorGateProposal)",
  "convex/lib/canon/dealLedger.ts#writeDealFactsOnly": "a deal whose history this transaction cannot convert",
  "convex/lib/canon/partyLedger.ts#writePartyFactsOnly": "a company or person whose history this transaction cannot convert",
};

test("the object ledger takes entries only through lib/objects/write.ts", () => {
  assert.deepEqual(callers(/\.appendEntry\(/g), sorted(APPENDS), "append through save (lib/objects/write.ts), or list the new appender here with its reason");
  assert.deepEqual(callers(/\.insert\(\s*"ledgerEntries"/g), sorted(STORES_ENTRIES));
  assert.deepEqual(callers(/\bappendHistory\(/g).filter((c) => !c.endsWith("#appendHistory")), sorted(COPIES_HISTORY), "appendHistory applies no rule: a live write goes through save");
  // An archive's entries arrive through replayLedger, never as plain rows.
  assert.equal(IMPORT_TABLES.ledgerEntries!.kind, "ledger");
});

test("the facts ledger takes rows only from ingestObservations and the mirror of save's entries", () => {
  assert.deepEqual(callers(/\.insert\(\s*"facts"/g), sorted(STORES_FACTS));
  assert.deepEqual(callers(/\.insertFact\(/g), sorted(INSERTS_FACTS));
  assert.deepEqual(callers(/\bingestObservations\(/g).filter((c) => !c.endsWith("#ingestObservations")), sorted(INGESTS));
  assert.equal(IMPORT_TABLES.facts!.kind, "facts");
});
