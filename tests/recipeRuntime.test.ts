import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ConvexError } from "convex/values";
import { BUNDLES_FILE, generate } from "../scripts/build-recipes.ts";
import { dealPageBatch } from "../scripts/recipe-check.ts";
import { RECIPE_BUNDLES } from "../recipes/_bundles.generated.ts";
import { runPlays, runSettled } from "../convex/lib/recipeRuntime.ts";
import { handle, type Loader } from "../services/recipe-runtime/src/index.ts";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, bundleHash, sign } from "../services/recipe-runtime/src/protocol.ts";

const importCode = (code: string) => import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`) as Promise<{ run: (s: unknown, c: unknown) => unknown }>;
const ctx = {} as never;

test("the generated bundles are current, and the bundle returns what the recipe returns in-process", async () => {
  assert.equal(readFileSync(BUNDLES_FILE, "utf8"), (await generate()).bundles, "recipes/_bundles.generated.ts is stale: run scripts/build-recipes.ts");
  const bundle = await importCode(RECIPE_BUNDLES["fsgtm-enterprise-deal"]!.code);
  delete process.env.RECIPE_RUNTIME_URL;
  for (const seed of [1, 2, 3]) {
    const { ref, calls } = dealPageBatch(seed);
    const isolated = JSON.parse(JSON.stringify(bundle.run(ref.settings, JSON.parse(JSON.stringify(calls))))) as Array<{ ok: boolean; value: unknown }>;
    assert.deepEqual(isolated.map((r) => r.value), await runPlays(ctx, ref, calls, "org1"), `seed ${seed}`);
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
  const remote = await runPlays(ctx, ref, calls, "org1");
  delete process.env.RECIPE_RUNTIME_URL;
  assert.deepEqual(remote, await runPlays(ctx, ref, calls, "org1"));
  assert.deepEqual(sent, [{ code: false, status: 409 }, { code: true, status: 200 }]);

  process.env.RECIPE_RUNTIME_URL = "https://runtime.test";
  await runPlays(ctx, ref, calls, "org1");
  assert.deepEqual(sent.at(-1), { code: false, status: 200 }, "a bundle the runtime has seen isn't sent again");
  await assert.rejects(runPlays(ctx, ref, [{ fn: "nope" } as never], "org1"), (e) => e instanceof ConvexError && /nope/.test(String(e.data)));
  secret = "another-secret";
  await assert.rejects(runPlays(ctx, ref, calls, "org1"), (e) => e instanceof ConvexError && /401/.test(String(e.data)));
});

test("/run requires a tenant isolate scope and keys LOADER isolates per tenant", async (t) => {
  // Stateful bundle simulating module-level state inside a V8 isolate.
  const code = `let seen = [];
export function run(_settings, calls) {
  return calls.map((c) => {
    if (c.fn === "put") seen.push(c.input[0]);
    return { ok: true, value: [...seen] };
  });
}`;
  const hash = await bundleHash(code);
  const instances = new Map<string, Promise<{ run: (s: unknown, c: unknown) => unknown }>>();
  const seenIds: string[] = [];
  const loader: Loader = {
    get: (id, load) => {
      seenIds.push(id);
      return {
        getEntrypoint: () => ({
          run: async (settings, calls) => {
            let mod = instances.get(id);
            if (!mod) {
              // Each distinct loader id gets its own fresh module instance (distinct URL fragment).
              const src = (await load()).modules["recipe.js"];
              mod = import(`data:text/javascript;base64,${Buffer.from(`${src}\n// ${id}`).toString("base64")}`) as Promise<{ run: (s: unknown, c: unknown) => unknown }>;
              instances.set(id, mod);
            }
            return (await mod).run(settings, calls) as unknown[];
          },
        }),
      };
    },
  };
  const secret = "test-secret";
  const signedRun = async (payload: Record<string, unknown>) => {
    const body = JSON.stringify(payload);
    const ts = String(Date.now());
    return handle(
      new Request("https://runtime.test/run", {
        method: "POST",
        body,
        headers: { "content-type": "application/json", [TIMESTAMP_HEADER]: ts, [SIGNATURE_HEADER]: await sign(secret, ts, body) },
      }),
      { LOADER: loader, RECIPE_RUNTIME_SECRET: secret },
    );
  };

  // Missing, empty, or malformed isolate keys are refused with 400 before touching LOADER.
  for (const bad of [{ bundle: { hash, code }, settings: {}, calls: [] }, { bundle: { hash, code }, isolate: "", settings: {}, calls: [] }, { bundle: { hash, code }, isolate: "org a", settings: {}, calls: [] }]) {
    const res = await signedRun(bad);
    assert.equal(res.status, 400);
  }
  assert.deepEqual(seenIds, []);

  // Client side fails closed on blank/invalid isolate keys too.
  t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => handle(new Request(url, init), { LOADER: loader, RECIPE_RUNTIME_SECRET: secret }));
  process.env.RECIPE_RUNTIME_URL = "https://runtime.test";
  process.env.RECIPE_RUNTIME_SECRET = secret;
  t.after(() => { delete process.env.RECIPE_RUNTIME_URL; delete process.env.RECIPE_RUNTIME_SECRET; });

  await assert.rejects(
    runSettled({ id: "@acme/custom", isolate: "   ", settings: {}, installed: { hash, code: async () => code } }, [{ fn: "get", input: [] } as never]),
    (e) => e instanceof ConvexError,
  );

  // Two tenants running the exact same bundle hash get distinct isolate IDs and cannot observe each other's state.
  const a1 = await runSettled({ id: "@acme/custom", isolate: "orgA:@acme/custom", settings: {}, installed: { hash, code: async () => code } }, [{ fn: "put", input: ["tenant-a-secret"] } as never]);
  const b1 = await runSettled({ id: "@acme/custom", isolate: "orgB:@acme/custom", settings: {}, installed: { hash, code: async () => code } }, [{ fn: "get", input: [] } as never]);
  assert.deepEqual(a1, [{ ok: true, value: ["tenant-a-secret"] }]);
  assert.deepEqual(b1, [{ ok: true, value: [] }]);
  assert.deepEqual(seenIds, [`${hash}:orgA:@acme/custom`, `${hash}:orgB:@acme/custom`]);

  // Verify services/recipe-runtime declares zod explicitly in dependencies.
  const pkg = JSON.parse(readFileSync("services/recipe-runtime/package.json", "utf8")) as { dependencies?: Record<string, string> };
  assert.equal(typeof pkg.dependencies?.zod, "string");
});
