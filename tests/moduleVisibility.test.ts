import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { parseModuleManifest } from "../modules/kernel/manifest.ts";

test("every shipped module chooses a valid source visibility", () => {
  for (const entry of readdirSync("modules/examples", { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    const manifest = JSON.parse(readFileSync(`modules/examples/${entry.name}/module.json`, "utf8"));
    assert.ok(["open", "private"].includes(manifest.visibility), entry.name);
    assert.equal(parseModuleManifest(manifest).ok, true, entry.name);
    assert.equal(parseModuleManifest({ ...manifest, visibility: "public" }).ok, false, entry.name);
  }
});
