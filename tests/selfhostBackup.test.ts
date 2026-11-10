import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { ASIDE, directoryVolume, pack, restore, restorePlan, verifyArchive } from "../scripts/selfhost/backup.mjs";

function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (at: string) => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) { files[`${relative(dir, path)}/`] = ""; walk(path); }
      else files[relative(dir, path)] = readFileSync(path, "utf8");
    }
  };
  walk(dir);
  return files;
}

function setup() {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "selfhost-backup-test-")));
  const repo = join(temp, "repo");
  mkdirSync(join(repo, "scripts/selfhost"), { recursive: true });
  writeFileSync(join(repo, "scripts/selfhost/data-contract.json"), JSON.stringify({ epoch: 2, minEpoch: 1, migrations: [{ epoch: 2, run: "npm run migrate-two" }] }));
  const source = join(temp, "source");
  const files = {
    "convex/db.sqlite3": "sqlite pages",
    "convex/tmp/.tmpA/runtime.js": "scratch",
    "records/ws/ws1.duckdb": "duckdb pages",
    [`records/ws/${"w".repeat(120)}.duckdb`]: "a path past the ustar name field",
    "credentials/token_encryption_key": "key",
  };
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(source, path, ".."), { recursive: true });
    writeFileSync(join(source, path), body);
  }
  const archive = (name: string, dataEpoch = 1) => pack(source, join(temp, name), { app: { commit: "abc" }, dataEpoch, recordServiceContract: "1.0.0" }).then(() => join(temp, name));
  const target = (contents: Record<string, string> = {}) => {
    const dir = join(temp, `volume-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir);
    for (const [path, body] of Object.entries(contents)) writeFileSync(join(dir, path), body);
    return dir;
  };
  const calls: string[] = [];
  const service = (healthy: boolean[]) => ({
    stop: async () => { calls.push("stop"); return true; },
    startHealthy: async () => { calls.push("start"); return healthy.shift() ?? true; },
  });
  const expected = { ...snapshot(source) };
  for (const key of Object.keys(expected)) if (key.startsWith("convex/tmp/") && key !== "convex/tmp/") delete expected[key];
  return { temp, repo, source, archive, target, service, calls, expected, done: () => rmSync(temp, { recursive: true, force: true }) };
}

test("a backup restores the same files into an empty volume and records the backup's data epoch", async () => {
  const t = setup();
  try {
    const file = await t.archive("backup.tar.gz");
    assert.equal((await verifyArchive(file)).members.length, 4);
    const volume = t.target();
    const result = await restore(file, { repo: t.repo, log: () => {}, volume: directoryVolume(volume, null), service: t.service([true]) });
    assert.deepEqual(snapshot(volume), t.expected);
    assert.deepEqual(result.migrations, ["npm run migrate-two"]);
    assert.equal(readFileSync(join(t.repo, ".canon/data-epoch"), "utf8"), "1\n");
    assert.deepEqual(t.calls, ["stop", "start"]);
  } finally { t.done(); }
});

test("restore writes nothing for a corrupted archive, an unsupported data epoch, or an occupied volume without --replace", async () => {
  const t = setup();
  try {
    const good = await t.archive("good.tar.gz");
    const raw = gunzipSync(readFileSync(good));
    const at = raw.indexOf("duckdb pages");
    raw[at] ^= 1;
    const corrupted = join(t.temp, "corrupted.tar.gz");
    writeFileSync(corrupted, gzipSync(raw));
    const occupied = { "previous.txt": "previous install" };
    const cases: [string, string, Record<string, string>][] = [
      [corrupted, "checksum", {}],
      [await t.archive("newer.tar.gz", 3), "newer", {}],
      [await t.archive("older.tar.gz", 0), "older", {}],
      [good, "--replace", occupied],
    ];
    for (const [file, reason, contents] of cases) {
      const volume = t.target(contents);
      await assert.rejects(restore(file, { repo: t.repo, log: () => {}, volume: directoryVolume(volume, null), service: t.service([]) }), new RegExp(reason));
      assert.deepEqual(snapshot(volume), contents);
    }
    assert.deepEqual(t.calls, []);
    assert.equal(existsSync(join(t.repo, ".canon/data-epoch")), false);
    assert.deepEqual(restorePlan({ dataEpoch: 2 }, { epoch: 2, minEpoch: 1, migrations: [{ epoch: 2, run: "m" }] }), { ok: true, migrations: [] });
  } finally { t.done(); }
});

test("a restore that fails its health check puts the previous state back", async () => {
  const t = setup();
  try {
    const file = await t.archive("backup.tar.gz");
    const previous = { "previous.txt": "previous install" };
    const volume = t.target(previous);
    await assert.rejects(restore(file, { repo: t.repo, replace: true, log: () => {}, volume: directoryVolume(volume, null), service: t.service([false, true]) }));
    assert.deepEqual(snapshot(volume), previous);
    assert.equal(existsSync(join(volume, ASIDE)), false);
    assert.deepEqual(t.calls, ["stop", "start", "stop", "start"]);
    assert.equal(existsSync(join(t.repo, ".canon/data-epoch")), false);

    await restore(file, { repo: t.repo, replace: true, log: () => {}, volume: directoryVolume(volume, null), service: t.service([true]) });
    assert.deepEqual(snapshot(volume), t.expected);
  } finally { t.done(); }
});

test("putting back a partly set-aside volume keeps the originals that were never moved", async () => {
  const t = setup();
  try {
    const original = { "a.txt": "first", "b.txt": "second" };
    const volume = t.target(original);
    const steps = directoryVolume(volume, null);
    await steps.setAside();
    renameSync(join(volume, ASIDE, "b.txt"), join(volume, "b.txt"));
    await steps.putBack();
    assert.deepEqual(snapshot(volume), original);
  } finally { t.done(); }
});
