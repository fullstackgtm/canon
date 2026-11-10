/**
 * The module kit as an outside author gets it (docs/modules.md, "Build a module from your own repository"): packed with
 * npm, unpacked into a project outside this repository, and Stale facts typechecked, built and checked from it there.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { MODULE_API } from "../modules/kernel/manifest.ts";

const ROOT = join(import.meta.dirname, "..");
const KIT = join(ROOT, "modules/kernel");
const EXAMPLE = join(ROOT, "examples/modules/stale-facts");
const PKG = JSON.parse(readFileSync(join(KIT, "package.json"), "utf8")) as { name: string; version: string; bin: Record<string, string> };

test("the kit's major version is the module API it builds for", () => {
  assert.equal(PKG.version.split(".")[0], MODULE_API);
});

test("a project outside the repository installs the packed kit, then typechecks, builds and checks Stale facts", async () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "module-kit-")));
  try {
    const kit = join(tmp, "kit");
    cpSync(KIT, kit, { recursive: true, filter: (src) => !/[/\\](?:dist|node_modules)$/.test(src) });
    symlinkSync(join(ROOT, "node_modules"), join(kit, "node_modules"));
    const packed = spawnSync("npm", ["pack", "--json", "--pack-destination", tmp], { cwd: kit, encoding: "utf8" });
    assert.equal(packed.status, 0, packed.stderr);
    const tarball = join(tmp, (JSON.parse(packed.stdout.slice(packed.stdout.indexOf("["))) as Array<{ filename: string }>)[0].filename);

    const app = join(tmp, "app");
    const installed = join(app, "node_modules", ...PKG.name.split("/"));
    mkdirSync(installed, { recursive: true });
    const untar = spawnSync("tar", ["-xzf", tarball, "-C", installed, "--strip-components=1"], { encoding: "utf8" });
    assert.equal(untar.status, 0, untar.stderr);
    for (const dep of ["convex", "esbuild", "typescript"]) symlinkSync(join(ROOT, "node_modules", dep), join(app, "node_modules", dep));
    mkdirSync(join(app, "node_modules/.bin"));
    symlinkSync(join(installed, PKG.bin["canon-module-kit"]), join(app, "node_modules/.bin/canon-module-kit"));
    writeFileSync(join(app, "package.json"), JSON.stringify({ name: "outside", private: true, type: "module" }));
    writeFileSync(join(app, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "es2022", module: "nodenext", moduleResolution: "nodenext", strict: true, noEmit: true }, include: ["stale-facts/server.ts"] }));
    const server = readFileSync(join(EXAMPLE, "server.ts"), "utf8");
    assert.ok(server.includes(`from "${PKG.name}/calls"`), "the example imports the kit by its package name");
    for (const [dir, code] of [["stale-facts", server], ["planted", `${server}\nimport { api } from "../../canon/convex/_generated/api.js";\n`]]) {
      mkdirSync(join(app, dir));
      cpSync(join(EXAMPLE, "module.json"), join(app, dir, "module.json"));
      writeFileSync(join(app, dir, "server.ts"), code);
    }

    const tsc = spawnSync(process.execPath, [join(app, "node_modules/typescript/bin/tsc"), "-p", app], { cwd: app, encoding: "utf8" });
    assert.equal(tsc.status, 0, tsc.stdout);
    const built = spawnSync(process.execPath, [join(app, "node_modules/.bin/canon-module-kit"), "build", "stale-facts"], { cwd: app, encoding: "utf8" });
    assert.equal(built.status, 0, built.stderr);
    assert.equal(readFileSync(join(app, "stale-facts/dist/module.js"), "utf8"), readFileSync(join(EXAMPLE, "dist/module.js"), "utf8"));

    const { main } = (await import(pathToFileURL(join(installed, "dist/tools/cli.js")).href)) as { main: (args: string[], log: (s: string) => void, error: (s: string) => void) => Promise<number> };
    const passed: string[] = [];
    const failed: string[] = [];
    const code = await main(["check", join(app, "stale-facts"), join(app, "planted")], (s) => passed.push(s), (s) => failed.push(s));
    assert.equal(code, 1);
    assert.equal(passed.length, 1);
    assert.equal(failed.length, 1);
    assert.ok(failed[0].includes("planted") && failed[0].includes("../../canon/convex/_generated/api.js"), failed[0]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
