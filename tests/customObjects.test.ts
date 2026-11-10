// Custom objects (CP7d, convex/lib/objects/customObjects.ts): how an object
// is made, resolved, renamed and archived, and how a CSV maps onto its fields.
import assert from "node:assert/strict";
import test from "node:test";
import { editObject, newObject, setObjectArchived } from "../convex/lib/objects/customObjects.ts";
import { planCustomCsv, resolveCustomCsv } from "../convex/lib/objects/customCsv.ts";
import { addField, archiveField } from "../convex/lib/objects/fieldBuilder.ts";
import { coerce, resolveOrgObject } from "../convex/lib/objects/registry.ts";
import { NAV_SECTIONS, withRecordObjects } from "../src/components/shell/nav.ts";
import { listCsv } from "../src/lib/list-csv.ts";

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
    { row: 2, values: { "custom.name": "Relaunch", "custom.status": "active" }, refs: [] },
    { row: 4, values: { "custom.name": "Migration" }, refs: [] },
  ]);
  assert.deepEqual(plan.ignored, ["Notes"]);
});

test("a custom object's CSV export imports back as the values it held, for every field type", () => {
  const { apiName, ext: base } = made();
  let ext = base;
  for (const spec of [
    { label: "Budget", type: "currency" }, { label: "Seats", type: "number" }, { label: "Due", type: "date" }, { label: "Signed", type: "checkbox" },
    { label: "Stage", type: "picklist", options: [{ label: "Planned" }, { label: "Active" }] }, { label: "Tags", type: "multipicklist", options: [{ label: "Red" }, { label: "Blue" }] },
    { label: "Client", type: "lookup", lookupTo: "account" }, { label: "Sponsor", type: "user" }, { label: "Notes", type: "text" },
    { label: "Inboxes", type: "emails" }, { label: "Lines", type: "phones" }, { label: "Sites", type: "links" },
  ] as const) ext = addField(apiName, ext, spec).ext;
  // The builder offers no date and time yet; the type is stored all the same.
  ext = { ...ext, customFields: [...ext.customFields, { fieldId: "custom.kickoff" as never, apiName: "custom.kickoff", label: "Kickoff", type: "datetime" }] };
  const def = resolveOrgObject(apiName, ext)!;
  const input = {
    "custom.name": "Relaunch", ownerId: "u1", "custom.budget": 2400050, "custom.seats": 12, "custom.due": "2026-12-01", "custom.signed": true,
    "custom.stage": "active", "custom.tags": ["blue", "red"], "custom.client": "acc_1", "custom.sponsor": "u2", "custom.notes": "=1+1, then \"quotes\"\nand a line",
    "custom.inboxes": ["a@acme.com", "b@acme.com"], "custom.lines": ["+1 555 010 0000"], "custom.sites": ["https://acme.com"], "custom.kickoff": Date.UTC(2026, 11, 1, 15, 30),
  };
  const stored = coerce(def, input, { mode: "create" });
  assert.ok(stored.ok);
  const values = Object.fromEntries(stored.values.map((c) => [c.fieldId, c.value]));
  const csv = listCsv({
    fields: def.fields as never, titleLabel: "Project name", columns: def.fields.filter((f) => !f.system).map((f) => f.apiName),
    rows: [{ id: "rec_1", title: "Relaunch", createdAt: 0, updatedAt: 0, values }],
    users: new Map([["u1", "Ann Lee"], ["u2", "Bo Diaz"]]), titles: { acc_1: "Acme" },
  });
  const members = [{ id: "u1", name: "Ann Lee", email: "ann@acme.com", active: true }, { id: "u2", name: "Bo Diaz", active: true }];
  const plan = planCustomCsv(def.fields, csv);
  // Into a workspace where the account has another id: its title finds it.
  for (const client of [{ id: "acc_1", title: "Acme" }, { id: "acc_9", title: "Acme" }]) {
    const resolved = resolveCustomCsv(plan, members, new Map([["account", { ids: new Set([client.id]), titles: new Map([[client.title, [client.id]]]) }]]));
    assert.deepEqual(resolved.problems, []);
    const back = coerce(def, resolved.rows[0].values, { mode: "create" });
    assert.ok(back.ok, JSON.stringify(!back.ok && back.errors));
    assert.deepEqual(Object.fromEntries(back.values.map((c) => [c.fieldId, c.value])), { ...values, "custom.client": client.id });
  }
});

test("a CSV owner or lookup that names no one, or several, fails its row instead of storing the text", () => {
  const { apiName, ext } = made();
  const def = resolveOrgObject(apiName, addField(apiName, ext, { label: "Client", type: "lookup", lookupTo: "account" }).ext)!;
  const plan = planCustomCsv(def.fields, "Project name,Owner,Client\nA,Nobody,Acme\nB,Ann,Twin\nC,ann@acme.com,Acme\n");
  const targets = new Map([["account", { ids: new Set(["acc_1", "acc_2", "acc_3"]), titles: new Map([["Acme", ["acc_1"]], ["Twin", ["acc_2", "acc_3"]]]) }]]);
  const ann = { id: "u1", name: "Ann", email: "ann@acme.com", active: true };
  // Ann read twice, by her email and by a scan of names, is still one member.
  const out = resolveCustomCsv(plan, [ann, ann, { id: "u2", name: "Gone", active: false }], targets);
  assert.deepEqual(out.rows, [{ row: 4, values: { "custom.name": "C", ownerId: "u1", "custom.client": "acc_1" } }]);
  assert.deepEqual(out.problems.map((p) => p.row), [2, 3]);
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
