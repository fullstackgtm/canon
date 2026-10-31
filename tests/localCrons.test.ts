import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { anyApi } from "convex/server";
import { loadConvex } from "./convexHandlers.ts";

const require = createRequire(import.meta.url);

test("local demo stacks disable cron registrations unless explicitly enabled", () => {
  const jobs = (env: Record<string, string>) => {
    const loaded = loadConvex(["crons.ts"], {}, {
      process: { env },
      require: (id: string) => id === "./_generated/api" ? { internal: anyApi } : require(id),
    })["crons.ts"];
    return JSON.parse((loaded.default as unknown as { export(): string }).export());
  };
  const normal = jobs({});
  assert.ok(normal["salesforce shadow sync tick"]);
  assert.ok(normal["sweep module jobs"]);
  assert.ok(normal["dispatch outbound messages"]);
  assert.deepEqual(jobs({ FSGTM_ENABLE_DEMO_DATA: "true" }), normal);
  assert.deepEqual(jobs({ CANONCRM_LOCAL_STACK: "true" }), {});
  assert.deepEqual(jobs({ CANONCRM_LOCAL_STACK: "true", CANONCRM_LOCAL_CRONS: "true" }), normal);
  assert.deepEqual(jobs({ FSGTM_ENABLE_DEMO_DATA: "false" }), normal);
});
