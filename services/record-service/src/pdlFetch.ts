// Fetch the shared prospect index (services/prospect-index) from R2 onto the volume.
// Copied from services/prospect-index/src/fetch.ts (this service builds from its own directory),
// using the same R2 credentials as backups. Called in the background at startup.
//
// R2 layout (bucket BACKUP_S3_BUCKET):
//   shared/pdl_companies/latest.json                  {version, key, bytes, sha256, ...}
//   shared/pdl_companies/<PDL_INDEX_MANIFEST>         another manifest, e.g. prod.json (pinned)
//   shared/pdl_companies/<version>/pdl_companies.duckdb[.zst]
//
// The file is downloaded to a temp path, checked against the manifest's
// sha256, and only then renamed into place, so a crashed or partial download
// is never opened. If the local copy already matches, nothing is downloaded.
//
// With `compression: "zstd"`, `bytes`/`sha256` describe the compressed object
// and `rawBytes`/`rawSha256` the decompressed .duckdb file. The download is
// decompressed as it streams, hashing both sides in the same pass.
import { createHash } from "node:crypto";
import { createZstdDecompress } from "node:zlib";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

export type IndexManifest = {
  version: string; key: string; bytes: number; sha256: string; companies: number; license: string;
  compression?: "zstd"; rawBytes?: number; rawSha256?: string;
};

function client() {
  const need = ["BACKUP_S3_ENDPOINT", "BACKUP_S3_ACCESS_KEY_ID", "BACKUP_S3_SECRET_ACCESS_KEY", "BACKUP_S3_BUCKET"] as const;
  const missing = need.filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`prospect index: missing env ${missing.join(", ")}`);
  return new S3Client({
    region: "auto",
    endpoint: process.env.BACKUP_S3_ENDPOINT,
    credentials: { accessKeyId: process.env.BACKUP_S3_ACCESS_KEY_ID!, secretAccessKey: process.env.BACKUP_S3_SECRET_ACCESS_KEY! },
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
export async function ensureIndex(dir: string, log: (m: string) => void = console.log, prefix = "shared/pdl_companies") {
  const s3 = client();
  const bucket = process.env.BACKUP_S3_BUCKET!;
  // Which manifest this deployment follows: dev tracks latest.json; prod pins its own
  // (e.g. prod.json) so publishing a new index for dev never changes prod.
  const manifestName = process.env.PDL_INDEX_MANIFEST ?? "latest.json";
  if (!/^[\w.-]+\.json$/.test(manifestName)) throw new Error(`prospect index: invalid PDL_INDEX_MANIFEST ${manifestName}`);
  const latest = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: `${prefix}/${manifestName}` }));
  const manifest = JSON.parse(await latest.Body!.transformToString()) as IndexManifest;

  await mkdir(dir, { recursive: true });
  const path = join(dir, "pdl_companies.duckdb");
  const marker = join(dir, "pdl_companies.json");
  const onDisk = await readFile(marker, "utf8").then((s) => JSON.parse(s) as IndexManifest).catch(() => null);
  const size = await stat(path).then((s) => s.size).catch(() => -1);
  if (manifest.compression && manifest.compression !== "zstd") throw new Error(`prospect index: unsupported compression ${manifest.compression}`);
  if (manifest.compression && (!manifest.rawBytes || !manifest.rawSha256)) throw new Error("prospect index: compressed manifest needs rawBytes and rawSha256");
  const rawBytes = manifest.compression ? manifest.rawBytes! : manifest.bytes;
  if (onDisk?.sha256 === manifest.sha256 && size === rawBytes) {
    log(`prospect index ${manifest.version} already present (${manifest.companies} companies)`);
    return { path, manifest, downloaded: false };
  }

  const tmp = `${path}.download`;
  await rm(tmp, { force: true });
  const t0 = performance.now();
  log(`prospect index: downloading ${manifest.version} (${(manifest.bytes / 1e9).toFixed(1)} GB)`);
  const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: manifest.key }));
  if (manifest.compression === "zstd") {
    // Hash the compressed bytes on the way in and the raw bytes on the way out.
    const zHash = createHash("sha256");
    const tap = new PassThrough();
    tap.on("data", (b: Buffer) => zHash.update(b));
    const rawHash = createHash("sha256");
    const out = new PassThrough();
    out.on("data", (b: Buffer) => rawHash.update(b));
    await pipeline(obj.Body as Readable, tap, createZstdDecompress(), out, createWriteStream(tmp));
    const zGot = zHash.digest("hex");
    const rawGot = rawHash.digest("hex");
    if (zGot !== manifest.sha256 || rawGot !== manifest.rawSha256) {
      await rm(tmp, { force: true });
      throw new Error(`prospect index: checksum mismatch for ${manifest.key}`);
    }
  } else {
    await pipeline(obj.Body as Readable, createWriteStream(tmp));
    const got = await sha256(tmp);
    if (got !== manifest.sha256) {
      await rm(tmp, { force: true });
      throw new Error(`prospect index: checksum mismatch for ${manifest.key}`);
    }
  }
  await rename(tmp, path);
  await writeFile(marker, JSON.stringify(manifest));
  log(`prospect index ${manifest.version} ready in ${Math.round((performance.now() - t0) / 1000)}s`);
  return { path, manifest, downloaded: true };
}
