// Fetch the current prospect index from R2 onto the record service's volume.
// Called at record-service startup (and on a timer to pick up new versions).
//
// R2 layout (bucket R2_BUCKET):
//   shared/pdl_companies/latest.json                  {version, key, bytes, sha256, ...}
//   shared/pdl_companies/<version>/pdl_companies.duckdb
//
// The file is downloaded to a temp path, checked against the manifest's
// sha256, and only then renamed into place, so a crashed or partial download
// is never opened. If the local copy already matches, nothing is downloaded.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

export type IndexManifest = { version: string; key: string; bytes: number; sha256: string; companies: number; license: string };

function client() {
  const need = ["R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"] as const;
  const missing = need.filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`prospect index: missing env ${missing.join(", ")}`);
  return new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! },
  });
}

async function sha256(path: string) {
  const h = createHash("sha256");
  await pipeline(createReadStream(path), h);
  return h.digest("hex");
}

/**
 * Ensure `<dir>/pdl_companies.duckdb` matches the latest manifest.
 * Returns the local path and manifest. `<dir>/pdl_companies.json` records
 * which version is on disk so restarts don't re-hash 5 GB.
 */
export async function ensureIndex(dir: string, log: (m: string) => void = console.log) {
  const s3 = client();
  const bucket = process.env.R2_BUCKET!;
  const latest = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: "shared/pdl_companies/latest.json" }));
  const manifest = JSON.parse(await latest.Body!.transformToString()) as IndexManifest;

  await mkdir(dir, { recursive: true });
  const path = join(dir, "pdl_companies.duckdb");
  const marker = join(dir, "pdl_companies.json");
  const onDisk = await readFile(marker, "utf8").then((s) => JSON.parse(s) as IndexManifest).catch(() => null);
  const size = await stat(path).then((s) => s.size).catch(() => -1);
  if (onDisk?.sha256 === manifest.sha256 && size === manifest.bytes) {
    log(`prospect index ${manifest.version} already present (${manifest.companies} companies)`);
    return { path, manifest, downloaded: false };
  }

  const tmp = `${path}.download`;
  await rm(tmp, { force: true });
  const t0 = performance.now();
  log(`prospect index: downloading ${manifest.version} (${(manifest.bytes / 1e9).toFixed(1)} GB)`);
  const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: manifest.key }));
  await pipeline(obj.Body as Readable, createWriteStream(tmp));
  const got = await sha256(tmp);
  if (got !== manifest.sha256) {
    await rm(tmp, { force: true });
    throw new Error(`prospect index: checksum mismatch for ${manifest.key}`);
  }
  await rename(tmp, path);
  await writeFile(marker, JSON.stringify(manifest));
  log(`prospect index ${manifest.version} ready in ${Math.round((performance.now() - t0) / 1000)}s`);
  return { path, manifest, downloaded: true };
}
