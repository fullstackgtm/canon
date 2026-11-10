import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
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

test("without SITE_URL the container takes its public address from the hosting platform", async () => {
  const { platformSiteUrl } = await import("../scripts/selfhost/platform.mjs");
  assert.equal(platformSiteUrl({ RENDER_EXTERNAL_URL: "https://canon-x1.onrender.com/" }), "https://canon-x1.onrender.com");
  assert.equal(platformSiteUrl({ RAILWAY_PUBLIC_DOMAIN: "canon-production.up.railway.app" }), "https://canon-production.up.railway.app");
  assert.equal(platformSiteUrl({}), null);
});

test("the container starts the Next server its image keeps, and gives the first push time on a slow host", () => {
  const dockerfile = readFileSync("Dockerfile.selfhost", "utf8");
  const entrypoint = readFileSync("scripts/selfhost/entrypoint.mjs", "utf8");
  assert.doesNotMatch(dockerfile, /rm -rf[^\n&]*\.next\/standalone(?:\s|&|$)/, "the build keeps .next/standalone/server.js");
  assert.match(dockerfile, /ln -s \.\.\/\.\.\/static \.next\/standalone\/\.next\/static/, "the standalone server finds the static files");
  assert.match(entrypoint, /daemon\("Next", process\.execPath, \["\.next\/standalone\/server\.js"\]/);
  for (const [knob, floor] of [["ISOLATE_ANALYZE_USER_TIMEOUT_SECONDS", 4], ["DATABASE_UDF_USER_TIMEOUT_SECONDS", 1]] as const) {
    const value = new RegExp(`${knob} \\|\\|= "(\\d+)"`).exec(entrypoint);
    assert.ok(value && Number(value[1]) > floor, `${knob} is raised above the backend's ${floor} s default`);
  }
});
