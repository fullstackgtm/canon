/**
 * Builds a module's server bundle (docs/modules.md, "Server code"): `<dir>/server.ts`, bundled with its imports into
 * one ESM file at the path module.json's `server` names (as dist/module.js), the file install stores and the recipe
 * runtime runs. Checks module.json first, and that the bundle exports a function for every call it declares.
 *
 * Node-only tooling: Convex and module bundles never import this directory.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { build } from "esbuild";
import { bundleHash } from "../bundleHash.ts";
import { MODULE_FILE, parseModuleManifest, type ModuleManifest } from "../manifest.ts";

export const SERVER_ENTRY = "server.ts";

/** The module.json in `dir`, checked whole. Throws with every problem, each with its path. */
export function readManifest(dir: string): ModuleManifest {
  const file = join(dir, MODULE_FILE);
  const parsed = parseModuleManifest(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.ok) throw new Error(`${file}:\n  ${parsed.errors.join("\n  ")}`);
  return parsed.manifest;
}

/** The bundle for the module in `dir`, and where module.json says it goes. Throws with every problem. */
export async function buildModule(dir: string): Promise<{ path: string; code: string; hash: string }> {
  const m = readManifest(dir);
  if (!m.server) throw new Error(`${join(dir, MODULE_FILE)} declares no server: a module without calls has no code to build`);
  // Paths are relative to the module's directory, through symlinks as the checkout lays them out, and esbuild's
  // "// <path>" comment over each file is dropped: the same source builds the same bytes in any checkout.
  const out = await build({
    entryPoints: [SERVER_ENTRY], absWorkingDir: resolve(dir), preserveSymlinks: true, bundle: true, format: "esm", platform: "neutral", target: "es2022",
    write: false, legalComments: "none", charset: "utf8", logLevel: "silent", metafile: true,
  });
  const comments = new Set(Object.keys(out.metafile.inputs).map((path) => `// ${path}`));
  const code = out.outputFiles[0].text.split("\n").filter((line) => !comments.has(line)).join("\n");
  const leaked = [...code.matchAll(/^import .* from "([^"]+)"/gm)].map((x) => x[1]);
  if (leaked.length) throw new Error(`${SERVER_ENTRY}: the bundle still imports ${leaked.join(", ")}; a module's code runs with nothing to import`);
  const loaded = (await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)) as { calls?: Record<string, unknown> };
  const missing = Object.entries(m.calls ?? {}).filter(([name, c]) => !c.ai && !c.canon && typeof loaded.calls?.[name] !== "function").map(([name]) => name);
  if (missing.length) throw new Error(`${SERVER_ENTRY} must export const calls = { ${missing.join(", ")} }: module.json declares ${missing.length === 1 ? "it" : "them"}`);
  return { path: join(dir, m.server), code, hash: await bundleHash(code) };
}

/** Builds the module in `dir` and writes its bundle. */
export async function writeModule(dir: string): Promise<{ path: string; bytes: number; hash: string }> {
  const built = await buildModule(dir);
  mkdirSync(dirname(built.path), { recursive: true });
  writeFileSync(built.path, built.code);
  return { path: built.path, bytes: built.code.length, hash: built.hash };
}
