/**
 * Turns a recipe directory into a package to publish to a GitHub repo (docs/recipes.md, "The package"):
 *
 *   node --experimental-strip-types scripts/recipe-package.ts recipes/fsgtm-velocity-deal <outDir>
 *
 * The directory holds recipe.md and any .ts files that register its code. The package is customization.md, plus
 * dist/customization.js when there is TypeScript (its .ts files or ```ts blocks): a markdown-only recipe needs no build, and
 * Canon pairs it with its built-ins at install. Nothing is written unless the recipe would install: recipe.md parses,
 * the markdown and the TypeScript use exactly the same names, and every eval passes on the code that ships.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleRecipeDir, readRecipeDir } from "./build-recipes.ts";
import { BUILTINS_BUNDLE } from "../recipes/_bundles.generated.ts";
import { markdownBundle } from "../recipes/compose.ts";
import { mismatch, type EvalResult } from "../recipes/index.ts";
import type { CallResult } from "../recipes/run.ts";
import { BUNDLE_FILE, BUNDLE_MAX_BYTES, RECIPE_FILE, RECIPE_MAX_BYTES, parseManifest, toManifest, type Manifest } from "../recipes/manifest.ts";
import { bundleHash } from "../services/recipe-runtime/src/protocol.ts";

type Run = (settings: unknown, calls: unknown[]) => CallResult[];
const load = async (code: string) => ((await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)) as { run: Run }).run;

/** The recipe's evals run against `code`, the bundle it runs on once installed. */
export async function bundleEvals(manifest: Manifest, code: string): Promise<EvalResult[]> {
  const results = (await load(code))(manifest.defaults, manifest.evals.map((e) => e.call));
  return manifest.evals.map((e, i) => {
    const r = results[i];
    const detail = r.ok ? mismatch(e.expect, r.value, manifest.defaults) : `the call failed (${r.error.kind}): ${r.error.message}`;
    return { name: e.name, ok: detail === null, detail };
  });
}

/** The package's files, built and checked, or why not. `code` is the bundle it runs on, shipped or Canon's. */
export async function buildPackage(recipeDir: string): Promise<{ manifest: Manifest; markdown: string; code: string; hash: string; hasCode: boolean; files: Record<string, string>; evals: EvalResult[] }> {
  const dir = await readRecipeDir(resolve(recipeDir));
  const manifest = toManifest(dir.recipe);
  const parsed = parseManifest(JSON.parse(JSON.stringify(manifest)));
  if (!parsed.ok) throw new Error(`${manifest.id}: it wouldn't install:\n  ${parsed.errors.join("\n  ")}`);
  if (Buffer.byteLength(dir.markdown) > RECIPE_MAX_BYTES) throw new Error(`${RECIPE_FILE} is over ${RECIPE_MAX_BYTES} bytes`);
  const hasCode = dir.tsFiles.length > 0 || dir.recipe.code.length > 0;
  const code = hasCode ? await bundleRecipeDir(dir) : markdownBundle(BUILTINS_BUNDLE, dir.recipe, await bundleHash(dir.markdown));
  if (Buffer.byteLength(code) > BUNDLE_MAX_BYTES) throw new Error(`${BUNDLE_FILE} is over ${BUNDLE_MAX_BYTES} bytes`);
  const evals = await bundleEvals(manifest, code);
  const failing = evals.filter((e) => !e.ok);
  if (failing.length) throw new Error(`${manifest.id}: ${failing.length} eval(s) fail on its code:\n  ${failing.map((e) => `${e.name}: ${e.detail}`).join("\n  ")}`);
  const files = { [RECIPE_FILE]: dir.markdown, ...(hasCode ? { [BUNDLE_FILE]: code } : {}) };
  return { manifest, markdown: dir.markdown, code, hash: await bundleHash(code), hasCode, evals, files };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [recipeDir, outDir] = process.argv.slice(2);
  if (!recipeDir || !outDir) throw new Error("usage: recipe-package.ts <recipeDir> <outDir>");
  const built = await buildPackage(recipeDir);
  for (const [name, text] of Object.entries(built.files)) {
    mkdirSync(join(outDir, name, ".."), { recursive: true });
    writeFileSync(join(outDir, name), text);
  }
  console.log(`${built.manifest.id} v${built.manifest.version}: ${built.evals.length} evals pass on ${built.hasCode ? `its bundle (${built.hash}, ${Buffer.byteLength(built.code)} bytes)` : "Canon's built-ins (markdown only, no build)"}`);
  console.log(`wrote ${Object.keys(built.files).map((f) => join(outDir, f)).join(", ")}`);
}
