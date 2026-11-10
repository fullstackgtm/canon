import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { SharePayload } from "../convex/lib/modules/shares.ts";
import type { ActionRef } from "../modules/kernel/manifest.ts";
import type { VisitorWrite, VisitorUploadTarget } from "../modules/kernel/visit.ts";
import * as schema from "../modules/kernel/schema.ts";
import * as document from "../modules/kernel/document.ts";
import * as text from "../modules/kernel/text.ts";

type Element = { type: string; props: Record<string, any> };
const source = ts.transpileModule(readFileSync("src/components/modules/visitor-page.tsx", "utf8"), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

function harness(action: ActionRef) {
  const states: unknown[] = [];
  let index = 0;
  const jsx = (type: string | ((props: unknown) => unknown), props: Record<string, unknown>) => typeof type === "function" ? type(props) : { type, props };
  const modules: Record<string, unknown> = {
    react: { useState: (initial: unknown) => {
      const i = index++;
      if (!(i in states)) states[i] = initial;
      return [states[i], (next: unknown) => { states[i] = typeof next === "function" ? next(states[i]) : next; }];
    } },
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "fragment" },
    "convex/react": {}, "../../../convex/_generated/api": {},
    "../../../modules/kernel/schema": schema, "../../../modules/kernel/document": document, "../../../modules/kernel/text": text,
    "@/components/ui/tabs": {},
  };
  const exports: { VisitorPage?: (props: unknown) => Element } = {};
  runInNewContext(source, { exports, File, URL, require: (name: string) => {
    assert.ok(Object.hasOwn(modules, name), name);
    return modules[name];
  } });
  const sent: VisitorWrite[] = [], uploads: Array<{ target: VisitorUploadTarget; file: File }> = [];
  const fields = { note: { fieldType: { type: "string" as const, maxLength: 500 }, optional: false }, original: { fieldType: { type: "string" as const, maxLength: 500 }, optional: false } };
  const payload: SharePayload = {
    workspace: "Demo", title: "Visit", pages: [], members: {}, files: {}, labels: {}, formats: {}, machines: {},
    page: { path: "visit", title: "Visit", body: [{ c: "actions", items: [action] }] },
    data: { visit: { key: "visit-1", version: 1, data: { note: "First note", original: "First fixed value" } } },
    writes: { ops: { "visits.update": { label: "Edit", kind: "update", fields } }, transitions: { "visit.confirm": { label: "Confirm", fields } } },
  };
  return { payload, sent, uploads, render: () => {
    index = 0;
    return exports.VisitorPage!({ payload, navigate: () => {}, run: async (input: VisitorWrite) => { sent.push(input); }, upload: async (target: VisitorUploadTarget, file: File) => { uploads.push({ target, file }); return { id: "uploaded-photo", name: "site.png", type: "image/png", bytes: file.size }; } });
  } };
}

function find(node: unknown, type: string): Element {
  if (Array.isArray(node)) {
    for (const child of node) { const found = search(child, type); if (found) return found; }
  } else { const found = search(node, type); if (found) return found; }
  throw new Error(`Missing ${type}`);
}
function search(node: unknown, type: string): Element | undefined {
  if (!node || typeof node !== "object" || !("props" in node)) return undefined;
  const element = node as Element;
  if (element.type === type) return element;
  const children = [element.props.children].flat(Infinity);
  for (const child of children) { const found = search(child, type); if (found) return found; }
}

test("visitor dialogs keep the edited key, version and fixed fields when polling refreshes the page", async () => {
  for (const kind of ["op", "transition"] as const) {
    const action: ActionRef = { ...(kind === "op" ? { op: "visits.update" } : { machine: "visit", transition: "confirm" }), target: "visit", fixed: { original: { bind: "visit", field: "original" } } };
    const h = harness(action);
    find(h.render(), "button").props.onClick();
    find(h.render(), "textarea").props.onChange({ target: { value: "Customer edit" } });
    h.payload.data.visit = { key: "visit-2", version: 2, data: { note: "Another writer", original: "New fixed value" } };
    find(h.render(), "form").props.onSubmit({ preventDefault() {} });
    await Promise.resolve();
    assert.deepEqual(JSON.parse(JSON.stringify(h.sent)), [kind === "op"
      ? { kind: "op", op: "visits.update", key: "visit-1", expect: 1, data: { note: "Customer edit", original: "First fixed value" } }
      : { kind: "transition", machine: "visit", transition: "confirm", key: "visit-1", expect: 1, args: { note: "Customer edit", original: "First fixed value" } }]);
  }
});

test("visitor photo forms upload against the opened target before saving the file id", async () => {
  for (const kind of ["op", "transition"] as const) {
    const action: ActionRef = { ...(kind === "op" ? { op: "visits.update" } : { machine: "visit", transition: "confirm" }), target: "visit" };
    const h = harness(action), photo = new File([new Uint8Array([137, 80, 78, 71])], "site.png", { type: "text/html" });
    const fields = { photo: { fieldType: { type: "file" as const, accept: ["image/png"] }, optional: false } };
    h.payload.writes.ops["visits.update"].fields = fields;
    h.payload.writes.transitions["visit.confirm"].fields = fields;
    find(h.render(), "button").props.onClick();
    const input = find(h.render(), "input");
    assert.equal(input.props.type, "file");
    input.props.onChange({ target: { files: [photo] } });
    h.payload.data.visit = { key: "other", version: 2, data: {} };
    find(h.render(), "form").props.onSubmit({ preventDefault() {} });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(JSON.parse(JSON.stringify(h.uploads.map((u) => u.target))), [kind === "op"
      ? { kind: "op", op: "visits.update", field: "photo", key: "visit-1", expect: 1 }
      : { kind: "transition", machine: "visit", transition: "confirm", field: "photo", key: "visit-1", expect: 1 }]);
    assert.equal(h.uploads[0].file.type, "text/html");
    assert.deepEqual(JSON.parse(JSON.stringify(h.sent)), [kind === "op"
      ? { kind: "op", op: "visits.update", key: "visit-1", expect: 1, data: { photo: "uploaded-photo" } }
      : { kind: "transition", machine: "visit", transition: "confirm", key: "visit-1", expect: 1, args: { photo: "uploaded-photo" } }]);
  }
});


test("visitor tables sort stably, label groups, render the declared team and fence HTTPS links", () => {
  const h = harness({ navigate: "plan", label: "Plan" });
  h.payload.page.body = [
    { c: "table", from: "steps", sort: { by: "order" }, groupBy: [{ by: "milestone", label: "{$row.milestone}" }], columns: [{ label: "Step", value: "{$row.title}" }] },
    { c: "table", from: "team", columns: [{ label: "Team", value: "{$row.member|user}" }, { label: "Role", value: "{$row.role}" }] },
    { c: "table", from: "assets", columns: [{ label: "Resource", value: "{$row.title}", link: { url: "url" } }] },
  ];
  const row = (key: string, data: Record<string, unknown>) => ({ key, version: 1, data });
  h.payload.data.steps = [row("b", { title: "Second tie", order: 1, milestone: "m" }), row("z", { title: "Last step", order: 2, milestone: "m" }), row("a", { title: "First tie", order: 1, milestone: "m" })];
  h.payload.labels.steps = { milestone: { m: "Launch milestone" } };
  h.payload.data.team = [row("0", { member: "ae", role: "Account executive" }), row("1", { member: "se", role: "Engineer" })];
  h.payload.members = { ae: { name: "Avery" }, se: { name: "Sam" } };
  h.payload.formats.team = { member: "user" };
  h.payload.data.assets = [row("a", { title: "Guide", url: "https://docs.example.test/guide" }), ...["http://example.test", "https://user:pass@example.test", "https://example.test/\npath", "javascript:alert(1)"].map((url, i) => row(String(i), { title: "Unsafe", url }))];
  const rendered = h.render(), json = JSON.stringify(rendered);
  assert.ok(json.indexOf("First tie") < json.indexOf("Second tie"));
  assert.ok(json.indexOf("Second tie") < json.indexOf("Last step"));
  for (const text of ["Launch milestone", "Avery", "Sam", "Account executive", "Engineer"]) assert.ok(json.includes(text), text);
  const anchor = find(rendered, "a");
  assert.equal(anchor.props.href, "https://docs.example.test/guide");
  assert.equal(anchor.props.rel, "noopener noreferrer");
  assert.equal((json.match(/"type":"a"/g) ?? []).length, 1);
});

test("step-thread posts freeze the admitted step key and expose only projected doc choices", async () => {
  const h = harness({ op: "visits.update" });
  h.payload.page.body = [{ c: "thread", from: "comments", body: "body", post: { op: "visits.update", parent: { root: true }, field: "body", fixed: { step: { bind: "step", field: "key" } } } }];
  h.payload.data.comments = [];
  h.payload.data.step = { key: "shared-step", version: 1, data: { title: "Review" } };
  h.payload.writes.ops["visits.update"] = { label: "Reply", kind: "create", fields: { body: { fieldType: { type: "string", maxLength: 2000 }, optional: false }, step: { fieldType: { type: "ref", to: "doc", collection: "steps" }, optional: true } }, choices: { step: [{ key: "shared-step", label: "Review" }] } };
  find(h.render(), "button").props.onClick();
  find(h.render(), "textarea").props.onChange({ target: { value: "Ready" } });
  h.payload.data.step = { key: "changed-step", version: 2, data: {} };
  find(h.render(), "form").props.onSubmit({ preventDefault() {} });
  await Promise.resolve();
  assert.deepEqual(JSON.parse(JSON.stringify(h.sent)), [{ kind: "op", op: "visits.update", data: { body: "Ready", step: "shared-step" } }]);
});

test("the Deal rooms step-page menu reads its bound step without a table row", () => {
  const manifest = JSON.parse(readFileSync("modules/examples/deal-rooms/module.json", "utf8"));
  const actions = manifest.shares.room.pages[1].body.find((n: { c: string }) => n.c === "actions");
  const h = harness({ navigate: "plan", label: "Plan" });
  h.payload.page.body = [actions];
  for (const side of ["buyer", "both", "seller"]) {
    h.payload.data.step = { key: "step1", version: 1, data: { side, status: "open" } };
    const rendered = JSON.stringify(h.render());
    assert.equal(rendered.includes("Mark done"), side !== "seller");
    assert.equal(rendered.includes("Attach file"), side !== "seller");
  }
});
