#!/usr/bin/env node
/**
 * The module kit's command line. Both commands take module directories, the current one when none is given.
 *
 *   canon-module-kit check [dir...]   module.json and the import rule
 *   canon-module-kit build [dir...]   module.json, then server.ts bundled into the file module.json's `server` names
 */
import { realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeModule } from "./build.ts";
import { checkModule } from "./check.ts";

const USAGE = "usage: canon-module-kit check|build [module dir...]";

/** Runs one command over `dirs` and returns the exit code: 0 when every module passed, 1 when one failed, 2 on bad usage. */
export async function main(args: string[], log = console.log, error = console.error): Promise<number> {
  const [command, ...rest] = args;
  const dirs = (rest.length ? rest : ["."]).map((dir) => resolve(dir));
  if (command === "check") {
    let failed = false;
    for (const dir of dirs) {
      const problems = checkModule(dir);
      if (problems.length) error(`${relative(process.cwd(), dir) || "."}:\n  ${problems.join("\n  ")}`);
      else log(`${relative(process.cwd(), dir) || "."}: ok`);
      failed ||= problems.length > 0;
    }
    return failed ? 1 : 0;
  }
  if (command === "build") {
    for (const dir of dirs) {
      try {
        const built = await writeModule(dir);
        log(`wrote ${relative(process.cwd(), built.path)} (${built.bytes} bytes, ${built.hash})`);
      } catch (e) {
        error((e as Error).message);
        return 1;
      }
    }
    return 0;
  }
  error(USAGE);
  return 2;
}

// npm links the bin through node_modules/.bin, so compare real paths.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await main(process.argv.slice(2));
