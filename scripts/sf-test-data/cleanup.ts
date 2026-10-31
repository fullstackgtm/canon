/**
 * Delete ONLY records carrying both workstream-B tags (Name/LastName prefix
 * "FSGTMSYNC B " and Description containing "fsgtm-sync-test b-import").
 *
 *   node --experimental-strip-types scripts/sf-test-data/cleanup.ts [--dry-run]
 */
import { connFromSfCli, deleteIds, taggedCounts, taggedIds } from "./lib.ts";

async function main() {
  const dry = process.argv.includes("--dry-run");
  const c = connFromSfCli();
  const before = await taggedCounts(c);
  const deleted: Record<string, number> = {};
  if (!dry) {
    // Children first, so Account deletes do not cascade into ids we count separately.
    for (const object of ["Contact", "Lead", "Account"] as const) deleted[object] = await deleteIds(c, await taggedIds(c, object));
  }
  const after = await taggedCounts(c);
  console.log(JSON.stringify({ dryRun: dry, before, deleted, after }));
  if (!dry && after.Account + after.Contact + after.Lead !== 0) process.exit(2);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
