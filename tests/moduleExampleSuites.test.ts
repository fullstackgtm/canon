/**
 * The test suites a shipped module keeps beside its code (modules/examples/<slug>/**\/__tests__/*.test.ts), run as
 * part of the root suite: CI runs tests/*.test.ts only. One process for all of them is about half the CPU of one per
 * file.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const EXAMPLES = join(import.meta.dirname, "..", "modules", "examples");
const suites = (readdirSync(EXAMPLES, { recursive: true }) as string[])
  .filter((p) => /(^|\/)__tests__\/[^/]+\.test\.ts$/.test(p))
  .sort();
for (const p of suites) await import(pathToFileURL(join(EXAMPLES, p)).href);
