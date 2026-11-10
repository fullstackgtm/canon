import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDataEpoch, recordDataEpoch } from "../scripts/selfhost/dataEpoch.mjs";

const contract = (epoch: number, minEpoch: number, extra = {}) => ({ epoch, minEpoch, migrations: [], ...extra });

test("an image refuses a volume whose data it can't read, and names the release to start first", () => {
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
    assert.deepEqual(recordDataEpoch(data, contract(1, 0), 0), []);
    assert.equal(readFileSync(join(data, "data-epoch"), "utf8"), "1\n");
    assert.equal(checkDataEpoch(data, contract(0, 0)).ok, false, "data newer than the image is refused");
    const pending = [{ epoch: 2, run: "migrations:fill" }];
    assert.deepEqual(recordDataEpoch(data, { ...contract(2, 1), migrations: pending }, 1), pending, "a listed migration keeps the old epoch");
    assert.equal(readFileSync(join(data, "data-epoch"), "utf8"), "1\n");
  } finally { rmSync(data, { recursive: true, force: true }); }
});
