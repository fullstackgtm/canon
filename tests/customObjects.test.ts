// Custom objects (CP7d, convex/lib/objects/customObjects.ts): how an object
// is made, resolved, renamed and archived, and how a CSV maps onto its fields.
import assert from "node:assert/strict";
import test from "node:test";
import { editObject, newObject, setObjectArchived } from "../convex/lib/objects/customObjects.ts";
import { planCustomCsv } from "../convex/lib/objects/customCsv.ts";
import { addField, archiveField } from "../convex/lib/objects/fieldBuilder.ts";
import { coerce, resolveOrgObject } from "../convex/lib/objects/registry.ts";
import { NAV_SECTIONS, withRecordObjects } from "../src/components/shell/nav.ts";

const made = () => newObject({ label: "Project", pluralLabel: "Projects", icon: "briefcase", titleLabel: "Project name" }, []);

test("a custom object resolves like a standard one: stable custom_<slug> id, its own name field, a field added by the builder", () => {
  const { apiName, ext } = made();
  assert.equal(apiName, "custom_project");
  const withStatus = addField(apiName, ext, { label: "Status", type: "picklist", options: [{ label: "Planned" }, { label: "Active" }] }).ext;
  const def = resolveOrgObject(apiName, withStatus)!;
  assert.deepEqual([def.kind, def.label, def.pluralLabel, def.icon, def.titleFieldId], ["custom", "Project", "Projects", "briefcase", "custom.name"]);
  assert.deepEqual(def.fields.map((f) => f.apiName), ["ownerId", "createdAt", "updatedAt", "custom.name", "custom.status"]);
  // The name is required, and the registry checks a picklist value as it does anywhere else.
  assert.equal(coerce(def, { "custom.status": "planned" }, { mode: "create" }).ok, false);
  assert.equal(coerce(def, { "custom.name": "Relaunch", "custom.status": "planned" }, { mode: "create" }).ok, true);
  // No row, no object; a name that is not custom_<slug> is not one either.
  assert.equal(resolveOrgObject("custom_missing", undefined), null);
  assert.equal(resolveOrgObject("custom.name", withStatus), null);
});

test("a rename changes labels only, a second Project is refused and gets no id of its own, and the name field cannot be archived", () => {
  const { apiName, ext } = made();
  const renamed = editObject(apiName, ext, { label: "Engagement", pluralLabel: "Engagements" }, [{ apiName, label: "Project", pluralLabel: "Projects" }]);
  assert.deepEqual([renamed.object!.label, renamed.registryVersion], ["Engagement", 2]);
  assert.equal(resolveOrgObject(apiName, renamed)!.apiName, "custom_project");
  assert.throws(() => newObject({ label: "project", pluralLabel: "Work", icon: "box", titleLabel: "Name" }, [{ apiName, label: "Project", pluralLabel: "Projects" }]));
  assert.throws(() => newObject({ label: "Deal", pluralLabel: "Things", icon: "box", titleLabel: "Name" }, []), /already an object named Deal/);
  // An archived object frees its names but keeps its id: the next Project is custom_project_2.
  const archived = { apiName, label: "Project", pluralLabel: "Projects", archivedAt: 5 };
  assert.equal(newObject({ label: "Project", pluralLabel: "Projects", icon: "box", titleLabel: "Name" }, [archived]).apiName, "custom_project_2");
  assert.throws(() => archiveField(apiName, ext, "custom.name", 1), /cannot be archived/);
  const off = setObjectArchived(ext, true, 99, [], apiName);
  assert.equal(resolveOrgObject(apiName, off)!.archivedAt, 99);
  assert.equal(resolveOrgObject(apiName, setObjectArchived(off, false, 100, [], apiName))!.archivedAt, undefined);
});

test("a CSV maps columns by field name, picklist cells by label, and ignores what it does not know", () => {
  const { apiName, ext } = made();
  const def = resolveOrgObject(apiName, addField(apiName, ext, { label: "Status", type: "picklist", options: [{ label: "Planned" }, { label: "Active" }] }).ext)!;
  const plan = planCustomCsv(def.fields as never, "project name,STATUS,Notes\nRelaunch,Active,x\n,,\nMigration,,y\n");
  assert.deepEqual(plan.rows, [
    { row: 2, values: { "custom.name": "Relaunch", "custom.status": "active" } },
    { row: 4, values: { "custom.name": "Migration" } },
  ]);
  assert.deepEqual(plan.ignored, ["Notes"]);
});

test("the nav lists live custom objects in a Records group before Admin", () => {
  const sections = withRecordObjects(NAV_SECTIONS, [
    { apiName: "custom_project", pluralLabel: "Projects", icon: "briefcase", archived: false },
    { apiName: "custom_old", pluralLabel: "Olds", icon: "box", archived: true },
  ]);
  const records = sections.find((section) => section.label === "Records");
  assert.ok(records);
  assert.equal(sections[sections.indexOf(records) + 1].label, "Admin");
  assert.deepEqual(records.items.map((item) => [item.label, item.href]), [["Projects", "/dashboard/records/custom_project"]]);
  assert.equal(withRecordObjects(NAV_SECTIONS, []), NAV_SECTIONS);
});
