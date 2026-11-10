import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Brands are only as strong as their minters: one file may cast to each. */
test("brand discipline: ActingAgent is cast only in convex/agents.ts, DeclaredLabel only in its parser", () => {
  const root = join(import.meta.dirname, "..");
  const allowed: Record<string, string> = { ActingAgent: "convex/agents.ts", DeclaredLabel: "convex/lib/agents/attribution.ts" };
  const hits: string[] = [];
  const minters: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "_generated" || name.startsWith(".")) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name)) {
        const text = readFileSync(path, "utf8");
        for (const [brand, file] of Object.entries(allowed)) {
          if (!new RegExp(`as\\s+(unknown\\s+as\\s+)?${brand}\\b`).test(text)) continue;
          if (relative(root, path) === file) minters.push(brand);
          else hits.push(`${relative(root, path)}: as ${brand}`);
        }
      }
    }
  };
  walk(join(root, "convex"));
  walk(join(root, "src"));
  assert.deepEqual(hits, []);
  assert.deepEqual(minters.sort(), ["ActingAgent", "DeclaredLabel"]);
});
