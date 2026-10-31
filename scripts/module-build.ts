/**
 * Builds a module's server bundle (docs/modules.md, "Server code"): `<dir>/server.ts`, bundled with its imports
 * into one ESM file at the path module.json's `server` names (as dist/module.js), the file install stores and the
 * recipe runtime runs. Checks module.json first, and that the bundle exports a function for every call it declares.
 *
 *   npm run module:build -- <dir>
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { MODULE_FILE, parseModuleManifest } from "../modules/kernel/manifest.ts";
import { bundleHash } from "../services/recipe-runtime/src/protocol.ts";

export const SERVER_ENTRY = "server.ts";

/** The bundle for the module in `dir`, and where module.json says it goes. Throws with every problem. */
export async function buildModule(dir: string): Promise<{ path: string; code: string; hash: string }> {
  const parsed = parseModuleManifest(JSON.parse(readFileSync(join(dir, MODULE_FILE), "utf8")));
  if (!parsed.ok) throw new Error(`${join(dir, MODULE_FILE)}:\n  ${parsed.errors.join("\n  ")}`);
  const m = parsed.manifest;
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) throw new Error("usage: npm run module:build -- <module dir>");
  const built = await buildModule(resolve(dir));
  mkdirSync(dirname(built.path), { recursive: true });
  writeFileSync(built.path, built.code);
  console.log(`wrote ${relative(process.cwd(), built.path)} (${built.code.length} bytes, ${built.hash})`);
}
