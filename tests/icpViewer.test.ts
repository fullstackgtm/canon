import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { buildSync } from "esbuild";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { IcpViewerProps } from "../src/components/icps/icp-viewer.tsx";

const require = createRequire(import.meta.url);
const built = buildSync({ entryPoints: ["src/components/icps/icp-viewer.tsx"], bundle: true, write: false, format: "cjs", platform: "neutral", external: ["react", "react/jsx-runtime"] });
const compiled = { exports: {} as { IcpViewer: ComponentType<IcpViewerProps> } };
runInNewContext(built.outputFiles[0].text, { module: compiled, exports: compiled.exports, require });
const query = 'industry:online-audio-and-video-media size:501-1000 country:us has(level:vp dept:marketing,media title:"VP Marketing") -has(title:intern)';

test("the shared viewer groups company filters and personas and keeps raw query opt-in", () => {
  const render = (props: Partial<IcpViewerProps> = {}) => renderToStaticMarkup(createElement(compiled.exports.IcpViewer, { query, kind: "segment", ...props }));
  const html = render({ children: createElement(compiled.exports.IcpViewer, { query: "level:manager", kind: "persona", name: "Champions" }) });
  for (const label of ["Online Audio and Video Media", "501–1,000 employees", "🇺🇸 United States", "Seniority", "Departments", "Marketing", "Media", "Titles", "VP Marketing", "Without these people", "Champions", "Manager"]) assert.ok(html.includes(label), label);
  assert.ok(!html.includes("industry:"));
  assert.ok(!html.includes("<details"));
  const admin = render({ showQuery: true });
  assert.ok(admin.includes("<details"));
  assert.ok(!admin.includes("<details open"));
  assert.ok(admin.includes("industry:"));
  const invalid = render({ query: "unknown:value country:ca" });
  assert.ok(invalid.includes("Canada"));
  assert.ok(invalid.includes("Some saved conditions need review."));
  assert.ok(!invalid.includes("unknown:value"));
});
