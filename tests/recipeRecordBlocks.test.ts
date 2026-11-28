import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { type RecordBlock, type RecordProps, parseRecordProps } from "../recipes/blocks.ts";
import { apply, describeLayout, type LayoutOp } from "../recipes/md/edit.ts";
import { parseRecipe } from "../recipes/md/parse.ts";
import { forkMarkdown } from "../recipes/workspace.ts";
import { parseManifest, toManifest } from "../recipes/manifest.ts";
import { canChangeRecordPath } from "../recipes/recordPath.ts";
import { recordRelations, relatedCount, relatedListQuery } from "../recipes/recordRelations.ts";
import { resolveObjectDef, STANDARD_OBJECTS } from "../convex/lib/objects/registry.ts";
import { standInWorkflow } from "../convex/lib/workflowStandIn.ts";
import { checkWorkflow } from "../convex/lib/workflowAgent.ts";

const base = readFileSync(new URL("../recipes/canon-base/recipe.md", import.meta.url), "utf8");
const props = {
  highlights: { fields: ["stage", "amount"], actions: ["kernel.archive"] },
  path: { field: "stage", change: true },
  quickLinks: { relationships: ["companyDeals", "dealPeople"] },
  relatedList: { relationship: "companyDeals", columns: ["amount"], limit: 3, sort: { field: "amount", dir: "desc" }, create: true },
} satisfies Record<RecordBlock, RecordProps>;

function edited(markdown: string, op: LayoutOp) {
  const result = apply(markdown, op);
  assert.ok("markdown" in result, JSON.stringify(result));
  return result.markdown;
}

test("record block settings validate types, counts and object-specific action placement", () => {
  assert.throws(() => parseRecordProps("highlights", { fields: Array(8).fill("name") }, "deal"));
  assert.throws(() => parseRecordProps("highlights", { actions: ["kernel.findPhone"] }, "deal"));
  assert.deepEqual(parseRecordProps("highlights", { actions: ["kernel.findPhone"] }, "contact"), { actions: ["kernel.findPhone"] });
  assert.throws(() => parseRecordProps("path", { change: "yes" }, "account"));
  assert.throws(() => parseRecordProps("quickLinks", { relationships: ["<unknown>"] }, "custom"));
  assert.throws(() => parseRecordProps("relatedList", { limit: 101 }, "account"));
});

test("addSection preserves all other bytes and describeLayout round trips block settings", () => {
  const source = base.replaceAll("\n", "\r\n");
  for (const [component, settings] of Object.entries(props) as [RecordBlock, RecordProps][]) {
    const updated = edited(source, { op: "addSection", component, props: settings, object: "deal", title: "Block", before: { component: "header" } });
    const untouched = updated.replace(new RegExp(`## Block \\{section=${component}\\}\\r\\n\\r\\n` + "```props\\r\\n[\\s\\S]*?```\\r\\n\\r\\n"), "");
    assert.equal(untouched, source);
    const layout = describeLayout(updated, "deal");
    assert.ok(!("error" in layout));
    const section = layout.sections.find((section) => section.component === component)!;
    assert.deepEqual(section.props, settings);
    assert.equal(edited(updated, { op: "setProps", section: section.ref, object: "deal", props: section.props! }), updated);
  }
});

test("custom-object layouts use the record grammar and survive manifest validation", () => {
  const object = "custom_subscription";
  let markdown = edited(base, { op: "addPage", slug: object, title: "Subscription", record: true });
  markdown = edited(markdown, { op: "addSection", object, component: "highlights", props: { actions: ["kernel.archive"] }, title: "Subscription", before: null });
  markdown = edited(markdown, { op: "addSection", object, component: "path", props: { field: "custom.status" }, title: "Status", before: null });
  const { recipe } = parseRecipe(forkMarkdown(markdown, { id: "@workspace/subscriptions", title: "Subscriptions", org: "workspace" }));
  assert.deepEqual(recipe.workspacePages?.find((p) => p.slug === object)?.sections.map((s) => s.component), ["highlights", "path"]);
  assert.equal(recipe.workspacePages?.[0].nav, "hidden");
  const manifest = parseManifest(JSON.parse(JSON.stringify(toManifest(recipe))));
  assert.ok(manifest.ok, JSON.stringify(manifest));
});

test("quick link counts cap at 99+ and stage moves require a writable field and another option", () => {
  assert.deepEqual([0, 99, 100, 320].map(relatedCount), ["0", "99", "99+", "99+"]);
  assert.equal(canChangeRecordPath(false, "stage", [], true), false);
  assert.equal(canChangeRecordPath(true, "stage", ["stage"], true), false);
  assert.equal(canChangeRecordPath(true, "stage", [], false), false);
  assert.equal(canChangeRecordPath(true, "stage", [], true), true);
});

test("related reads build the viewer list request from the relationship and current record", () => {
  const custom = { apiName: "custom_subscription", pluralLabel: "Subscriptions", fields: [
    { apiName: "custom.account", type: "lookup", lookupTo: "account" },
    { apiName: "custom.hidden", type: "lookup", lookupTo: "account", hidden: true },
  ] };
  const definitions = [resolveObjectDef(STANDARD_OBJECTS.deal), custom];
  const relations = recordRelations("account", definitions);
  assert.ok(!relations.some((r) => r.id.includes("hidden")));
  const lookup = relations.find((r) => r.object === custom.apiName)!;
  assert.deepEqual(relatedListQuery(lookup, "acc_1", {}), {
    object: custom.apiName, filter: [{ field: "custom.account", op: "eq", value: "acc_1" }],
    columns: ["recordTitle"], sort: undefined, limit: 5,
  });
  const deals = relations.find((r) => r.id === "companyDeals")!;
  assert.equal(relatedListQuery(deals, "acc_1", {}).from, "companyDeals");
});

test("the local Salesforce request produces a checked layout with two columns", () => {
  const input = {
    request: "Make this look like a Salesforce record page",
    pages: [{ target: "deal", recipeId: "canon-base", markdown: base, baseMarkdown: base, layerRevision: 0 }],
    objects: [STANDARD_OBJECTS.deal, STANDARD_OBJECTS.contact, STANDARD_OBJECTS.account].map((def) => resolveObjectDef(def)),
  };
  const proposal = checkWorkflow(input, standInWorkflow(input));
  assert.deepEqual(proposal.dropped, []);
  const layout = describeLayout(proposal.targets[0].markdown, "deal");
  assert.ok(!("error" in layout));
  assert.deepEqual(layout.sections.slice(0, 3).map((s) => s.component), ["highlights", "path", "quickLinks"]);
  const columns = layout.tree.children.find((n) => "kind" in n && n.kind === "columns");
  assert.ok(columns && "kind" in columns);
  assert.deepEqual(columns.children[1], { section: "relatedList#0" });
  assert.ok("kind" in columns.children[0] && columns.children[0].kind === "stack");
});
