// Entry point: node --experimental-strip-types src/main.ts
import { backupConfigFromEnv, scheduleBackups } from "./backup.ts";
import { configFromEnv, createApp } from "./app.ts";
import { join } from "node:path";
import { ensureIndex } from "./pdlFetch.ts";

const cfg = configFromEnv();
const app = createApp(cfg);
const port = await app.listen();
console.log(JSON.stringify({ msg: "record service listening", host: cfg.host, port, dataDir: cfg.dataDir, version: cfg.version, maxOpen: cfg.maxOpen }));

// Fetch the shared prospect index from R2 in the background: it is ~5 GB, and
// the healthcheck must pass while it downloads. Searches return 503 "loading"
// until it is in place.
if (process.env.BACKUP_S3_BUCKET && process.env.PDL_INDEX_FROM_R2 !== "0") {
  app.pdl.loading = "downloading from R2";
  ensureIndex(join(cfg.dataDir, "shared"), (m) => console.log(JSON.stringify({ msg: m })))
    .then((r) => { app.pdl.loading = null; if (r.downloaded) app.pdl.reload(); })
    .catch((e) => { app.pdl.loading = null; console.error(JSON.stringify({ msg: "prospect index fetch failed", err: String(e) })); });
}

const backup = backupConfigFromEnv();
if (backup) {
  const hours = Number(process.env.BACKUP_INTERVAL_HOURS ?? 24);
  scheduleBackups(app.registry, backup, hours * 3600_000, app.listWorkspaces);
  console.log(JSON.stringify({ msg: "backups enabled", bucket: backup.bucket, everyHours: hours }));
} else {
  const banner = "!".repeat(78);
  console.warn(`${banner}\n!!! WARNING: BACKUPS ARE DISABLED. Set BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET,\n!!! BACKUP_S3_ACCESS_KEY_ID and BACKUP_S3_SECRET_ACCESS_KEY (Cloudflare R2) to enable\n!!! nightly per-workspace backups. A lost volume currently means lost data.\n${banner}`);
}

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, async () => {
    console.log(JSON.stringify({ msg: "shutting down", signal: sig }));
    const hard = setTimeout(() => process.exit(1), 30_000);
    try {
      await app.shutdown();
      console.log(JSON.stringify({ msg: "shutdown complete" }));
      process.exit(0);
    } catch (e) {
      console.error(JSON.stringify({ msg: "shutdown failed", err: String(e) }));
      clearTimeout(hard);
      process.exit(1);
    }
  });
}
