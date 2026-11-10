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
 * The object layer builds on vocabularies the module kernel owns (KERNEL_FILES): each is copied to
 * services/record-service/src/core/kernel/, and a copied core file's imports of modules/kernel/ point at those copies.
 * The other way, the kernel checks a manifest's reports over Canon's objects against the fields every workspace has:
 * the script writes them from the registry into modules/kernel/standardRecordFields.generated.ts.
 *
 * WHOLE_COPIES are dependency-free files copied whole from the one place each is defined. The kernel is the module kit's
 * package and imports nothing outside itself, but the engine is Apache-2.0 and the kernel AGPL-3.0: the engine keeps
 * its two files and the kernel a copy under the engine's license. The recipe runtime deploys from its own directory, so
 * it carries a copy of the kernel's bundleHash.
 *
 *   node --experimental-strip-types scripts/sync-object-core.ts           write the copies
 *   node --experimental-strip-types scripts/sync-object-core.ts --check   exit 1 if any copy is stale
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeStandardRecordFields, STANDARD_REPORT_OBJECTS } from "../convex/lib/modules/recordReportFields.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Source under convex/lib, copy under services/record-service/src/core, same relative layout so imports resolve unchanged. */
export const CORE_FILES = ["canon/policy.ts", "objects/registry.ts", "objects/splits.ts", "objects/rules.ts", "objects/formula.ts", "objects/fold.ts", "objects/listSpec.ts", "objects/reportSpec.ts", "objects/duplicates.ts", "objects/leadConversion.ts", "objects/inboundMatch.ts", "objects/moduleReport.ts"] as const;

/** Dependency-free files under modules/kernel, copied to services/record-service/src/core/kernel. They import only each other. */
export const KERNEL_FILES = ["reportLanguage.ts", "industries.ts", "dimensions.ts", "titles.ts"] as const;
const KERNEL_COPY = "kernel/";

/** Every copy: core files by their convex/lib path, kernel files under `kernel/`. */
export const COPIES = [...CORE_FILES, ...KERNEL_FILES.map((file) => `${KERNEL_COPY}${file}`)];

/** Copy path -> source path, both repo-relative. */
export const WHOLE_COPIES: Record<string, string> = {
  "modules/kernel/evidence.ts": "engine/src/evidence.ts",
  "modules/kernel/websiteSources.ts": "engine/src/portable/websiteSources.ts",
  "services/recipe-runtime/src/bundleHash.ts": "modules/kernel/bundleHash.ts",
};

export function expectedWholeCopy(copy: string): string {
  const source = WHOLE_COPIES[copy];
  const text = readFileSync(join(ROOT, source), "utf8");
  const spec = [...text.matchAll(IMPORT_FROM)][0]?.[2];
  if (spec) throw new Error(`${source} imports ${spec}: a file scripts/sync-object-core.ts copies whole imports nothing`);
  const license = source.startsWith("engine/") ? " Apache-2.0, as engine/LICENSE." : "";
  return `// GENERATED from ${source} by scripts/sync-object-core.ts. Edit the source, then rerun the script.${license}\n${text}`;
}

export const sourcePath = (copy: string) => (copy.startsWith(KERNEL_COPY) ? join(ROOT, "modules", copy) : join(ROOT, "convex/lib", copy));
export const copyPath = (copy: string) => join(ROOT, "services/record-service/src/core", copy);

const IMPORT_FROM = /(from\s+")([^"]+)(")/g;

/** A copy's text: a core file's imports of modules/kernel/ pointed at the kernel copies; a kernel file's imports checked. */
function copyText(copy: string, text: string): string {
  if (copy.startsWith(KERNEL_COPY)) {
    for (const [, , spec] of text.matchAll(IMPORT_FROM)) {
      if (!KERNEL_FILES.some((file) => spec === `./${file}`)) throw new Error(`modules/${copy} imports ${spec}: a kernel file the record service copies imports only other copied kernel files`);
    }
    return text;
  }
  const up = "../".repeat(copy.split("/").length - 1);
  const kernel = `${up}../../modules/kernel/`;
  return text.replace(IMPORT_FROM, (all, open: string, spec: string, close: string) => {
    if (!spec.startsWith(kernel)) return all;
    const file = spec.slice(kernel.length);
    if (!(KERNEL_FILES as readonly string[]).includes(file)) throw new Error(`convex/lib/${copy} imports modules/kernel/${file}, which scripts/sync-object-core.ts does not copy: add it to KERNEL_FILES`);
    return `${open}${up || "./"}${KERNEL_COPY}${file}${close}`;
  });
}

export function expectedCopy(copy: string): string {
  const source = copy.startsWith(KERNEL_COPY) ? `modules/${copy}` : `convex/lib/${copy}`;
  return `// GENERATED from ${source} by scripts/sync-object-core.ts. Edit the source, then rerun the script.\n${copyText(copy, readFileSync(sourcePath(copy), "utf8"))}`;
}

export const STANDARD_FIELDS = "modules/kernel/standardRecordFields.generated.ts";

export function expectedStandardFields(): string {
  const objects = STANDARD_REPORT_OBJECTS.map((object) => `  ${JSON.stringify(object)}: [\n${computeStandardRecordFields(object)!.map((f) => `    ${JSON.stringify(f)},`).join("\n")}\n  ],`);
  return [
    "// GENERATED from the registry (convex/lib/modules/recordReportFields.ts) by scripts/sync-object-core.ts. Rerun the script after changing a standard object.",
    'import type { ReportField } from "./reports.ts";',
    "",
    "/** The report fields of each Canon object as every workspace has it, before an admin adds a field (reports.ts standardRecordFields). */",
    "export const STANDARD_RECORD_FIELDS: Record<string, ReportField[]> = {",
    ...objects,
    "};",
    "",
  ].join("\n");
}

const stale = (path: string, expected: () => string) => {
  try {
    return readFileSync(path, "utf8") !== expected();
  } catch {
    return true;
  }
};

export function staleCopies(): string[] {
  return [
    ...COPIES.filter((copy) => stale(copyPath(copy), () => expectedCopy(copy))),
    ...Object.keys(WHOLE_COPIES).filter((copy) => stale(join(ROOT, copy), () => expectedWholeCopy(copy))),
    ...(stale(join(ROOT, STANDARD_FIELDS), expectedStandardFields) ? [STANDARD_FIELDS] : []),
  ];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--check")) {
    const stale = staleCopies();
    if (stale.length) {
      console.error(`stale generated copies: ${stale.join(", ")}. Run: node --experimental-strip-types scripts/sync-object-core.ts`);
      process.exit(1);
    }
  } else {
    for (const copy of COPIES) {
      mkdirSync(dirname(copyPath(copy)), { recursive: true });
      writeFileSync(copyPath(copy), expectedCopy(copy));
    }
    writeFileSync(join(ROOT, STANDARD_FIELDS), expectedStandardFields());
    for (const copy of Object.keys(WHOLE_COPIES)) writeFileSync(join(ROOT, copy), expectedWholeCopy(copy));
    console.log(`synced ${COPIES.length} files into services/record-service/src/core, ${STANDARD_FIELDS}, and ${Object.keys(WHOLE_COPIES).join(", ")}`);
  }
}
