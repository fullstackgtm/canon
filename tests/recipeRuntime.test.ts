import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ConvexError } from "convex/values";
import { BUNDLES_FILE, generate } from "../scripts/build-recipes.ts";
import { dealPageBatch } from "../scripts/recipe-check.ts";
import { RECIPE_BUNDLES } from "../recipes/_bundles.generated.ts";
import { runPlays } from "../convex/lib/recipeRuntime.ts";
import { handle, type Loader } from "../services/recipe-runtime/src/index.ts";

const importCode = (code: string) => import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`) as Promise<{ run: (s: unknown, c: unknown) => unknown }>;
const ctx = {} as never;

test("the generated bundles are current, and the bundle returns what the recipe returns in-process", async () => {
  assert.equal(readFileSync(BUNDLES_FILE, "utf8"), (await generate()).bundles, "recipes/_bundles.generated.ts is stale: run scripts/build-recipes.ts");
  const bundle = await importCode(RECIPE_BUNDLES["fsgtm-enterprise-deal"]!.code);
  delete process.env.RECIPE_RUNTIME_URL;
  for (const seed of [1, 2, 3]) {
    const { ref, calls } = dealPageBatch(seed);
    const isolated = JSON.parse(JSON.stringify(bundle.run(ref.settings, JSON.parse(JSON.stringify(calls))))) as Array<{ ok: boolean; value: unknown }>;
    assert.deepEqual(isolated.map((r) => r.value), await runPlays(ctx, ref, calls), `seed ${seed}`);
  }
});

test("runPlays signs each request, sends the code once the runtime asks, and fails loudly", async (t) => {
  const loader: Loader = {
    get: (_id, code) => ({ getEntrypoint: () => ({ run: async (settings, calls) => (await importCode((await code()).modules["recipe.js"])).run(settings, calls) as unknown[] }) }),
  };
  const sent: Array<{ code: boolean; status: number }> = [];
  let secret = "test-secret";
  t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
    const res = await handle(new Request(url, init), { LOADER: loader, RECIPE_RUNTIME_SECRET: secret });
    sent.push({ code: "code" in JSON.parse(init.body as string).bundle, status: res.status });
    return res;
  });
  process.env.RECIPE_RUNTIME_URL = "https://runtime.test";
  process.env.RECIPE_RUNTIME_SECRET = "test-secret";
  t.after(() => { delete process.env.RECIPE_RUNTIME_URL; delete process.env.RECIPE_RUNTIME_SECRET; });

  const { ref, calls } = dealPageBatch(4);
  const remote = await runPlays(ctx, ref, calls);
  delete process.env.RECIPE_RUNTIME_URL;
  assert.deepEqual(remote, await runPlays(ctx, ref, calls));
  assert.deepEqual(sent, [{ code: false, status: 409 }, { code: true, status: 200 }]);

  process.env.RECIPE_RUNTIME_URL = "https://runtime.test";
  await runPlays(ctx, ref, calls);
  assert.deepEqual(sent.at(-1), { code: false, status: 200 }, "a bundle the runtime has seen isn't sent again");
  await assert.rejects(runPlays(ctx, ref, [{ fn: "nope" } as never]), (e) => e instanceof ConvexError && /nope/.test(String(e.data)));
  secret = "another-secret";
  await assert.rejects(runPlays(ctx, ref, calls), (e) => e instanceof ConvexError && /401/.test(String(e.data)));
});
