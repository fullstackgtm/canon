import { defineConfig } from "@playwright/test";
import { readFileSync } from "node:fs";

// No external URL override: this suite is only for this worktree's isolated stack.
const ports = readFileSync(new URL(".devstack/ports.env", import.meta.url), "utf8");
const port = /^NEXT_PORT=(\d+)$/m.exec(ports)?.[1];
if (!port) throw new Error("Start npm run dev:isolated -- --background first");

export default defineConfig({
  testDir: "./e2e",
  testMatch: "smoke.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  use: { baseURL: `http://127.0.0.1:${port}`, browserName: "chromium", trace: "retain-on-failure" },
});
