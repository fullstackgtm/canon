import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import nextConfig from "../next.config.ts";

const require = createRequire(import.meta.url);
const { isCsrfOriginAllowed } = require("next/dist/server/app-render/csrf-protection.js");

test("proxied dev auth actions accept only the explicit public hostnames", () => {
  const allowedOrigins = nextConfig.experimental?.serverActions?.allowedOrigins;
  for (const origin of ["dev.canoncrm.com", "dev.fullstackgtm.com"]) {
    assert.equal(isCsrfOriginAllowed(origin, allowedOrigins), true, origin);
  }
  for (const origin of [
    "attacker.example",
    "dev.canoncrm.com.attacker.example",
    "attacker.dev.canoncrm.com",
    "other.canoncrm.com",
    "",
  ]) {
    assert.equal(isCsrfOriginAllowed(origin, allowedOrigins), false, origin);
  }
});
