import assert from "node:assert/strict";
import test from "node:test";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const M = loadConvex(["stripe.ts", "lib/tokenHelpers.ts"]);
const helpers = M["lib/tokenHelpers.ts"] as unknown as Record<"encryptForStorage" | "decryptFromStorage", (s: string) => Promise<string>>;
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

async function withKey<T>(key: string | undefined, run: () => Promise<T>): Promise<T> {
  const saved = process.env.TOKEN_ENCRYPTION_KEY;
  if (key === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
  else process.env.TOKEN_ENCRYPTION_KEY = key;
  try { return await run(); } finally {
    if (saved === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = saved;
  }
}

test("a provider key is never stored readable: without TOKEN_ENCRYPTION_KEY it is refused", async () => {
  const db = memoryDb({});
  const save = () => M["stripe.ts"].store.handler({ db }, { orgId: "organizations:o", userId: "users:u", secretKey: "provider-api-key-1" });
  await withKey(undefined, async () => {
    await assert.rejects(save(), /TOKEN_ENCRYPTION_KEY/);
    assert.equal(await helpers.encryptForStorage(""), "", "clearing a credential needs no key");
  });
  assert.equal(JSON.stringify(db.rows("integrations")).includes("provider-api-key-1"), false);
  await withKey(KEY, async () => {
    await save();
    const [row] = db.rows("integrations");
    assert.equal(JSON.stringify(row).includes("provider-api-key-1"), false);
    assert.equal(await helpers.decryptFromStorage(row!.accessToken as string), "provider-api-key-1");
    // A value written in plain text before keys were required still reads, and the next save encrypts it.
    assert.equal(await helpers.decryptFromStorage("provider-api-key-written-before-the-fix"), "provider-api-key-written-before-the-fix");
  });
});
