/**
 * Census: a person's or an API caller's write names only active members and records the caller sees, checked in one
 * place, lib/recordReferences.ts referenceErrors. It lists every call of a writer that saves record values as a member
 * and fails on one it doesn't judge, so the next surface can't skip the check. tests/recordApiConformance.test.ts
 * proves the check through the record API's routes.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const ROOT = join(import.meta.dirname, "..");
const WRITER = /\b(saveAsCaller|saveDealAsCaller|createDealAsUser|recordEditPorts|userSaveContext)\(/g;

/** Calls on a caller's write path: each passes the caller's scope, so the writer checks the references. */
const CHECKED = [
  "convex/objects.ts#writeAs", // objects.write, writeScoped: the record page, the record API and the MCP record tools
  "convex/objects.ts#bulkAs", // a list's bulk edit (objects.bulk, bulkScoped)
  "convex/deals.ts#create", "convex/deals.ts#createAdmitted", // New deal, the API's and MCP's deal create (deals.createScoped)
  "convex/activityTargets.ts#logAsUser", // Log activity, POST /api/v1/activities, canon_activities log
  "convex/records.ts#edit", "convex/records.ts#bulkRegister", // a company's or person's edit, from every surface
  "convex/accountHierarchy.ts#changeFields", // an approved account hierarchy field fix, as the approver's records.edit
];

/** Calls that are not a caller naming values, and why. */
const NOT_A_CALLER: Record<string, string> = {
  "convex/objects.ts#saveAsCaller": "the writer itself",
  "convex/objects.ts#saveDealLinesAsCaller": "line items: their deal and product are checked by saveDealLinesAsCaller",
  "convex/objects.ts#lifecycle": "an archive or restore names no values",
  "convex/objects.ts#createMany": "a custom object's CSV import: its cell parser resolves owners to active members and lookups to records (lib/objects/csvImport.ts)",
  "convex/automations.ts#writeRecord": "an automation's action, as the rule's principal, with the values an admin saved on the rule",
  "convex/automations.ts#perform": "an automation's task, as the rule's principal",
  "convex/calendarEvents.ts#logEvent": "calendar sync",
  "convex/granola.ts#purgeImported": "meeting sync",
  "convex/granola.ts#logMeeting": "meeting sync: records it matched from the meeting",
  "convex/callSuggestions.ts#finish": "a deal Canon suggested from a call, with the company it matched",
  "convex/dealLineItems.ts#useAsAmount": "writes the deal's amount only",
  "convex/dialer.ts#setOutcome": "the dialer's call record",
  "convex/dialer.ts#logActivity": "the dialer's call record",
  "convex/leadConversion.ts#finish": "conversion writes the records it created or matched itself",
  "convex/leadConversion.ts#convert": "conversion writes the records it created or matched itself",
  "convex/lib/researchEnrich.ts#writeAndCharge": "a research run's answer",
  "convex/lib/researchEnrich.ts#checkJobChanges": "a job change check's answer",
  "convex/moduleRecords.ts#applyMeeting": "a module proposal a person approved",
  "convex/moduleRecords.ts#applyRecordRows": "a module proposal a person approved",
  "convex/records.ts#findEmail": "a work-email lookup's answer",
  "convex/records.ts#findPhone": "a phone lookup's answer",
  "convex/devPerfSeed.ts#seedDb": "the local stack's seed",
  "convex/devSeed.ts#seedDealProspectsDb": "the local stack's seed",
};

/** Source files under `dirs`, relative to the root: the tree as it is, so the public export's copy reads its own. */
const sources = (...dirs: string[]) => dirs.flatMap((dir) => existsSync(join(ROOT, dir))
  ? readdirSync(join(ROOT, dir), { recursive: true, encoding: "utf8" }).map((f) => `${dir}/${f}`).filter((f) => /\.tsx?$/.test(f) && !f.includes("/_generated/") && !f.includes("node_modules"))
  : []);

function callSites(): Map<string, string> {
  const files = sources("convex", "modules");
  const sites = new Map<string, string>();
  for (const file of files) {
    const text = readFileSync(join(ROOT, file), "utf8");
    const starts = [...text.matchAll(/^(?:export )?(?:const|async function|function) (\w+)/gm)];
    for (const call of text.matchAll(WRITER)) {
      if (/function\s*$/.test(text.slice(0, call.index))) continue;
      const at = starts.findLastIndex((s) => s.index! < call.index!);
      const body = text.slice(starts[at]!.index, starts[at + 1]?.index ?? text.length);
      sites.set(`${file}#${starts[at]![1]}`, body);
    }
  }
  return sites;
}

test("every writer call on a caller's write path checks its references, and every other is accounted for", () => {
  const sites = callSites();
  const judged = new Set([...CHECKED, ...Object.keys(NOT_A_CALLER)]);
  assert.deepEqual([...sites.keys()].filter((k) => !judged.has(k)), [], "a new call of a writer: pass the caller's scope (lib/recordReferences.ts), or say here why it names no caller's values");
  assert.deepEqual([...judged].filter((k) => !sites.has(k) && existsSync(join(ROOT, k.split("#")[0]!))), [], "listed here but no longer a call of a writer");
  for (const site of CHECKED) assert.match(sites.get(site)!, /referenceErrors|references|admitted|"edit"/, `${site} passes no caller scope`);
});

test("the dashboard, the record API and the MCP tools write through objects.writeScoped and bulkScoped", () => {
  const direct = sources("src").filter((f) => f !== "src/lib/gtm-parity-baseline.ts" && /api\.objects\.(write|bulk)\b/.test(readFileSync(join(ROOT, f), "utf8")));
  assert.deepEqual(direct, []);
});
