import assert from "node:assert/strict";
import test from "node:test";
import { functionsDigest, mustPush } from "../scripts/selfhost/functions.mjs";

test("a boot pushes the functions only when the image, backend or pushed environment changed since the last push", () => {
  const env = [{ name: "SITE_URL", value: "http://localhost:3000" }, { name: "CANON_SERVICE_JWT_ISSUER", value: "http://localhost:3000/service" }, { name: "UNSET" }];
  const pushed = functionsDigest({ source: "abc\n", backend: "unknown", env });
  assert.equal(mustPush(pushed, null), true, "a volume with no record of a push (new, or cut off mid-push)");
  assert.equal(mustPush(functionsDigest({ source: "abc", backend: "unknown", env: [...env].reverse() }), pushed), false, "an unchanged restart");
  for (const changed of [
    { source: "abd", backend: "unknown", env },
    { source: "abc", backend: "1.2.3", env },
    { source: "abc", backend: "unknown", env: [{ ...env[0], value: "https://crm.example.com" }, ...env.slice(1)] },
    { source: "abc", backend: "unknown", env: [...env.slice(0, 2), { name: "UNSET", value: "on" }] },
  ]) assert.equal(mustPush(functionsDigest(changed), pushed), true, JSON.stringify(changed));
  assert.equal(mustPush(functionsDigest({ source: null, backend: "unknown", env }), functionsDigest({ source: null, backend: "unknown", env })), true, "an image without a source hash always pushes");
});
