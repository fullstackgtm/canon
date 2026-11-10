import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { LEDGER, contrast, themeProblems, themeVars } from "../recipes/theme.ts";

test("globals.css ships exactly the variables Ledger's theme derives, so an unset workspace and a loaded one look the same", () => {
  const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
  const root = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")));
  const shipped = Object.fromEntries([...root.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  const derived = themeVars(LEDGER);
  delete derived["--heading-font"];
  delete derived["--body-font"];
  delete derived["--look"];
  derived["--radius"] = "0.125rem";
  assert.deepEqual(Object.fromEntries(Object.keys(derived).map((k) => [k, shipped[k]])), derived);
});

test("plain type sets the whole app in Times, like a 1990s page", () => {
  const v = themeVars({ ...LEDGER, headings: "plain" });
  assert.match(v["--body-font"], /^"Times New Roman"/);
  assert.equal(v["--heading-font"], v["--body-font"]);
  assert.equal(v["--look"], "plain");
  assert.equal(themeVars(LEDGER)["--look"], "styled");
});

test("a theme that passes its checks keeps every label readable, even on a mid-grey action colour", () => {
  const grey = { ...LEDGER, surface: "#ffffff", ink: "#555555", primary: "#888888" };
  assert.deepEqual(themeProblems(grey), []);
  const v = themeVars(grey);
  assert.ok(contrast(v["--primary-foreground"], v["--primary"]) >= 4.5);
  assert.ok(contrast(v["--muted-foreground"], v["--sidebar"]) >= 4.5);
});
