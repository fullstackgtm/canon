/**
 * Builds the first-party recipes from their directories (docs/recipes.md, "Writing a recipe"). Each `recipes/<id>/`
 * holds `recipe.md` and any `.ts` files that register its code. Convex and the app can't read markdown, so this writes
 * recipes/_recipes.generated.ts (each recipe compiled, with imports of its .ts files) and recipes/_bundles.generated.ts
 * (each recipe with plays bundled for the recipe runtime, and Canon's built-ins bundle that a markdown-only package
 * runs on). Any problem in a recipe fails the build.
 *
 *   node --experimental-strip-types scripts/build-recipes.ts
 *
 * tests/recipeMarkdown.test.ts and tests/recipeRuntime.test.ts fail when either file is stale.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, type Plugin } from "esbuild";
import { STANDARD_OBJECTS } from "../convex/lib/objects/registry.ts";
import { RECIPE_PLACEHOLDER, nameProblems, runnable } from "../recipes/compose.ts";
import { PAGE_OBJECTS, RECIPE_IDS } from "../recipes/kernel.ts";
import { formatProblems, parseRecipe, type CompiledRecipe } from "../recipes/md/parse.ts";
import type { Extension } from "../recipes/sdk.ts";
import { bundleHash } from "../services/recipe-runtime/src/protocol.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const RECIPES_FILE = join(ROOT, "recipes", "_recipes.generated.ts");
export const BUNDLES_FILE = join(ROOT, "recipes", "_bundles.generated.ts");
const SDK = join(ROOT, "recipes", "sdk.ts");
const COMPOSE = join(ROOT, "recipes", "compose.ts");
/** The standard fields of each object a recipe's page lays out, so a page naming a field none has warns. */
const objectFields = Object.fromEntries(PAGE_OBJECTS.map((o) => [o, STANDARD_OBJECTS[o].fields.map((f) => f.apiName)]));

/** A recipe directory read and checked: its markdown, the recipe it compiles to, and its TypeScript. */
export type RecipeDir = { dir: string; markdown: string; recipe: CompiledRecipe; tsFiles: string[]; extensions: Extension[] };

/** The source of a ```ts block as a module: its body registers on `canon`, with the SDK's exports in scope. */
const blockModule = (source: string) => [
  `import * as sdk from ${JSON.stringify(SDK)};`,
  `const { ${["CHANNEL_LABEL", "DAY", "LINKEDIN_MAX", "ROLE_LABEL", "daysUntil"].join(", ")} } = sdk;`,
  `export default sdk.defineRecipe((canon) => {`,
  source,
  `});`,
].join("\n");

/** The ```ts blocks as virtual modules `canon-block:<n>`, so they bundle like the package's .ts files. */
const blocks = (recipe: CompiledRecipe): Plugin => ({
  name: "canon-blocks",
  setup(b) {
    b.onResolve({ filter: /^canon-block:\d+$/ }, (a) => ({ path: a.path, namespace: "canon-block" }));
    b.onLoad({ filter: /.*/, namespace: "canon-block" }, (a) => ({ contents: blockModule(recipe.code[Number(a.path.split(":")[1])].source), loader: "ts", resolveDir: ROOT }));
  },
});

/** ESM with no imports left: the isolate loads it as one module. */
async function bundle(entry: string, name: string, plugins: Plugin[] = []): Promise<string> {
  const out = await build({
    stdin: { contents: entry, resolveDir: ROOT, sourcefile: `${name}.entry.ts`, loader: "ts" },
    absWorkingDir: ROOT, bundle: true, format: "esm", platform: "neutral", target: "es2022", plugins,
    write: false, legalComments: "none", charset: "utf8", logLevel: "silent",
  });
  const code = out.outputFiles[0].text;
  const leaked = [...code.matchAll(/^import .* from "([^"]+)"/gm)].map((m) => m[1]);
  if (leaked.length) throw new Error(`${name}: bundle still imports ${leaked.join(", ")}`);
  return code;
}

/** Each ```ts block as an extension, for checks and evals in Node. */
async function blockExtensions(r: RecipeDir["recipe"]): Promise<Extension[]> {
  return Promise.all(r.code.map(async (_, i) => {
    const code = await bundle(`export { default } from "canon-block:${i}";`, `${r.meta.id} block ${i}`, [blocks(r)]);
    return ((await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)) as { default: Extension }).default;
  }));
}

/**
 * The recipe in `dir`, or why not, each problem with its file and line: a markdown problem, a name the markdown uses
 * that no .ts file or ```ts block registers, or one they register that the markdown never uses.
 */
export async function readRecipeDir(dir: string, opts: Parameters<typeof parseRecipe>[1] = {}): Promise<RecipeDir> {
  const file = join(dir, "recipe.md");
  const markdown = readFileSync(file, "utf8");
  const { recipe, problems } = parseRecipe(markdown, opts);
  const shown = relative(process.cwd(), file);
  if (problems.length) throw new Error(formatProblems(shown, problems).join("\n"));
  const tsFiles = readdirSync(dir).filter((f) => f.endsWith(".ts")).sort().map((f) => resolve(dir, f));
  const files = await Promise.all(tsFiles.map(async (f) => {
    const ext = ((await import(pathToFileURL(f).href)) as { default?: Extension }).default;
    if (!ext || !Array.isArray(ext.registrations)) throw new Error(`${relative(process.cwd(), f)} must export default defineRecipe((canon) => { ... })`);
    return ext;
  }));
  const extensions = [...files, ...(await blockExtensions(recipe))];
  const names = nameProblems(recipe, extensions);
  if (names.length) throw new Error(names.map((p) => `${shown}${p.line ? `:${p.line}` : ""}: error: ${p.message}`).join("\n"));
  return { dir, markdown, recipe, tsFiles, extensions };
}

/** One ESM module exporting `run(settings, calls)`: the recipe's markdown, its TypeScript and the kernel's play code. */
export async function bundleRecipeDir(r: RecipeDir): Promise<string> {
  const markdown = await bundleHash(r.markdown);
  const imports = [...r.tsFiles.map((f) => JSON.stringify(f)), ...r.recipe.code.map((_, i) => JSON.stringify(`canon-block:${i}`))];
  const entry = [
    `import { runRecipe } from ${JSON.stringify(COMPOSE)};`,
    ...imports.map((spec, i) => `import e${i} from ${spec};`),
    `const RECIPE = ${JSON.stringify(runnable(r.recipe))};`,
    `export function run(settings, calls) {`,
    `  return runRecipe(RECIPE, [${imports.map((_, i) => `e${i}`).join(", ")}], settings, calls, ${JSON.stringify(markdown)});`,
    `}`,
  ].join("\n");
  return bundle(entry, r.recipe.meta.id, [blocks(r.recipe)]);
}

/** Canon's built-ins bundle: the play code with no TypeScript, waiting for a markdown-only recipe in its placeholder. */
export function builtinsBundle(): Promise<string> {
  return bundle([
    `import { runRecipe } from ${JSON.stringify(COMPOSE)};`,
    `const R = ${JSON.stringify(RECIPE_PLACEHOLDER)};`,
    `export function run(settings, calls) {`,
    `  return runRecipe(R.recipe, [], settings, calls, R.markdown);`,
    `}`,
  ].join("\n"), "canon-builtins");
}

const ident = (file: string) => basename(file, ".ts").replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ?? "").toUpperCase());

/** Both generated modules' text. */
export async function generate(): Promise<{ recipes: string; bundles: string }> {
  const recipes: string[] = [], imports: string[] = [], bundles: string[] = [], markdowns: string[] = [];
  for (const id of RECIPE_IDS) {
    const r = await readRecipeDir(join(ROOT, "recipes", id), { objectFields });
    if (r.recipe.meta.id !== id) throw new Error(`recipes/${id}/recipe.md: its id is ${r.recipe.meta.id}, and a first-party recipe's id is its directory's name`);
    if (r.recipe.code.length) throw new Error(`recipes/${id}/recipe.md: a first-party recipe keeps its code in .ts files, which Convex imports; move the \`\`\`ts blocks into one`);
    const names = r.tsFiles.map((f) => {
      const name = `${ident(id)}${ident(f)[0].toUpperCase()}${ident(f).slice(1)}`;
      imports.push(`import ${name} from ${JSON.stringify(`./${relative(join(ROOT, "recipes"), f)}`)};`);
      return name;
    });
    recipes.push(`  ${JSON.stringify(id)}: { extensions: [${names.join(", ")}], recipe: ${JSON.stringify(r.recipe, null, 2).replaceAll("\n", "\n  ")} },`);
    markdowns.push(`  ${JSON.stringify(id)}: ${JSON.stringify(r.markdown)},`);
    if (r.recipe.data) {
      const code = await bundleRecipeDir(r);
      bundles.push(`  ${JSON.stringify(id)}: { hash: ${JSON.stringify(await bundleHash(code))}, code: ${JSON.stringify(code)} },`);
    }
  }
  const builtins = await builtinsBundle();
  const header = `// Generated by ${relative(ROOT, fileURLToPath(import.meta.url))} from recipes/<id>/. Do not edit: run it again.`;
  return {
    recipes: [
      header,
      `import type { RecipeId } from "./kernel.ts";`,
      `import type { CompiledRecipe } from "./md/parse.ts";`,
      `import type { Extension } from "./sdk.ts";`,
      ...imports,
      ``,
      `export const FIRST_PARTY: Record<RecipeId, { recipe: CompiledRecipe; extensions: readonly Extension[] }> = {`,
      ...recipes,
      `};`,
      ``,
    ].join("\n"),
    bundles: [
      header,
      `import type { RecipeId } from "./kernel.ts";`,
      ``,
      `export const RECIPE_BUNDLES: Partial<Record<RecipeId, { hash: string; code: string }>> = {`,
      ...bundles,
      `};`,
      ``,
      `/** The play code a markdown-only package runs on, with its recipe in place of ${JSON.stringify(RECIPE_PLACEHOLDER)} (recipes/compose.ts, markdownBundle). */`,
      `export const BUILTINS_BUNDLE = ${JSON.stringify(builtins)};`,
      ``,
      `/** Each first-party recipe.md as written, which Customize copies into a workspace recipe (recipes/workspace.ts). */`,
      `export const FIRST_PARTY_MARKDOWN: Record<RecipeId, string> = {`,
      ...markdowns,
      `};`,
      ``,
    ].join("\n"),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = await generate();
  writeFileSync(RECIPES_FILE, out.recipes);
  writeFileSync(BUNDLES_FILE, out.bundles);
  console.log(`wrote ${relative(ROOT, RECIPES_FILE)} and ${relative(ROOT, BUNDLES_FILE)}`);
}
