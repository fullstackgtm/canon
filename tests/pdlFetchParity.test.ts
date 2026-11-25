import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("standalone PDL fetchers differ only in credential names and comments", () => {
  const normalize = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")
    .replaceAll("BACKUP_S3_", "R2_").replace(/^\/\/.*\n/gm, "");
  assert.equal(normalize("../services/record-service/src/pdlFetch.ts"), normalize("../services/prospect-index/src/fetch.ts"));
});
