// Backup -> restore round trip against a local MinIO (S3-compatible, like R2).
// Starts a throwaway MinIO container unless BACKUP_TEST_ENDPOINT points at one.
// Skips (loudly) when docker is unavailable.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { CreateBucketCommand } from "@aws-sdk/client-s3";
import { backupWorkspace, latestBackupKey, restoreBackup, s3For, type BackupConfig } from "../src/backup.ts";
import { createApp } from "../src/app.ts";
import { client, fixtureAccounts, startApp, tempDir, testConfig } from "./helpers.ts";

// minio/minio was pulled from Docker Hub; pgsty/minio is a maintained community build of the same server.
const MINIO_IMAGE = process.env.MINIO_IMAGE ?? "pgsty/minio:latest";
const NAME = `fsgtm-rs-minio-${process.pid}`;
const dockerOk = !process.env.BACKUP_TEST_ENDPOINT && spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
const available = !!process.env.BACKUP_TEST_ENDPOINT || dockerOk;
if (!available) console.warn("!!! backup test SKIPPED: docker not available and BACKUP_TEST_ENDPOINT not set");

describe("backups", { skip: !available }, () => {
  let cfg: BackupConfig;
  before(async () => {
    let endpoint = process.env.BACKUP_TEST_ENDPOINT;
    if (!endpoint) {
      execFileSync("docker", ["run", "-d", "--rm", "--name", NAME, "-p", "127.0.0.1::9000", "-e", "MINIO_ROOT_USER=minioadmin",
        "-e", "MINIO_ROOT_PASSWORD=minioadmin", MINIO_IMAGE, "server", "/data"], { stdio: "ignore" });
      const port = execFileSync("docker", ["port", NAME, "9000"]).toString().trim().split(":").pop();
      endpoint = `http://127.0.0.1:${port}`;
    }
    cfg = { endpoint, bucket: "fsgtm-backups", accessKeyId: "minioadmin", secretAccessKey: "minioadmin", region: "us-east-1", prefix: "record-service/" };
    const s3 = s3For(cfg);
    for (let i = 0; ; i++) {
      try {
        await s3.send(new CreateBucketCommand({ Bucket: cfg.bucket }));
        break;
      } catch (e) {
        if ((e as { name?: string }).name === "BucketAlreadyOwnedByYou") break;
        if (i > 60) throw e;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  });
  after(() => {
    if (dockerOk) spawnSync("docker", ["rm", "-f", NAME], { stdio: "ignore" });
  });

  it("restores a backup that equals the source workspace", async () => {
    const src = await startApp();
    const ws = src.client.ws("bk");
    await ws.post("provision");
    const up = await ws.post("accounts/upsert", { records: fixtureAccounts(500), source: "t", idempotencyKey: "b1" });
    await ws.post("contacts/upsert", { records: up.json.ids.slice(0, 50).map((accountId: string, i: number) => ({ accountId, fullName: `P ${i}`, email: `p${i}@x.com` })), source: "t", idempotencyKey: "b2" });
    await ws.post("rescore", { icp: { base: 5, industries: { software: 40 } } });
    await ws.post("records/edit", { object: "account", id: up.json.ids[0], patch: { status: "qualified" }, actorId: "u", idempotencyKey: "b3" });

    const r = await backupWorkspace(src.app.registry, cfg, "bk");
    assert.ok(r.bytes > 0);
    // Writes after the backup must not appear in the restored copy.
    await ws.post("records/edit", { object: "account", id: up.json.ids[1], patch: { status: "working" }, actorId: "u", idempotencyKey: "b4" });

    const key = await latestBackupKey(cfg, "bk");
    assert.equal(key, r.key);
    const restoreDir = tempDir("rs-restore-");
    await restoreBackup(cfg, key!, join(restoreDir, "ws", "bk.duckdb"));
    const dst = createApp(testConfig({ dataDir: restoreDir }));
    const port = await dst.listen();
    const rws = client(`http://127.0.0.1:${port}`).ws("bk");
    try {
      const dump = async (w: typeof ws) => {
        const accounts = (await w.post("accounts/list", { limit: 200, sort: { field: "name", dir: "asc" } })).json;
        const total = (await w.post("segments/count", { filter: {} })).json.total;
        const a360 = (await w.post("accounts/get", { id: up.json.ids[0] })).json;
        let changes = 0;
        for (let after = 0; ; ) {
          const page = (await w.get(`changes?after=${after}&limit=500`)).json;
          if (!page.changes.length) break;
          changes += page.changes.length;
          after = page.lastSeq;
        }
        return { accounts, total, a360, changes };
      };
      const restored = await dump(rws);
      const live = await dump(ws);
      assert.equal(restored.total, 500);
      assert.equal(restored.total, live.total);
      assert.deepEqual(restored.a360, live.a360);
      assert.equal(restored.changes, live.changes - 1); // exactly the post-backup edit is missing
      const strip = (rows: any[]) => rows.filter((x) => x.id !== up.json.ids[1]);
      assert.deepEqual(strip(restored.accounts.rows), strip(live.accounts.rows));
      const b4 = (await rws.post("accounts/get", { id: up.json.ids[1] })).json.account;
      assert.equal(b4.status, "new");
    } finally {
      await dst.shutdown();
      await src.app.shutdown();
    }
  });
  it("restore CLI downloads the latest backup to a workspace file the service can open", async () => {
    const dataDir = tempDir("rs-cli-");
    const env = { ...process.env, DATA_DIR: dataDir, BACKUP_S3_ENDPOINT: cfg.endpoint, BACKUP_S3_BUCKET: cfg.bucket,
      BACKUP_S3_ACCESS_KEY_ID: cfg.accessKeyId, BACKUP_S3_SECRET_ACCESS_KEY: cfg.secretAccessKey, BACKUP_S3_REGION: cfg.region };
    const script = new URL("../scripts/restore.ts", import.meta.url).pathname;
    const out = execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", script, "bk", "latest"], { env }).toString();
    assert.match(out, /"restored":"record-service\/bk\//);
    const app = createApp(testConfig({ dataDir }));
    const port = await app.listen();
    try {
      const total = (await client(`http://127.0.0.1:${port}`).ws("bk").post("segments/count", { filter: {} })).json.total;
      assert.equal(total, 500);
    } finally {
      await app.shutdown();
    }
    const missing = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", script, "nobackups"], { env });
    assert.equal(missing.status, 1);
  });
});
