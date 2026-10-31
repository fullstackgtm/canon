// In-process runner for the engine CLI (`engine/src/cli.ts` runCli). Spawning
// `node engine/src/bin.ts` costs ~250 ms of CPU per call and dominated the
// suite; this captures console output and the exit code instead.
// Test files run in their own process and tests inside a file run serially,
// so swapping console and env for the duration of one call is safe.
// process.stdout/stderr.write are deliberately NOT intercepted: the test
// runner reports results through the same stream, and swallowing them hides
// test outcomes. Commands that must be checked byte-for-byte on a real pipe
// (ANSI safety) still spawn.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../engine/src/cli.ts";
import { clearActiveProfile } from "../../engine/src/credentials.ts";

export type CliResult = { stdout: string; stderr: string; status: number };

/** Run `fullstackgtm <argv>`; `env` entries override process.env (undefined deletes) for the call. */
export function cli(argv: string[], env: Record<string, string | undefined> = {}): Promise<CliResult> {
  // A `--profile` flag is process state in the real CLI; forget it after each run.
  return captureCli(() => runCli(argv).finally(clearActiveProfile), env);
}

/** Run any CLI entry function with console output, exit code, and env overrides captured/scoped. */
export async function captureCli(run: () => Promise<unknown>, env: Record<string, string | undefined> = {}): Promise<CliResult> {
  const out: string[] = [];
  const err: string[] = [];
  const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const savedExit = process.exitCode;
  const savedEnv: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    savedEnv[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const line = (sink: string[]) => (...args: unknown[]) => {
    sink.push(`${args.map(String).join(" ")}\n`);
  };
  process.exitCode = 0;
  console.log = line(out);
  console.info = line(out);
  console.warn = line(err);
  console.error = line(err);
  try {
    await run();
  } catch (error) {
    // bin.ts behavior: an escaped error prints its message and exits 1.
    err.push(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    Object.assign(console, saved);
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const status = Number(process.exitCode ?? 0);
  process.exitCode = savedExit;
  return { stdout: out.join(""), stderr: err.join(""), status };
}

/** Run `fn` with a fresh FSGTM_HOME (set in process.env for the duration), then delete it. */
export async function withHome<T>(fn: (home: string) => Promise<T> | T, prefix = "fsgtm-test-home-"): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), prefix));
  const prev = process.env.FSGTM_HOME;
  const prevProfile = process.env.FULLSTACKGTM_PROFILE;
  process.env.FSGTM_HOME = home;
  delete process.env.FULLSTACKGTM_PROFILE;
  try {
    return await fn(home);
  } finally {
    if (prev === undefined) delete process.env.FSGTM_HOME;
    else process.env.FSGTM_HOME = prev;
    if (prevProfile !== undefined) process.env.FULLSTACKGTM_PROFILE = prevProfile;
    rmSync(home, { recursive: true, force: true });
  }
}
