import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { RECIPE_FORMAT, RECIPE_GRAMMAR_SHA256 } from "../recipes/kernel.ts";
import { RECIPE_GRAMMAR, parseRecipe } from "../recipes/md/parse.ts";

/** JSON with every map's keys sorted, so the hash moves only when a table does. */
const stable = (x: unknown): string =>
  Array.isArray(x) ? `[${x.map(stable).join(",")}]`
  : x && typeof x === "object" ? `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${stable((x as Record<string, unknown>)[k])}`).join(",")}}`
  : JSON.stringify(x);

test("a recipe for another format gets one line naming both formats, and the grammar can't change without the format's record of it", () => {
  const velocity = readFileSync("recipes/fsgtm-velocity-deal/recipe.md", "utf8");
  for (const other of ["2", "4"]) {
    const { problems } = parseRecipe(velocity.replace(`engines: { canon: "${RECIPE_FORMAT}" }`, `engines: { canon: "${other}" }`));
    assert.deepEqual(problems.map((p) => [p.line, p.level, p.message.startsWith(`written for customization format ${other}; this Canon reads format ${RECIPE_FORMAT}`)]), [[7, "error", true]]);
  }

  const hash = createHash("sha256").update(stable(RECIPE_GRAMMAR)).digest("hex");
  assert.equal(hash, RECIPE_GRAMMAR_SHA256,
    `The recipe grammar changed (sha256 ${hash}). If a recipe the old grammar read now fails, bump RECIPE_FORMAT and add a "Format changelog" entry in docs/recipes.md. Then set RECIPE_GRAMMAR_SHA256 in recipes/kernel.ts to this hash.`);
});
