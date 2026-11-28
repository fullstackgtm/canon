#!/usr/bin/env node
// Runs Bombadil against this worktree's isolated stack, and nothing else.
//
//   npm run e2e:bombadil                      # 10 minute headless exploration from /dashboard
//   npm run e2e:bombadil -- --time-limit 2m   # any extra flags go to `bombadil browser test`
//   npm run e2e:bombadil -- shrink --trace .bombadil/run --property noConsoleErrors
//   npm run e2e:bombadil -- inspect .bombadil/run
//
// The port comes from .devstack/ports.env; there is no URL override. `--allow-url` pins exploration
// to that port on localhost and 127.0.0.1, and the spec's staysOnLocalhost property checks it held.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const VERSION = "0.8.0";
const root = fileURLToPath(new URL("../..", import.meta.url));
let ports;
try {
  ports = readFileSync(`${root}.devstack/ports.env`, "utf8");
} catch {
  console.error("No .devstack/ports.env. Start the stack: npm run dev:isolated -- --background");
  process.exit(1);
}
const port = /^NEXT_PORT=(\d+)$/m.exec(ports)?.[1];
if (!port) {
  console.error("NEXT_PORT missing from .devstack/ports.env");
  process.exit(1);
}

const origin = `http://localhost:${port}`;
const spec = fileURLToPath(new URL("canon.ts", import.meta.url));
const out = `${root}.bombadil`;
mkdirSync(out, { recursive: true });

const args = process.argv.slice(2);
const mode = ["shrink", "inspect"].includes(args[0]) ? args.shift() : "test";
const bounds = [`--allow-url=http://localhost:${port}/*`, `--allow-url=http://127.0.0.1:${port}/*`];

let argv;
if (mode === "inspect") {
  argv = ["browser", "inspect", ...args];
} else {
  const has = (flag) => args.some((a) => a === flag || a.startsWith(`${flag}=`));
  argv = ["browser", mode, "--headless", ...bounds];
  if (mode === "test" && !has("--time-limit") && !has("--reproduce")) argv.push("--time-limit=10m");
  if (!has("--output-path")) argv.push(`--output-path=${out}/${mode === "shrink" ? "shrunk" : "run"}`, "--output-path-overwrite");
  argv.push(...args, `${origin}/dashboard`, spec);
}

console.error(`bombadil ${argv.join(" ")}`);
const result = spawnSync("npx", ["--yes", `@antithesishq/bombadil@${VERSION}`, ...argv], { stdio: "inherit", cwd: root });
process.exit(result.status ?? 1);
