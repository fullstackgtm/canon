import assert from "node:assert/strict";
import test from "node:test";
import { derivedSecret } from "../convex/lib/runtimeConfig.ts";

test("derived secrets are purpose-bound and need TOKEN_ENCRYPTION_KEY", async () => {
  const previous = process.env.TOKEN_ENCRYPTION_KEY;
  try {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    assert.equal(await derivedSecret("bugdrop-token"), null);
    process.env.TOKEN_ENCRYPTION_KEY = "root-key";
    const token = await derivedSecret("bugdrop-token");
    assert.match(token ?? "", /^[a-f0-9]{64}$/);
    assert.notEqual(token, await derivedSecret("bugdrop-provenance"));
    assert.equal(token, await derivedSecret("bugdrop-token"));
  } finally {
    if (previous === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = previous;
  }
});
