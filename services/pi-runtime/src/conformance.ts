import { createStorageConformance } from "@earendil-works/pi-durable/testing";
import type { Storage } from "@earendil-works/pi-durable";
import { context } from "./runtime.ts";

function equal(actual: unknown, expected: unknown, partial = false): boolean {
  if (Object.is(actual, expected)) return true;
  if (!actual || !expected || typeof actual !== "object" || typeof expected !== "object") return false;
  if (Array.isArray(actual) !== Array.isArray(expected)) return false;
  const a = actual as Record<string, unknown>, e = expected as Record<string, unknown>;
  return (partial || Object.keys(a).length === Object.keys(e).length) && Object.keys(e).every((key) => Object.hasOwn(a, key) && equal(a[key], e[key], partial));
}

export async function conformance(open: (index: number) => Promise<Storage>) {
  const check = (condition: unknown) => { if (!condition) throw new Error("Storage assertion failed"); };
  let index = 0;
  const cases = createStorageConformance({
    assertions: {
      ok: check, strictEqual: (a, e) => check(Object.is(a, e)),
      deepEqual: (a, e) => check(equal(a, e)), partialDeepEqual: (a, e) => check(equal(a, e, true)),
      greaterThan: (a, b) => check(a > b),
      rejects: async (operation, message) => {
        let rejected = false;
        try { await operation; } catch (error) { rejected = true; check(String(error).includes(message)); }
        check(rejected);
      },
    },
    withStorage: async (use) => {
      const storage = await open(index++);
      try { await use(storage); } finally { await storage.close(context); }
    },
  });
  const failures: string[] = [];
  const reasons: Array<{ test: string; message: string }> = [];
  for (const test of cases) {
    try { await test.run(); } catch (error) {
      failures.push(test.name);
      reasons.push({ test: test.name, message: error instanceof Error ? error.message : "Unknown storage failure" });
    }
  }
  return { cases: cases.length, passed: cases.length - failures.length, failures, reasons };
}
