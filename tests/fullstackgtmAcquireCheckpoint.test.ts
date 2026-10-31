import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";
import test from "node:test";
import {
  acquireCheckpointId,
  acquireCheckpointsDir,
  createFileAcquireCheckpointStore,
  validateAcquireCheckpoint,
  type AcquireCheckpointKey,
} from "../engine/src/acquireCheckpoint.ts";

const key = (listId: string | null, fingerprint = "sha256:query-a"): AcquireCheckpointKey => ({
  provider: "heyreach",
  source: "linkedin",
  listId,
  queryFingerprint: fingerprint,
});

test("checkpoint store independently resumes each list and query", async () => {
  const home = mkdtempSync(join(tmpdir(), "fsgtm-checkpoints-"));
  try {
    const store = createFileAcquireCheckpointStore(home);
    await store.put(key("list-a"), { offset: 100, exhausted: false }, new Date("2026-07-10T01:00:00Z"));
    await store.put(key("list-b"), { offset: 25, exhausted: false }, new Date("2026-07-10T02:00:00Z"));
    await store.put(key("list-a", "sha256:query-b"), { offset: 5, exhausted: true }, new Date("2026-07-10T03:00:00Z"));

    assert.equal((await store.get(key("list-a")))?.continuation.offset, 100);
    assert.equal((await store.get(key("list-b")))?.continuation.offset, 25);
    assert.equal((await store.get(key("list-a", "sha256:query-b")))?.continuation.exhausted, true);
    assert.equal((await store.list()).length, 3);
    assert.notEqual(acquireCheckpointId(key("list-a")), acquireCheckpointId(key("list-b")));

    if (platform !== "win32") {
      const directory = acquireCheckpointsDir(home);
      assert.equal(lstatSync(directory).mode & 0o777, 0o700);
      for (const record of await store.list()) {
        assert.equal(lstatSync(join(directory, `${record.id}.json`)).mode & 0o777, 0o600);
      }
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("checkpoint records have a validated versioned sync format", async () => {
  const home = mkdtempSync(join(tmpdir(), "fsgtm-checkpoint-format-"));
  try {
    const store = createFileAcquireCheckpointStore(home);
    const saved = await store.put(key(null), { cursor: "opaque-next", exhausted: false }, new Date("2026-07-10T04:00:00Z"));
    const onDisk = JSON.parse(readFileSync(join(acquireCheckpointsDir(home), `${saved.id}.json`), "utf8"));
    assert.deepEqual(validateAcquireCheckpoint(onDisk), saved);
    await assert.rejects(
      store.putRecord({ ...saved, id: "acqcp_wrong" }),
      /id does not match/,
    );
    assert.throws(() => validateAcquireCheckpoint({ ...saved, version: 2 }), /Unsupported.*version/);
    await assert.rejects(store.put(key(null), { offset: -1, exhausted: false }), /offset/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("checkpoint reads and writes reject symlinked managed paths", { skip: platform === "win32" }, async () => {
  const home = mkdtempSync(join(tmpdir(), "fsgtm-checkpoint-link-"));
  try {
    const victim = join(home, "victim");
    mkdirSync(victim);
    mkdirSync(join(home, "acquire"));
    symlinkSync(victim, acquireCheckpointsDir(home));
    const store = createFileAcquireCheckpointStore(home);
    await assert.rejects(store.put(key("list-a"), { offset: 1, exhausted: false }), /symbolic link/i);

    rmSync(acquireCheckpointsDir(home));
    mkdirSync(acquireCheckpointsDir(home));
    const id = acquireCheckpointId(key("list-a"));
    const target = join(victim, "record.json");
    writeFileSync(target, "secret");
    symlinkSync(target, join(acquireCheckpointsDir(home), `${id}.json`));
    await assert.rejects(store.get(key("list-a")), /symbolic link/i);
    assert.equal(readFileSync(target, "utf8"), "secret");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
