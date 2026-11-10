// The data epoch the volume was last run with (scripts/selfhost/data-contract.json), so an image-only
// install that pulls :latest can't jump past a release whose migration must run first. A git checkout
// tracks the same thing in .canon/data-epoch (releases.mjs); an image on Render or Railway has only the volume.
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseContract, planData } from "./releases.mjs";

const FILE = "data-epoch";

/**
 * Whether this image may start on the volume at `dataDir`. A volume with no record is new (nothing in
 * convex/) or was last run by an image from before this check, whose data is treated as epoch 0.
 * @param {string} dataDir
 * @param {ReturnType<typeof parseContract>} contract
 * @returns {{ ok: true, epoch: number, fresh: boolean } | { ok: false, reason: string }}
 */
export function checkDataEpoch(dataDir, contract) {
  const file = join(dataDir, FILE);
  const fresh = !existsSync(file) && !(existsSync(join(dataDir, "convex")) && readdirSync(join(dataDir, "convex")).length);
  if (fresh) return { ok: true, epoch: contract.epoch, fresh };
  const epoch = existsSync(file) ? Number(readFileSync(file, "utf8").trim()) : 0;
  if (!Number.isSafeInteger(epoch) || epoch < 0) return { ok: false, reason: `${file} is not a data epoch. Restore the volume from a backup.` };
  if (epoch > contract.epoch) {
    return { ok: false, reason: `This volume's data is at epoch ${epoch}, newer than this image supports (${contract.epoch}). Start the release that last ran on it, or a later one.` };
  }
  const [plan] = planData({ epoch, minEpoch: 0, migrations: [] }, [{ name: "this image", contract }]);
  if (!plan.safe) {
    const through = contract.bridge ?? "the last release before this one";
    return { ok: false, reason: `This volume's data is at epoch ${epoch}, but this image reads data from epoch ${contract.minEpoch}. Start ${through} on this volume first, let it become healthy, then start this image. See docs/updating.md.` };
  }
  return { ok: true, epoch, fresh };
}

/**
 * Bring the volume to this image's epoch once it runs healthy: each migration the release lists past `from`, in
 * order, then the record. A migration that fails stops there and leaves the volume at `from`, so an image that needs
 * the new epoch still refuses, and the next start runs the list again (a listed migration must be safe to rerun).
 * @param {string} dataDir
 * @param {ReturnType<typeof parseContract>} contract
 * @param {number} from
 * @param {(migration: { epoch: number, run: string }) => Promise<unknown>} run
 * @returns {Promise<{ epoch: number, failed?: { run: string, error: string } }>}
 */
export async function advanceDataEpoch(dataDir, contract, from, run) {
  const [plan] = planData({ epoch: from, minEpoch: 0, migrations: [] }, [{ name: "this image", contract }]);
  for (const migration of plan.migrations) {
    try {
      await run(migration);
    } catch (error) {
      return { epoch: from, failed: { run: migration.run, error: error instanceof Error ? error.message : String(error) } };
    }
  }
  const file = join(dataDir, FILE);
  writeFileSync(`${file}.tmp`, `${contract.epoch}\n`);
  renameSync(`${file}.tmp`, file);
  return { epoch: contract.epoch };
}

export function imageContract(appDir = "/app") {
  return parseContract(readFileSync(join(appDir, "scripts/selfhost/data-contract.json"), "utf8"));
}
