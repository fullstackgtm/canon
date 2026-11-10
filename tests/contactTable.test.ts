import assert from "node:assert/strict";
import test from "node:test";
import { contactTableRows, contactQuickTestIds, contactAnswerBatches, type ContactTableControls } from "../src/lib/contact-table.ts";

const rows = [
  { id: "a", fullName: "Zoe", title: "VP", accountId: "acme" },
  { id: "b", fullName: "Amy", title: "Engineer", accountId: "beta" },
  { id: "c", fullName: "Pat", title: "VP" },
];
const fields = [{ slug: "persona", options: [{ key: "buyer", label: "Economic buyer" }] }, { slug: "score" }, { slug: "qualified" }];
const answers = {
  a: { persona: { value: "buyer" }, score: { value: 10 }, qualified: { value: false } },
  b: { persona: { value: "champion" }, score: { value: 2 }, qualified: { value: true } },
};
const defaults: ContactTableControls = { sort: "", descending: false, field: "", query: "", missing: false };
const view = (patch: Partial<ContactTableControls>) => contactTableRows(rows, { acme: "Acme", beta: "Beta" }, fields, answers, { ...defaults, ...patch }).map((r) => r.id);

test("contacts sort by standard columns and typed AI answers without mutating source order", () => {
  assert.deepEqual(view({ sort: "fullName" }), ["b", "c", "a"]);
  assert.deepEqual(view({ sort: "account", descending: true }), ["b", "a", "c"]);
  assert.deepEqual(view({ sort: "ai:score" }), ["b", "a", "c"]);
  assert.deepEqual(view({ sort: "ai:score", descending: true }), ["a", "b", "c"]);
  assert.deepEqual(rows.map((r) => r.id), ["a", "b", "c"]);
});

test("column filters use displayed AI tags and booleans, and can find unanswered cells", () => {
  assert.deepEqual(view({ field: "title", query: "vp", sort: "fullName" }), ["c", "a"]);
  assert.deepEqual(view({ field: "ai:persona", query: " ECONOMIC " }), ["a"]);
  assert.deepEqual(view({ field: "ai:qualified", query: "no" }), ["a"]);
  assert.deepEqual(view({ field: "ai:qualified", missing: true }), ["c"]);
  assert.deepEqual(view({ field: "ai:score", query: "not found" }), []);
  assert.deepEqual(view({}), ["a", "b", "c"]);
});

test("AI answer requests cover every loaded row within the server's 500-row bound", () => {
  const ids = Array.from({ length: 501 }, (_, i) => String(i));
  const batches = contactAnswerBatches(ids);
  assert.deepEqual(batches.map((batch) => batch.length), [500, 1]);
  assert.deepEqual(batches.flat(), ids);
  assert.deepEqual(contactAnswerBatches([]), []);
});

test("quick tests take only the first five visible rows, not hidden or unloaded contacts", () => {
  const visible = contactTableRows(rows, {}, fields, answers, { ...defaults, field: "title", query: "VP", sort: "fullName" });
  assert.deepEqual(contactQuickTestIds(visible), ["c", "a"]);
  assert.deepEqual(contactQuickTestIds(Array.from({ length: 12 }, (_, i) => ({ id: String(i), fullName: "Contact" }))), ["0", "1", "2", "3", "4"]);
  assert.deepEqual(contactQuickTestIds([]), []);
});
