import assert from "node:assert/strict";
import { test } from "node:test";
import { relabelObject, type ExistingObject } from "../convex/lib/objects/customObjects.ts";
import { resolveOrgObject } from "../convex/lib/objects/registry.ts";
import { addField } from "../convex/lib/objects/fieldBuilder.ts";

const names: ExistingObject[] = [
  { apiName: "account", label: "Account", pluralLabel: "Accounts" },
  { apiName: "contact", label: "Person", pluralLabel: "People" },
  { apiName: "custom_client", label: "Client", pluralLabel: "Clients" },
];

test("a workspace's own name for a standard object reaches its definition, can't repeat another object's, and resets", () => {
  const contacts = relabelObject("contact", undefined, { label: " Contact ", pluralLabel: "Contacts" }, names);
  assert.deepEqual([resolveOrgObject("contact", contacts)!.label, resolveOrgObject("contact", contacts)!.pluralLabel], ["Contact", "Contacts"]);
  assert.throws(() => relabelObject("contact", contacts, { label: "Client", pluralLabel: "Clients" }, names), /already an object named Client/);
  assert.throws(() => relabelObject("contact", contacts, { label: "Account", pluralLabel: "Folks" }, names), /already an object named Account/);
  assert.ok(relabelObject("contact", contacts, { label: "Person", pluralLabel: "Humans" }, names), "its own current name is not a clash");
  const reset = relabelObject("contact", contacts, null, names);
  assert.equal(resolveOrgObject("contact", reset)!.pluralLabel, "People");
  assert.equal(reset.registryVersion, 2);
});

test("a field added after a rename keeps the name, and a reset that would repeat another object's name is refused", () => {
  const contacts = relabelObject("contact", undefined, { label: "Contact", pluralLabel: "Contacts" }, names);
  const { ext } = addField("contact", contacts, { label: "Nickname", type: "text" });
  assert.equal(resolveOrgObject("contact", ext)!.pluralLabel, "Contacts");
  const taken = [...names, { apiName: "deal", label: "Person", pluralLabel: "People" }];
  assert.throws(() => relabelObject("contact", contacts, null, taken), /already an object named Person/);
});
