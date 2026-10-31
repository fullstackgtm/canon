// Per-workspace backups to an S3-compatible bucket (Cloudflare R2 in production,
// MinIO in tests). A backup is a byte copy of the DuckDB file taken right after a
// CHECKPOINT while the workspace's single writer is held, gzipped and uploaded to
//   {prefix}{wsId}/{timestamp}.duckdb.gz
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createGzip, createGunzip } from "node:zlib";
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { metrics } from "./metrics.ts";
import type { Registry } from "./registry.ts";

export type BackupConfig = { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string; region: string; prefix: string };

/** Reads BACKUP_* env. Returns null (backups disabled) unless all required values are set. */
export function backupConfigFromEnv(env = process.env): BackupConfig | null {
  const { BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY } = env;
  if (!BACKUP_S3_ENDPOINT || !BACKUP_S3_BUCKET || !BACKUP_S3_ACCESS_KEY_ID || !BACKUP_S3_SECRET_ACCESS_KEY) return null;
  return {
    endpoint: BACKUP_S3_ENDPOINT, bucket: BACKUP_S3_BUCKET, accessKeyId: BACKUP_S3_ACCESS_KEY_ID,
    secretAccessKey: BACKUP_S3_SECRET_ACCESS_KEY, region: env.BACKUP_S3_REGION ?? "auto", prefix: env.BACKUP_PREFIX ?? "record-service/",
  };
}

export function s3For(cfg: BackupConfig) {
  return new S3Client({
    endpoint: cfg.endpoint, region: cfg.region, forcePathStyle: true,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });
}

/** Back up one workspace. The file copy happens inside the writer queue, so no write lands mid-copy. */
export async function backupWorkspace(reg: Registry, cfg: BackupConfig, wsId: string, s3 = s3For(cfg)): Promise<{ key: string; bytes: number }> {
  const tmp = join(reg.dataDir, "tmp", `${wsId}.${Date.now()}.duckdb`);
  await mkdir(dirname(tmp), { recursive: true });
  try {
    await reg.with(wsId, (ws) => ws.write(async (c) => {
      await c.run("CHECKPOINT");
      await copyFile(ws.path, tmp);
    }, "raw"));
    const key = `${cfg.prefix}${wsId}/${new Date().toISOString().replace(/[:.]/g, "-")}.duckdb.gz`;
    await pipeline(createReadStream(tmp), createGzip(), createWriteStream(`${tmp}.gz`));
    const bytes = (await stat(`${tmp}.gz`)).size;
    await s3.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: key, Body: createReadStream(`${tmp}.gz`), ContentLength: bytes }));
    metrics.backups.inc({ result: "ok" });
    return { key, bytes };
  } catch (e) {
    metrics.backups.inc({ result: "error" });
    throw e;
  } finally {
    await rm(tmp, { force: true });
    await rm(`${tmp}.gz`, { force: true });
  }
}

/** The newest backup key for a workspace, or null. */
export async function latestBackupKey(cfg: BackupConfig, wsId: string, s3 = s3For(cfg)): Promise<string | null> {
  let token: string | undefined;
  let latest: string | null = null;
  do {
    const out = await s3.send(new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: `${cfg.prefix}${wsId}/`, ContinuationToken: token }));
    for (const o of out.Contents ?? []) if (o.Key && (!latest || o.Key > latest)) latest = o.Key;
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);
  return latest;
}

/**
 * Download a backup to `destPath` (atomically: temp file, then rename). The
 * service must not have that workspace open; run this with the service stopped
 * or into a path the service is not serving.
 */
export async function restoreBackup(cfg: BackupConfig, key: string, destPath: string, s3 = s3For(cfg)) {
  const out = await s3.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
  await mkdir(dirname(destPath), { recursive: true });
  const tmp = `${destPath}.restore-${Date.now()}`;
  await pipeline(out.Body as Readable, createGunzip(), createWriteStream(tmp));
  await rm(`${destPath}.wal`, { force: true });
  await rename(tmp, destPath);
}

/** Backs up every workspace file on disk once per interval. */
export function scheduleBackups(reg: Registry, cfg: BackupConfig, intervalMs: number, listWorkspaces: () => Promise<string[]>) {
  const s3 = s3For(cfg);
  const run = async () => {
    for (const wsId of await listWorkspaces()) {
      try {
        const r = await backupWorkspace(reg, cfg, wsId, s3);
        console.log(JSON.stringify({ msg: "backup ok", ws: wsId, key: r.key, bytes: r.bytes }));
      } catch (e) {
        console.error(JSON.stringify({ msg: "backup failed", ws: wsId, err: String(e) }));
      }
    }
  };
  // First backup shortly after startup: with only setInterval, every deploy
  // restarted the clock and a frequently deployed service never backed up.
  const first = setTimeout(run, Number(process.env.BACKUP_FIRST_DELAY_MS ?? 5 * 60_000));
  first.unref();
  const t = setInterval(run, intervalMs);
  t.unref();
  return () => (clearTimeout(first), clearInterval(t));
}
