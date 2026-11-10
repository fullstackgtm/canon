// Restore a workspace file from an S3/R2 backup.
//
//   npm run restore -- <wsId> [latest|<key>] [--dest <path>] [--list]
//
// Reads BACKUP_S3_* env (see src/backup.ts). By default restores to
// $DATA_DIR/ws/<wsId>.duckdb; the service must be stopped (or the workspace not
// open) when restoring over a live file. To restore safely beside a live file,
// pass --dest and swap during a maintenance window.
import { join } from "node:path";
import { backupConfigFromEnv, latestBackupKey, restoreBackup, s3For } from "../src/backup.ts";
import { WORKSPACE_ID_RE } from "../src/contract.ts";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";

const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const list = args.includes("--list") ? (args.splice(args.indexOf("--list"), 1), true) : false;
const dest = flag("--dest");
const [wsId, which = "latest"] = args;
if (!wsId || !WORKSPACE_ID_RE.test(wsId)) {
  console.error("usage: restore <wsId> [latest|<key>] [--dest <path>] [--list]");
  process.exit(2);
}
const cfg = backupConfigFromEnv();
if (!cfg) {
  console.error("Backups are not configured: set BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY.");
  process.exit(2);
}
if (list) {
  const out = await s3For(cfg).send(new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: `${cfg.prefix}${wsId}/` }));
  for (const o of out.Contents ?? []) console.log(`${o.Key}\t${o.Size}\t${o.LastModified?.toISOString()}`);
  process.exit(0);
}
const key = which === "latest" ? await latestBackupKey(cfg, wsId) : which;
if (!key) {
  console.error(`no backups found for ${wsId}`);
  process.exit(1);
}
const target = dest ?? join(process.env.DATA_DIR ?? "/data", "ws", `${wsId}.duckdb`);
await restoreBackup(cfg, key, target);
console.log(JSON.stringify({ restored: key, to: target }));
