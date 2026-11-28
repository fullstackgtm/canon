import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { type RecordBlock, type RecordProps, parseRecordProps } from "../recipes/blocks.ts";
import { apply, describeLayout, type LayoutOp } from "../recipes/md/edit.ts";
import { parseRecipe } from "../recipes/md/parse.ts";
import { forkMarkdown } from "../recipes/workspace.ts";
import { parseManifest, toManifest } from "../recipes/manifest.ts";
import { canEditRecordField, visibleRecordFields } from "../recipes/recordFields.ts";
import { splitRecordActions } from "../recipes/recordActionBar.ts";
import { RECORD_MARKDOWN_MAX, recordTextSpans } from "../recipes/recordText.ts";
import { canChangeRecordPath } from "../recipes/recordPath.ts";
import { activityComposerOffers, activityTimeline, type ActivityItem } from "../recipes/recordActivity.ts";
import { parentRecordRelations, recordRelations, relatedCount, relatedListQuery } from "../recipes/recordRelations.ts";
import { resolveObjectDef, STANDARD_OBJECTS } from "../convex/lib/objects/registry.ts";
import { standInWorkflow } from "../convex/lib/workflowStandIn.ts";
import { checkWorkflow } from "../convex/lib/workflowAgent.ts";

const base = readFileSync(new URL("../recipes/canon-base/recipe.md", import.meta.url), "utf8");
const props = {
  highlights: { fields: ["stage", "amount"], actions: ["kernel.archive"] },
  path: { field: "stage", change: true },
  quickLinks: { relationships: ["companyDeals", "dealPeople"] },
  relatedList: { relationship: "companyDeals", columns: ["amount"], limit: 3, sort: { field: "amount", dir: "desc" }, create: true },
  fieldSection: { title: "Opportunity information", fields: ["name", "stage"], columns: 2, collapsible: true, collapsed: false },
  relatedRecord: { relationship: "dealCompany", fields: ["name", "domain"], title: "Account details" },
  actionBar: { actions: ["kernel.archive", "kernel.restore"] },
  richText: { markdown: "### Next steps\n\n- **Review** the [account](https://example.com) with *Sales*." },
  activity: { composer: ["note", "task", "call"], filter: { kinds: ["task", "call"], range: "all", mine: true }, group: "upcomingOverdue", limit: 3 },
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
  assert.throws(() => parseRecordProps("fieldSection", { ...props.fieldSection, columns: 3 }, "deal"));
  assert.throws(() => parseRecordProps("relatedRecord", { ...props.relatedRecord, fields: [] }, "deal"));
  assert.throws(() => parseRecordProps("actionBar", { actions: ["kernel.findEmail"] }, "deal"));
  assert.deepEqual(parseRecordProps("actionBar", { actions: ["kernel.findEmail"] }, "contact"), { actions: ["kernel.findEmail"] });
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
  for (const component of ["fieldSection", "relatedRecord", "actionBar", "richText", "activity"] as const) {
    markdown = edited(markdown, { op: "addSection", object, component, props: props[component], title: component, before: null });
  }
  const { recipe } = parseRecipe(forkMarkdown(markdown, { id: "@workspace/subscriptions", title: "Subscriptions", org: "workspace" }));
  assert.deepEqual(recipe.workspacePages?.find((p) => p.slug === object)?.sections.map((s) => s.component), ["highlights", "path", "fieldSection", "relatedRecord", "actionBar", "richText", "activity"]);
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

test("the local Salesforce request builds the styled record layout and only updates style on repeat", () => {
  const input = {
    request: "Make this look like a Salesforce record page",
    pages: [{ target: "deal", recipeId: "canon-base", markdown: base, baseMarkdown: base, layerRevision: 0 }],
    objects: [STANDARD_OBJECTS.deal, STANDARD_OBJECTS.contact, STANDARD_OBJECTS.account].map((def) => resolveObjectDef(def)),
  };
  const proposal = checkWorkflow(input, standInWorkflow(input));
  assert.deepEqual(proposal.dropped, []);
  const { markdown } = proposal.targets[0];
  const layout = describeLayout(markdown, "deal");
  assert.ok(!("error" in layout));
  const style = { density: "compact", surface: "bordered", headerBand: "tinted", accent: "#0176d3" };
  assert.deepEqual(layout.style, style);
  assert.deepEqual(layout.sections.slice(0, 4).map((s) => s.component), ["highlights", "actionBar", "path", "quickLinks"]);
  assert.equal(layout.sections.find((s) => s.component === "fieldSection")?.title, "Opportunity information");
  assert.equal(layout.sections.find((s) => s.component === "relatedRecord")?.title, "Account details");
  const columns = layout.tree.children.find((n) => "kind" in n && n.kind === "columns");
  assert.ok(columns && "kind" in columns);
  assert.deepEqual(columns.widths, [2, 1]);
  assert.equal(columns.gap, "tight");
  const [left, right] = columns.children;
  assert.ok("kind" in left && left.kind === "stack");
  const [tabs] = left.children;
  assert.ok("kind" in tabs && tabs.kind === "tabs");
  assert.deepEqual(tabs.labels, ["Details", "Activity"]);
  assert.deepEqual(tabs.children[1], { section: "activity#0" });
  assert.deepEqual(layout.sections.find((s) => s.component === "activity")?.props, { composer: ["note", "task", "call"], group: "upcomingOverdue" });
  assert.equal(layout.sections.some((s) => s.component === "timeline"), false);
  assert.ok("kind" in right && right.kind === "stack");
  assert.deepEqual(right.children, [{ section: "relatedRecord#0" }, { section: "relatedList#0" }]);

  const restyled = edited(markdown, { op: "setPageStyle", object: "deal", style: { density: "comfortable" } });
  const repeat = (text: string) => standInWorkflow({ ...input, pages: [{ ...input.pages[0], markdown: text }] });
  assert.deepEqual(repeat(restyled).ops, { deal: [{ op: "setPageStyle", object: "deal", style }] });
  assert.deepEqual(repeat(markdown).ops, {});
});

test("activity props reject unknown settings and unsupported composer kinds", () => {
  assert.deepEqual(parseRecordProps("activity", undefined, "deal"), {});
  assert.deepEqual(parseRecordProps("activity", { composer: ["email"], filter: { kinds: ["custom"], range: "past", mine: false }, group: "day", limit: 5 }, "contact"),
    { composer: ["email"], filter: { kinds: ["custom"], range: "past", mine: false }, group: "day", limit: 5 });
  for (const object of ["deal", "account", "custom"] as const) {
    assert.throws(() => parseRecordProps("activity", { composer: ["email"] }, object));
  }
  for (const bad of [{ composer: ["sms"] }, { filter: { range: "today" } }, { filter: { mine: "yes" } }, { group: "week" }, { limit: 0 }]) {
    assert.throws(() => parseRecordProps("activity", bad, "contact"));
  }
});

test("the activity composer uses kernel offers for the current object and edit permission", () => {
  const enabled = { canEdit: true, deleted: false, "contact.email": true, "gmail.linked": true };
  const summarize = (offers: ReturnType<typeof activityComposerOffers>) => offers.map(({ kind, action, disabled }) => [kind, action.runs, disabled]);
  assert.deepEqual(summarize(activityComposerOffers("deal", ["email", "task"], undefined, enabled)), [["task", "kernel.logActivity", false]]);
  assert.deepEqual(summarize(activityComposerOffers("custom", ["call"], undefined, { ...enabled, canEdit: false })), [["call", "kernel.logActivity", true]]);
  assert.deepEqual(summarize(activityComposerOffers("contact", ["email"], undefined, enabled)), [["email", "kernel.saveGmailDraft", false]]);
  assert.deepEqual(summarize(activityComposerOffers("contact", ["email"], undefined, { ...enabled, "gmail.linked": false })), [["email", "kernel.saveGmailDraft", true]]);
  assert.deepEqual(summarize(activityComposerOffers("contact", ["note", "email"], undefined, { ...enabled, canEdit: false })),
    [["note", "kernel.logActivity", true], ["email", "kernel.saveGmailDraft", true]]);
  assert.deepEqual(activityComposerOffers("account", [], undefined, enabled), []);
  assert.deepEqual(activityComposerOffers("account", undefined, undefined, enabled).map(({ kind }) => kind), ["note", "task", "call", "meeting"]);
});

test("activity filters combine kind, owner and range before grouping", () => {
  const at = (day: string) => Date.parse(`${day}T12:00:00`);
  const now = at("2026-11-28");
  const items: ActivityItem[] = [
    { id: "call", kind: "call", subject: "Talked", at: at("2026-11-27"), ownerId: "me", outcome: null },
    { id: "task", kind: "task", subject: "Follow up", at: at("2026-11-25"), ownerId: "me", dueDate: "2026-11-26", status: "not_started" },
    { id: "done", kind: "task", subject: "Sent notes", at: at("2026-11-27"), ownerId: "me", dueDate: "2026-12-01", status: "completed" },
    { id: "meeting", kind: "meeting", title: "Next meeting", at: at("2026-12-01"), ownerId: "them", startAt: at("2026-12-01") },
  ];
  const summarize = (groups: ReturnType<typeof activityTimeline>) => groups.map(({ label, rows }) => [label, rows.map(({ item }) => "id" in item ? item.id : item.key)]);
  assert.deepEqual(summarize(activityTimeline(items, {}, "upcomingOverdue", now)), [
    ["Upcoming & Overdue", ["task", "meeting"]], ["Past activity", ["call", "done"]],
  ]);
  assert.deepEqual(summarize(activityTimeline(items, { kinds: ["task"], mine: true, range: "upcoming" }, "none", now, "me")), [["", ["task"]]]);
  assert.deepEqual(activityTimeline(items, { range: "past", mine: true }, "day", now, "me").map(({ rows }) => rows.length), [2]);
  assert.deepEqual(activityTimeline(items, { mine: true }, "day", now), []);
});

test("field section edits require permission, compare-and-set and a writable field", () => {
  const field = { apiName: "stage", fieldId: "stage" };
  assert.equal(canEditRecordField(true, true, field, []), true);
  assert.equal(canEditRecordField(true, true, field, ["stage"]), false);
  assert.equal(canEditRecordField(false, true, field, []), false);
  assert.equal(canEditRecordField(true, false, field, []), false);
});

test("related record relationships and fields omit hidden metadata", () => {
  const visible = { apiName: "name", fieldId: "name", type: "text" };
  const hidden = { apiName: "secret", fieldId: "c_secret", type: "text", hidden: true };
  const account = { apiName: "account", pluralLabel: "Accounts", fields: [visible, hidden] };
  const custom = { apiName: "custom_subscription", pluralLabel: "Subscriptions", fields: [
    { apiName: "custom.company", fieldId: "c_company", type: "lookup", lookupTo: "account" },
    { apiName: "custom.secret", fieldId: "c_secret", type: "lookup", lookupTo: "account", hidden: true },
  ] };
  assert.deepEqual(parentRecordRelations(custom.apiName, [account, custom]).map((relation) => relation.id), ["custom.company"]);
  assert.deepEqual(visibleRecordFields(account.fields, ["name", "secret", "c_secret"]), [visible]);
});

test("rich text rejects unsafe links and oversized input", () => {
  const markdown = "[Click](javascript:alert(1))";
  assert.throws(() => parseRecordProps("richText", { markdown }, "deal"));
  assert.throws(() => parseRecordProps("richText", { markdown: "x".repeat(RECORD_MARKDOWN_MAX + 1) }, "deal"));
  assert.ok(recordTextSpans(markdown).every(({ href }) => !href));
  assert.deepEqual(recordTextSpans("[Account](https://example.com)"), [{ text: "Account", href: "https://example.com/" }]);
});

test("action bar splits visible controls after the sixth button in recipe order", () => {
  assert.deepEqual(splitRecordActions([1, 2, 3, 4, 5, 6, 7, 8]), { buttons: [1, 2, 3, 4, 5, 6], overflow: [7, 8] });
  assert.deepEqual(splitRecordActions([1]), { buttons: [1], overflow: [] });
});
