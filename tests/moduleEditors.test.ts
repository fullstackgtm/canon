import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as editor from "../modules/kernel/editor.ts";
import * as text from "../modules/kernel/text.ts";
import { accountFields, editorOptions, editorValue } from "../modules/examples/icps/editor.ts";

const require = createRequire(import.meta.url);
const childrenOnly = ({ children }: { children?: ReactNode }) => children;
const exports: typeof import("../src/components/modules/module-editors") = {} as typeof import("../src/components/modules/module-editors");
const { outputText } = ts.transpileModule(readFileSync("src/components/modules/module-editors.tsx", "utf8"), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
});
runInNewContext(outputText, { exports, setTimeout, clearTimeout, require: (id: string) => {
  if (["react", "react/jsx-runtime", "lucide-react"].includes(id)) return require(id);
  if (id === "../../../modules/kernel/editor") return editor;
  if (id === "../../../modules/kernel/text") return text;
  if (id === "@/lib/utils") return { cn: (...values: unknown[]) => values.filter(Boolean).join(" ") };
  if (id === "@/components/ui/popover") return { Popover: childrenOnly, PopoverContent: childrenOnly, PopoverTrigger: childrenOnly };
  throw new Error(id);
} });
const check = async (value: string) => ({ text: value.trim() });

test("inline Enter followed by blur saves once, Escape reverts and an external version refuses a dirty save", async () => {
  const state = new editor.InlineDraft("Before", 7);
  const saves: Array<[string, number]> = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  state.change(" After ");
  const save = state.commit(check, async (value, version) => { saves.push([value, version]); await gate; });
  await state.commit(check, async () => { assert.fail("duplicate blur write"); });
  release(); await save;
  assert.deepEqual(saves, [["After", 7]]);
  state.receive("After", 8);
  state.change("Discard"); state.escape("After", 8);
  await state.commit(check, async () => { assert.fail("Escape write"); });
  state.change("Mine"); state.receive("Someone else's", 9);
  await state.commit(check, async () => { assert.fail("stale write"); });
  assert.ok(state.error);
  state.escape("Someone else's", 9);
  assert.deepEqual([state.value, state.version, state.error], ["Someone else's", 9, ""]);
});

test("inline validation fences stale results and refuses invalid canonical saves", async () => {
  const state = new editor.InlineDraft("country:us", 1);
  let respond!: (result: { text: string; error: string }) => void;
  state.change("bad");
  const first = state.validate(() => new Promise((resolve) => { respond = resolve; }));
  state.change("country:ca");
  await state.validate(check);
  respond({ text: "bad", error: "Old error" }); await first;
  assert.equal(state.error, "");
  await state.commit(async (value) => ({ text: value, error: "Invalid" }), async () => { assert.fail("invalid query wrote"); });
  assert.deepEqual([state.error, state.pending], ["Invalid", false]);
});

test("hierarchy collapse hides descendants only and never changes the source rows", () => {
  const rows = [{ key: "root", parent: null }, { key: "segment", parent: "root" }, { key: "person", parent: "segment" }, { key: "other", parent: null }];
  assert.deepEqual(editor.visibleHierarchy(rows, (r) => r.parent, new Set(["segment"])).map((r) => r.key), ["root", "segment", "other"]);
  assert.deepEqual(editor.visibleHierarchy(rows, (r) => r.parent, new Set(["root"])).map((r) => r.key), ["root", "other"]);
  assert.equal(editor.visibleHierarchy(rows, (r) => r.parent, new Set()).length, 4);
  assert.throws(() => editor.visibleHierarchy([{ key: "a", parent: "a" }], (r) => r.parent, new Set()));
});

test("general controls render caller data for every token type and viewers have no write affordances", () => {
  const fields = accountFields([
    { id: "count", entity: "account", label: "Count", answerType: "number", options: null },
    { id: "ready", entity: "account", label: "Ready", answerType: "boolean", options: null },
    { id: "free", entity: "account", label: "Free", answerType: "text", options: null },
    { id: "mode", entity: "account", label: "Mode", answerType: null, options: [{ key: "saas", label: "SaaS" }] },
  ]);
  const options = editorOptions(fields);
  const model = editorValue("segment", 'industry:software-development size:201-500 country:us field.count:1..10 field.ready:true field.free:yes field.mode:saas has(level:vp dept:revops -title:intern)', fields, {});
  const checked = editor.recordEditorValue(model, options);
  assert.equal(checked.parts.filter((p) => typeof p !== "string").length, 10);
  const row = { key: "row", version: 0, owner: null, data: { model, definitionVersion: 5, pointOfView: "", query: "" } };
  const n = { c: "recordEditor" as const, from: "data", rows: "rows", selection: { param: "sel" }, model: "model", options: "options", version: "definitionVersion", versionArg: "expect", change: { call: "condition", arg: "change" }, message: { call: "message", fieldArg: "field", valueArg: "value" } };
  const invoke = async () => { assert.fail("render wrote"); };
  const draw = (allowed: boolean) => renderToStaticMarkup(createElement(exports.ModuleRecordEditor, { n, row, options, access: { allowed: () => allowed, invoke } }));
  const editable = draw(true);
  for (const control of ['aria-label="Minimum"', 'aria-label="Maximum"', 'type="checkbox"', 'aria-label="Search values"', 'aria-label="Condition value"', "+ condition"]) assert.ok(editable.includes(control), control);
  const viewer = draw(false);
  assert.doesNotMatch(viewer, /<button|draggable=|type="checkbox"/);
  assert.match(viewer, /<textarea[^>]*disabled=/);
  const token = model.parts.find((p) => typeof p !== "string") as editor.SentenceToken;
  assert.throws(() => editor.recordEditorValue({ ...model, parts: [{ ...token, call: "hidden" }] }, options));
  assert.throws(() => editor.recordEditorValue({ ...model, parts: [{ ...token, control: { kind: "choices", options: "missing", values: [] } }] }, options));
  const hierarchy = { parent: "parent", depth: "depth", icon: "icon", muted: "muted", star: "star", add: { call: "add", choices: "addChoices", arg: "kind" } };
  const ghost = (allowed: boolean) => renderToStaticMarkup(createElement(exports.HierarchyAdd, { h: hierarchy, row: { ...row, data: { depth: 1, addChoices: [{ value: "child", label: "+ Add child" }] } }, access: { allowed: () => allowed, invoke }, select: () => assert.fail("render selected") }));
  assert.match(ghost(true), /Add child/);
  assert.equal(ghost(false), "");
});
