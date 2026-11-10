/**
 * Real-org end to end of the import engine, run locally: real Salesforce
 * (Bulk API 2.0 via the sf CLI session) into the in-process record-service
 * 1.2.0 model (`memorySink`), seeded with a TAM that overlaps the seeded
 * accounts' domains. Read-only against Salesforce.
 *
 *   node --experimental-strip-types scripts/sf-test-data/run-import.ts [Account Contact ...]
 *
 * Prints, per object: SOQL COUNT(), upserted, merged, rejected, and whether
 * upserted + rejected == COUNT; then reruns and checks totals/dup sfIds.
 */
import type { ObjectImportState, RejectedRow } from "../../engine/src/sync/salesforceImport/contracts.ts";
import { planObjects, runImport } from "../../engine/src/sync/salesforceImport/engine.ts";
import { memorySink } from "../../engine/src/sync/salesforceImport/sinks.ts";
import { countRecords } from "../../engine/src/sync/salesforceImport/sfClient.ts";
import { connFromSfCli } from "./lib.ts";
import { seedDomain } from "./seed.ts";

async function once(sink: ReturnType<typeof memorySink>, requested: string[] | undefined) {
  const conn = connFromSfCli();
  const objects: ObjectImportState[] = await planObjects(conn, requested);
  const rejected: RejectedRow[] = [];
  const t0 = Date.now();
  await runImport({ conn, sink, orgId: "realorg", objects, checkpoint: async (_o, r) => { rejected.push(...r); } });
  const ms = Date.now() - t0;
  const rows = [];
  for (const o of objects) {
    const count = await countRecords(conn, o.apiName);
    rows.push({ object: o.apiName, soqlCountBefore: o.sfTotal, soqlCountAfter: count, bulkRowsSeen: o.seen, upserted: o.upserted, merged: o.merged, rejected: o.rejected, state: o.state, balancedVsSeen: o.upserted + o.rejected === o.seen, balancedVsCount: o.upserted + o.rejected === o.sfTotal && o.sfTotal === count, error: o.error });
  }
  return { ms, rows, rejected };
}

async function main() {
  const requested = process.argv.slice(2).length ? process.argv.slice(2) : undefined;
  // TAM: 30 of the seeded domains already "in the workspace" from PDL.
  const tam = Array.from({ length: 30 }, (_, i) => ({ domain: seedDomain(i * 9 + 1), name: `TAM ${i}` }));
  const sink = memorySink({ accounts: tam, source: "pdl" });
  const tamIds = [...sink.accounts.keys()];

  const first = await once(sink, requested);
  const totals1 = { accounts: sink.accounts.size, contacts: sink.contacts.size, custom: [...sink.custom.values()].reduce((n, m) => n + m.size, 0) };
  const tamMerged = tamIds.filter((id) => sink.accounts.get(id)?.sfId).length;
  const reasons: Record<string, number> = {};
  for (const r of first.rejected) {
    const k = `${r.object}: ${r.reason.replace(/[0-9A-Za-z]{18}|"[^"]*"|\S+@\S+|\S+\.example/g, "…")}`;
    reasons[k] = (reasons[k] ?? 0) + 1;
  }
  const second = await once(sink, requested);
  const totals2 = { accounts: sink.accounts.size, contacts: sink.contacts.size, custom: [...sink.custom.values()].reduce((n, m) => n + m.size, 0) };
  console.log(JSON.stringify({
    first: { ms: first.ms, rows: first.rows },
    rejectionReasons: reasons,
    everyRejectionHasReason: first.rejected.every((r) => r.reason.length > 0),
    tam: { seeded: tamIds.length, mergedWithSfId: tamMerged },
    totals1,
    rerun: { ms: second.ms, rows: second.rows, totals2, unchanged: JSON.stringify(totals1) === JSON.stringify(totals2), duplicateSfIds: sink.duplicateSfIds() },
  }, null, 1));
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
