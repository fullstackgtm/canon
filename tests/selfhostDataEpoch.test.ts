import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advanceDataEpoch, checkDataEpoch } from "../scripts/selfhost/dataEpoch.mjs";

const contract = (epoch: number, minEpoch: number, extra = {}) => ({ epoch, minEpoch, migrations: [], ...extra });

test("an image refuses a volume whose data it can't read, and names the release to start first", async () => {
  const data = mkdtempSync(join(tmpdir(), "canon-epoch-"));
  try {
    assert.deepEqual(checkDataEpoch(data, contract(3, 2)), { ok: true, epoch: 3, fresh: true });
    mkdirSync(join(data, "convex"));
    writeFileSync(join(data, "convex/convex_local_backend.sqlite3"), "");
    // A volume run by an image from before the check counts as epoch 0.
    assert.deepEqual(checkDataEpoch(data, contract(1, 0)), { ok: true, epoch: 0, fresh: false });
    const skipped = checkDataEpoch(data, contract(3, 2, { bridge: "release/2026-12-01" }));
    assert.equal(skipped.ok, false);
    assert.match(!skipped.ok ? skipped.reason : "", /epoch 0.*release\/2026-12-01/);
    assert.deepEqual(await advanceDataEpoch(data, contract(1, 0), 0, async () => {}), { epoch: 1 });
    assert.equal(readFileSync(join(data, "data-epoch"), "utf8"), "1\n");
    assert.equal(checkDataEpoch(data, contract(0, 0)).ok, false, "data newer than the image is refused");
  } finally { rmSync(data, { recursive: true, force: true }); }
});

test("an image refuses a volume until the bridge release runs its listed migration and advances the epoch, then it starts", async () => {
  const data = mkdtempSync(join(tmpdir(), "canon-epoch-"));
  try {
    mkdirSync(join(data, "convex"));
    writeFileSync(join(data, "convex/convex_local_backend.sqlite3"), "");
    writeFileSync(join(data, "data-epoch"), "1\n");
    const newer = contract(3, 2, { bridge: "release/2026-12-01" });
    const bridge = contract(2, 1, { migrations: [{ epoch: 2, run: "migrations:fill" }] });
    assert.equal(checkDataEpoch(data, newer).ok, false);
    assert.deepEqual(checkDataEpoch(data, bridge), { ok: true, epoch: 1, fresh: false });
    const ran: string[] = [];
    const failed = await advanceDataEpoch(data, bridge, 1, async (m: { run: string }) => { ran.push(m.run); throw new Error("timed out"); });
    assert.deepEqual(failed, { epoch: 1, failed: { run: "migrations:fill", error: "timed out" } });
    assert.equal(checkDataEpoch(data, newer).ok, false, "a migration that failed leaves the volume where it was");
    assert.deepEqual(await advanceDataEpoch(data, bridge, 1, async (m: { run: string }) => void ran.push(m.run)), { epoch: 2 });
    assert.deepEqual(ran, ["migrations:fill", "migrations:fill"]);
    assert.deepEqual(checkDataEpoch(data, newer), { ok: true, epoch: 2, fresh: false });
  } finally { rmSync(data, { recursive: true, force: true }); }
});
