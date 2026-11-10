import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const shell = readFileSync(new URL("../src/app/dashboard/dashboard-shell.tsx", import.meta.url), "utf8");
const dock = readFileSync(new URL("../src/components/floating-tray-dock.tsx", import.meta.url), "utf8");

test("dashboard scroll viewport ends above the desktop tray, not just its final content", () => {
  const mainClasses = shell.match(/<main className="([^"]+)"/)?.[1].split(" ") ?? [];
  assert.ok(mainClasses.includes("overflow-y-auto"));
  // An external margin keeps even sticky footers and mid-scroll content clear.
  // Padding inside the scroll container only protects its final scroll position.
  const clearance = Number(mainClasses.find((c) => /^md:mb-\d+$/.test(c))?.split("-").at(-1));
  const bottom = Number(dock.match(/\bbottom-(\d+)\b/)?.[1]);
  const launcher = Number(dock.match(/\bsize-(\d+)\b/)?.[1]);
  assert.ok(clearance >= bottom + launcher + 4, "reserve launcher height, bottom offset and a gap outside the scroll viewport");
  assert.ok(!mainClasses.some((c) => /^mb-/.test(c)), "no unused tray strip on mobile");
  assert.match(dock, /max-md:hidden/, "dock and clearance use the same breakpoint");
  assert.match(shell, /flex h-dvh overflow-hidden/, "the viewport bounds the stretched main element");
});
