import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { apply, describeLayout, type LayoutOp } from "../recipes/md/edit.ts";
import { parseRecipe } from "../recipes/md/parse.ts";
import { parseLayout, printLayout } from "../recipes/layout.ts";
import { contrast, pageAccentVars } from "../recipes/theme.ts";
import { loadConvex } from "./convexHandlers.ts";
const standInColumns = loadConvex(["lib/recipeAgentStandIn.ts"])["lib/recipeAgentStandIn.ts"].standInColumns as unknown as typeof import("../convex/lib/recipeAgentStandIn.ts").standInColumns;

const base = readFileSync("recipes/canon-base/recipe.md", "utf8");
const edit = (md: string, op: LayoutOp) => {
  const out = apply(md, op);
  assert.ok("markdown" in out, JSON.stringify(out));
  return out.markdown;
};
const layout = (md: string) => {
  const out = describeLayout(md, "account");
  assert.ok(!("error" in out));
  return out;
};
const wrap: LayoutOp = { op: "wrapSections", object: "account", sections: [{ component: "timeline" }, { component: "history" }], kind: "columns", id: "activity" };

test("format-3 recipes retain the entire compiled output captured before WC2", () => {
  const hashes: Record<string, string> = {
  "canon-base": "63897596bb57d3e0b5d3415469b3bdcb415a4ddcc925508eea5b8d8be94ec965",
  "canon-ledger": "b6b38d0d01fb242ce0527755dbf4d76e0e4ceb15c2c30ae5b9d1bf1c39f3dfc5",
  "canon-plain-html": "1e2a1ce08d9a4da80c781d4ccc7633eb9884ee7e80461e38685c9d1add97a55d",
  "fsgtm-enterprise-deal": "8da8013944845320ed775236709c7a9b7df0a14e69c499468030f6f00f4e11c3",
  "fsgtm-velocity-deal": "8b9f68dcfcd8052287ca07bf37ddd0795bb29fd5ce1df88793f2a980563dfc91"
};
  for (const [dir, expected] of Object.entries(hashes)) {
    const parsed = parseRecipe(readFileSync(`recipes/${dir}/recipe.md`, "utf8"));
    assert.equal(createHash("sha256").update(JSON.stringify(parsed)).digest("hex"), expected, dir);
  }
});

test("layout text round trips and rejects duplicate leaves, invalid props and indentation", () => {
  const text = 'stack root\n  columns overview {"widths":[2,1]}\n    section header#0\n    card context {"title":"Context"}\n      section timeline#0';
  assert.equal(printLayout(parseLayout(text, ["header#0", "timeline#0"])), text);
  for (const invalid of [text.replace("timeline#0", "header#0"), text.replace('[2,1]', '[2]'), text.replace('    card', '     card'), text.replace('"widths":[2,1]', '"children":[]')]) assert.throws(() => parseLayout(invalid, ["header#0", "timeline#0"]));
});

const style = { density: "compact", surface: "bordered", headerBand: "tinted", accent: "#0176d3" } as const;

test("page and container styles round trip through the layout grammar", () => {
  const text = [
    `stack root ${JSON.stringify({ style })}`,
    '  columns overview {"widths":[2,1],"gap":"tight"}',
    '    section header#0',
    '    tabs context {"labels":["Timeline","History"],"variant":"underline"}',
    '      card activity {"title":"Activity","icon":"clipboard","tone":"accent","collapsible":true}',
    '        section timeline#0',
    '      section history#0',
  ].join("\n");
  const keys = ["header#0", "timeline#0", "history#0"];
  assert.equal(printLayout(parseLayout(text, keys)), text);
  for (const invalid of [
    text.replace("#0176d3", "#eeeeee"),
    text.replace("#0176d3", "url(example)"),
    text.replace('"compact"', '"huge"'),
    text.replace('"bordered"', '"transparent"'),
    text.replace('"tinted"', '"solid"'),
    text.replace('"tight"', '"12px"'),
    text.replace('"underline"', '"flat"'),
    text.replace('"clipboard"', '"arbitrary"'),
    text.replace('"accent","collapsible"', '"wild","collapsible"'),
    text.replace('"collapsible":true', '"collapsible":"true"'),
    text.replace(/^      card activity.*$/m, '      stack activity {"style":{}}'),
  ]) assert.throws(() => parseLayout(invalid, keys));
  const vars = pageAccentVars(style.accent)!;
  assert.equal(vars["--primary"], style.accent);
  assert.ok(contrast(vars["--primary"], vars["--primary-foreground"]) >= 4.5);
  assert.equal(pageAccentVars("#eeeeee"), undefined);
});

test("setPageStyle changes only the root line and keeps implicit layout implicit", () => {
  const op = { op: "setPageStyle", object: "account", style } as const;
  const plain = base.replaceAll("\n", "\r\n");
  const styled = edit(plain, op);
  const root = `stack root ${JSON.stringify({ style })}`;
  assert.equal(styled.replace(`\`\`\`layout\r\n${root}\r\n\`\`\`\r\n\r\n`, ""), plain);
  assert.deepEqual(parseRecipe(styled).recipe.layouts?.account, { kind: "stack", id: "root", style, children: [] });
  assert.deepEqual(layout(styled).style, style);
  const grouped = edit(base, wrap).replace("stack root\n", "stack root\n\n");
  assert.equal(edit(grouped, op), grouped.replace("stack root\n", `${root}\n`));
  assert.equal(edit(styled, op), styled);
  const cleared = edit(styled, { ...op, style: {} });
  assert.deepEqual(layout(cleared).style, {});
  assert.ok("error" in apply(styled, { ...op, style: { accent: "#ffffff" } }));
});

test("tree operations preserve surrounding bytes and refuse edits that cannot express the exact tree", () => {
  const grouped = edit(base, wrap);
  assert.equal(grouped.replace(/```layout\n[\s\S]*?```\n\n/, ""), base);
  assert.equal(parseRecipe(grouped).recipe.layouts?.account?.children.filter((n) => !("section" in n)).length, 1);
  const sized = edit(grouped, { op: "setContainerProps", object: "account", container: "activity", props: { widths: [2, 1] } });
  assert.match(sized, /"widths":\[2,1\]/);
  const gapOp = { op: "setContainerProps", object: "account", container: "activity", props: { gap: "tight" } } as const;
  const tightened = edit(sized, gapOp);
  assert.equal(tightened, sized.replace('"widths":[2,1]', '"widths":[2,1],"gap":"tight"'));
  assert.equal(edit(tightened, { ...gapOp, props: { gap: null } }), sized);
  const added = edit(sized, { op: "addSection", object: "account", component: "fields", title: "Notes", fields: ["customNote"], before: { component: "header" } });
  assert.match(added, /columns activity {"widths":\[2,1\]}/);
  const first = layout(added).tree.children[0];
  assert.equal("section" in first ? first.section : null, "fields#0");
  const removed = edit(sized, { op: "removeSection", object: "account", section: { component: "history" } });
  assert.doesNotMatch(removed, /columns activity/);
  const moved = edit(sized, { op: "moveSection", object: "account", section: { component: "history" }, before: { component: "timeline" } });
  assert.match(moved, /section history#0\n    section timeline#0/);
  assert.deepEqual(parseRecipe(moved).recipe.accountPage, parseRecipe(base).recipe.accountPage);
  const unwrapped = edit(moved, { op: "unwrap", object: "account", container: "activity" });
  const nested = edit(unwrapped, { op: "wrapSections", object: "account", sections: [{ component: "timeline" }, { component: "history" }], kind: "card", id: "card", props: { title: "Activity" } });
  const into = edit(nested, { op: "moveIntoContainer", object: "account", section: { component: "related" }, container: "card", before: null });
  assert.match(into, /    section related#0/);
  const tabs = edit(base, { ...wrap, kind: "tabs", props: { labels: ["Timeline", "History"] } });
  assert.match(tabs, /tabs activity/);
  const folded = edit(grouped, { op: "setCollapsed", object: "account", section: { component: "timeline" }, collapsed: true });
  assert.match(folded, /section=timeline collapsed=true/);
  for (const op of [
    { ...wrap, sections: [{ component: "timeline" }] },
    { op: "unwrap", object: "account", container: "root" },
    { op: "setContainerProps", object: "account", container: "activity", props: { widths: [1] } },
    { op: "moveIntoContainer", object: "account", section: { component: "related" }, container: "absent", before: null },
    { op: "moveSection", object: "account", section: { component: "timeline" }, before: { component: "header" } },
  ] as LayoutOp[]) assert.ok("error" in apply(grouped, op));
  const tree = layout(grouped).tree;
  assert.equal(tree.children.length, parseRecipe(base).recipe.accountPage.length - 1);
  assert.ok(parseRecipe(grouped.replace(/```layout\n[\s\S]*?```/, '$&\n\n```layout\nstack second\n  section header#0\n```')).problems.some((p) => p.level === "error"));
});

test("local pencil requests generate checked columns ops", () => {
  const ops = standInColumns(layout(base), { component: "timeline" }, "put this next to History");
  assert.equal(ops.length, 1);
  assert.match(edit(base, ops[0]), /columns columns/);
});
