/**
 * Copy the object layer's pure core (registry, fold, the policy the fold
 * resolves with, and the list semantics) into the record service, so the
 * projector folds and lists with the same code Convex saves with.
 *
 * The record service image builds from services/record-service, so it cannot
 * import from convex/ at runtime. The deployment selector includes that
 * directory when deciding whether the service changed. A copy checked in under the service does both: the image carries
 * it, and a change to the fold changes the service and redeploys it.
 * tests/objectCoreSync.test.ts fails while a copy differs from its source.
 *
 *   node --experimental-strip-types scripts/sync-object-core.ts           write the copies
 *   node --experimental-strip-types scripts/sync-object-core.ts --check   exit 1 if any copy is stale
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Source under convex/lib, copy under services/record-service/src/core, same relative layout so imports resolve unchanged. */
export const CORE_FILES = ["canon/policy.ts", "objects/registry.ts", "objects/splits.ts", "objects/rules.ts", "objects/formula.ts", "objects/fold.ts", "objects/listSpec.ts", "objects/reportSpec.ts", "objects/duplicates.ts", "objects/leadConversion.ts", "objects/inboundMatch.ts", "objects/moduleReport.ts"] as const;

export const sourcePath = (file: string) => join(ROOT, "convex/lib", file);
export const copyPath = (file: string) => join(ROOT, "services/record-service/src/core", file);

export function expectedCopy(file: string): string {
  return `// GENERATED from convex/lib/${file} by scripts/sync-object-core.ts. Edit the source, then rerun the script.\n${readFileSync(sourcePath(file), "utf8")}`;
}

export function staleCopies(): string[] {
  return CORE_FILES.filter((file) => {
    try {
      return readFileSync(copyPath(file), "utf8") !== expectedCopy(file);
    } catch {
      return true;
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--check")) {
    const stale = staleCopies();
    if (stale.length) {
      console.error(`stale record-service core copies: ${stale.join(", ")}. Run: node --experimental-strip-types scripts/sync-object-core.ts`);
      process.exit(1);
    }
  } else {
    for (const file of CORE_FILES) {
      mkdirSync(dirname(copyPath(file)), { recursive: true });
      writeFileSync(copyPath(file), expectedCopy(file));
    }
    console.log(`synced ${CORE_FILES.length} files into services/record-service/src/core`);
  }
}
