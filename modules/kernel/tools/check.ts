/**
 * Checks a module the way an author runs it before a build: module.json whole, and the import rule over every source
 * file in the module's directory. A module imports only its own files, the module kit and npm packages, so its bundle
 * holds nothing of Canon's application.
 *
 * Node-only tooling: Convex and module bundles never import this directory.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { readManifest } from "./build.ts";
import { SOURCE, findImports, leavesModule, resolveSpecifier } from "./imports.ts";

const SKIPPED = new Set(["node_modules", "dist"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith(".") || SKIPPED.has(entry.name)) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && SOURCE.test(entry.name) ? [path] : [];
  });
}

const posixPath = (path: string) => path.split(sep).join("/");

/** Every import in the module in `dir` that leaves it, as `<file>:<line> imports <specifier>`. */
export function importProblems(dir: string): string[] {
  const root = `${posixPath(resolve(dir))}/`;
  const files = sourceFiles(resolve(dir)).map(posixPath);
  const fileSet = new Set(files);
  return files.flatMap((from) => findImports(readFileSync(from, "utf8")).flatMap((found) => {
    const to = resolveSpecifier(from, found.specifier, fileSet);
    if (to === null || !leavesModule(root, to)) return [];
    return [`${from.slice(root.length)}:${found.line} imports ${found.specifier}, outside the module: a module imports only its own files, the module kit and npm packages`];
  }));
}

/** Every problem with the module in `dir`: module.json's, then its imports'. Empty when it passes. */
export function checkModule(dir: string): string[] {
  try {
    readManifest(dir);
  } catch (error) {
    return [(error as Error).message, ...importProblems(dir)];
  }
  return importProblems(dir);
}
