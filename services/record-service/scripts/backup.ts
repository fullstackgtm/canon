// One-shot backup of workspace files on disk (the service runs this nightly itself).
//
//   npm run backup -- [wsId ...]      (no ids: every workspace in $DATA_DIR/ws)
//
// Opens the files directly, so run it with the service stopped (DuckDB allows one
// writer process per file). The running service backs up through its own queues.
import { readdirSync } from "node:fs";
import { backupConfigFromEnv, backupWorkspace } from "../src/backup.ts";
import { WORKSPACE_ID_RE } from "../src/contract.ts";
import { Registry } from "../src/registry.ts";

const cfg = backupConfigFromEnv();
if (!cfg) {
  console.error("Backups are not configured: set BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY.");
  process.exit(2);
}
const reg = new Registry(process.env.DATA_DIR ?? "/data", 4, { memoryLimit: "512MB", threads: 2, readPool: 1, maxGroup: 64, lockWaitMs: 0 });
const ids = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(reg.wsDir).filter((f) => f.endsWith(".duckdb")).map((f) => f.slice(0, -7)).filter((id) => WORKSPACE_ID_RE.test(id));
let failed = 0;
for (const id of ids) {
  try {
    console.log(JSON.stringify({ ws: id, ...(await backupWorkspace(reg, cfg, id)) }));
  } catch (e) {
    failed++;
    console.error(JSON.stringify({ ws: id, error: String(e) }));
  }
}
await reg.closeAll();
process.exit(failed ? 1 : 0);
