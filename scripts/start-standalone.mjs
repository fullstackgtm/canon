#!/usr/bin/env node

import { existsSync, lstatSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import process from "node:process";
import nextEnv from "@next/env";

const require = createRequire(import.meta.url);
const projectDir = process.cwd();
const { loadEnvConfig } = nextEnv;

function consumeValue(args, index, name) {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    console.error(`Missing value for ${name}`);
    process.exit(1);
  }
  return value;
}

function applyCliArgs(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--port" || arg === "-p") {
      process.env.PORT = consumeValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--port=")) {
      process.env.PORT = arg.slice("--port=".length);
      continue;
    }

    if (arg === "--hostname" || arg === "-H") {
      process.env.HOSTNAME = consumeValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--hostname=")) {
      process.env.HOSTNAME = arg.slice("--hostname=".length);
      continue;
    }
  }
}

loadEnvConfig(projectDir, false);
applyCliArgs(process.argv.slice(2));

const serverPath = resolve(projectDir, ".next/standalone/server.js");

if (!existsSync(serverPath)) {
  console.error("Missing .next/standalone/server.js. Run `npm run build` before `npm start`.");
  process.exit(1);
}

function ensureSymlink(source, target) {
  if (!existsSync(source)) return;

  if (existsSync(target)) {
    const targetStat = lstatSync(target);
    if (targetStat.isSymbolicLink() || targetStat.isDirectory()) return;

    console.error(`Cannot prepare standalone asset path because ${target} already exists.`);
    process.exit(1);
  }

  symlinkSync(relative(dirname(target), source), target, "dir");
}

ensureSymlink(resolve(projectDir, ".next/static"), resolve(projectDir, ".next/standalone/.next/static"));
ensureSymlink(resolve(projectDir, "public"), resolve(projectDir, ".next/standalone/public"));

if (
  !process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY &&
  process.env.NEXT_PUBLIC_FSGTM_UI_SMOKE_BYPASS !== "true"
) {
  console.error(
    [
      "Missing NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY.",
      "Production-style serving requires Clerk configuration for dashboard routes.",
      "For local smoke checks only, rebuild with NEXT_PUBLIC_FSGTM_UI_SMOKE_BYPASS=true and set FSGTM_SMOKE_BYPASS_TOKEN.",
    ].join("\n"),
  );
  process.exit(1);
}

require(serverPath);
