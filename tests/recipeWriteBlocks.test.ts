import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { offered } from "../recipes/actions.ts";
import { validateDataQuery } from "../recipes/data.ts";
import { saveOf, saveProblem } from "../src/components/records/board-move.ts";
import type { ObjectDescription } from "../src/components/records/fields.tsx";
const require = createRequire(import.meta.url);
const desc = { apiName: "deal", canCreate: true, writable: true, register: false, readOnlyFields: [], fields: [{ apiName: "name", fieldId: "name", type: "text", label: "Name" }, { apiName: "stage", fieldId: "stage", type: "picklist", label: "Stage" }] } as unknown as ObjectDescription;
function load(path: string, stubs: Record<string, unknown>) {
  const exports: Record<string, unknown> = {};
  runInNewContext(ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, { exports, require: (id: string) => id in stubs ? stubs[id] : require(id) });
  return exports;
}
test("create action refuses hidden, read-only and unavailable fields before dispatching the existing create", async () => {
  const calls: unknown[] = [];
  const { createDataRecord } = load("src/components/records/data-create.ts", { "../../../convex/_generated/api": { api: { deals: { createScoped: "deal" } } }, "./board-move": { saveOf, saveProblem } }) as unknown as typeof import("../src/components/records/data-create.ts");
  const client = { action: async (...args: unknown[]) => { calls.push(args); return { result: { status: "applied" } }; } } as never;
  await assert.rejects(createDataRecord(client, { ...desc, canCreate: false }, { name: "New" }, "k"));
  await assert.rejects(createDataRecord(client, { ...desc, readOnlyFields: ["name"] }, { name: "New" }, "k"));
  await assert.rejects(createDataRecord(client, { ...desc, fields: desc.fields.map((f) => ({ ...f, hidden: true })) }, { name: "New" }, "k"));
  await assert.rejects(createDataRecord(client, desc, { missing: "New" }, "k"));
  assert.equal(calls.length, 0);
  await createDataRecord(client, desc, { name: "New" }, "k");
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [["deal", { name: "New", custom: {}, idempotencyKey: "k" }]]);
});
test("form renders selected fields, conditions control writes, and board moves carry the card version", async () => {
  const calls: unknown[] = [];
  let move: ((row: { id: string; version: number }, value: string) => Promise<void>) | undefined;
  let reloads = 0;
  const { DataForm, DataWriteResult } = load("src/components/records/data-write-section.tsx", {
    "convex/react": { useConvex: () => ({ action: async (...args: unknown[]) => { calls.push(args); return { status: "conflict" }; } }), useQuery: () => undefined }, "../../../convex/_generated/api": { api: { users: { list: "team" }, objects: { writeScoped: "writeScoped" } } }, "../../../recipes/actions": { offered }, "../../../recipes/data": {},
    "./fields": { FieldInput: ({ field, disabled }: { field: { label: string }; disabled: boolean }) => createElement("input", { "aria-label": field.label, disabled }) },
    "./board-view": { BoardView: ({ writable, groupBy, onMove }: { writable: boolean; groupBy: { label: string }; onMove: typeof move }) => { move = onMove; return createElement("div", { role: "group", "aria-label": groupBy.label, "data-writable": writable }); } },
    "./board-move": { saveOf, saveProblem }, "./data-create": {}, "./record-context": {}, "./record-target": {}, "./lookup-field": {}, "@/lib/utils": {},
  }) as unknown as typeof import("../src/components/records/data-write-section.tsx");
  const form = validateDataQuery("form", { object: "deal", fields: ["name"] }, "account") as Extract<ReturnType<typeof validateDataQuery>, { fields: unknown }>;
  const html = renderToStaticMarkup(createElement(DataForm, { query: form, desc, initial: {}, buttons: [{ id: "create", label: "Create deal", disabled: false }], onSubmit: async () => {} }));
  assert.match(html, /aria-label="Name"/); assert.match(html, /Create deal/); assert.doesNotMatch(html, /aria-label="Stage"/);
  const query = validateDataQuery("board", { object: "deal", groupBy: { field: "stage" } }, "account");
  const props = { section: { component: "board" as const, title: "Deals", query, actions: [{ id: "edit", label: "Move", runs: "kernel.editField" as const, enabled: "canDelete" }] }, query, desc, pageObject: "account" as const, context: { canEdit: true, canDelete: false, deleted: false }, record: { id: "acc", values: {} }, pageFields: [], reload: () => { reloads++; } };
  assert.match(renderToStaticMarkup(createElement(DataWriteResult, props)), /data-writable="false"/);
  assert.match(renderToStaticMarkup(createElement(DataWriteResult, { ...props, context: { ...props.context, canDelete: true } })), /data-writable="true"/);
  assert.ok(move);
  await move({ id: "card", version: 7 }, "qualification");
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [["writeScoped", { object: "deal", streamId: "card", values: { stage: "qualification" }, expectedVersion: 7 }]]);
  assert.equal(reloads, 0, "a refused move keeps the block mounted to show its reason");
});
