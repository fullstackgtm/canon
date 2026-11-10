import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import * as React from "react";
import ts from "typescript";
import { inspectionHref, inspectionTarget, recordHref, recordListOf } from "../src/components/records/record-target.ts";

const require = createRequire(import.meta.url);
const noop = () => undefined;
type Element = React.ReactElement<Record<string, unknown>>;

function load(file: string, stubs: Record<string, unknown>) {
  const source = readFileSync(new URL(`../src/components/records/${file}.tsx`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } });
  const exports: Record<string, (...args: never[]) => Element> = {};
  runInNewContext(outputText, { exports, crypto: { randomUUID }, require: (id: string) => {
    if (id === "react/jsx-runtime") return require(id);
    return stubs[id] ?? {};
  } });
  return exports;
}

test("inspection preserves its first draft while identity loads and clears it on sign-out or workspace change", () => {
  let me: { _id: string; orgId: string } | null | undefined;
  let owner: unknown;
  const children = React.createElement("main");
  const { RecordInspection } = load("record-inspection", {
    react: { ...React, useCallback: (fn: unknown) => fn, useMemo: (fn: () => unknown) => fn(), useRef: () => ({ current: null }), useEffect: noop,
      useState: (initial: () => unknown) => [owner ??= initial(), (next: unknown) => { owner = next; }] },
    "convex/react": { useQuery: () => me },
    "../../../convex/_generated/api": { api: { users: { me: "me" } } },
    "next/navigation": { usePathname: () => "/dashboard/accounts", useSearchParams: () => new URLSearchParams("peekObject=account&peekId=acc_1"), useRouter: () => ({}) },
    "./record-target": { inspectionHref, inspectionTarget },
    "./record-page": { RecordDialog: "dialog" },
    "./record-context": { RecordInspectionContext: React.createContext(null), RecordDraftContext: React.createContext(null) },
  });
  function render() {
    const tree = RecordInspection({ children } as never);
    const [page, provider] = tree.props.children as [React.ReactNode, Element];
    assert.equal(page, children);
    return { drafts: provider.props.value as Map<string, unknown>, key: (provider.props.children as Element).key };
  }
  const loading = render();
  loading.drafts.set("note", "unsaved");
  me = { _id: "u1", orgId: "o1" };
  const loaded = render();
  assert.equal(loaded.drafts, loading.drafts);
  assert.equal(loaded.key, loading.key);
  me = { _id: "u1", orgId: "o2" };
  const moved = render();
  assert.notEqual(moved.drafts, loaded.drafts);
  moved.drafts.set("note", "another draft");
  me = null;
  const signedOut = render();
  assert.notEqual(signedOut.drafts, moved.drafts);
  assert.equal(signedOut.drafts.size, 0);
  assert.notEqual(signedOut.key, moved.key);
  me = { _id: "u1", orgId: "o2" };
  assert.notEqual(render().drafts, signedOut.drafts);
});

test("company and person field saves refuse a stale starting version before writing", async () => {
  for (const object of ["account", "contact"]) {
    const row = { id: "party_1", version: 1, title: "Example", values: {} };
    let freshVersion = 2, writes = 0, stateIndex = 0;
    const errors: string[] = [];
    const { RegisterRecordPage } = load("register-page", {
      react: { ...React, useCallback: (fn: unknown) => fn, useEffect: noop, useState: (initial: unknown) => [stateIndex++ === 0 ? row : initial, noop] },
      "../../../convex/_generated/api": { api: { objects: { describe: "describe", list: "list" }, records: { edit: "edit" }, recipes: { recordPage: "page" }, users: { list: "team" }, permissions: { mine: "perms" } } },
      "convex/react": {
        useQuery: (name: string) => ({ describe: { fields: [], writable: true }, page: { sections: [] }, team: [], perms: { objects: { [object]: { visibility: "all" } } } })[name],
        useAction: (name: string) => name === "list" ? async () => ({ rows: [{ ...row, version: freshVersion }] }) : async () => { writes++; },
      },
      "./record-parts": { Frame: "main" },
      "./record-target": { recordHref, recordListOf },
      "./fields": { fieldPatch: (_: string, field: { apiName: string }, value: unknown) => ({ [field.apiName]: value }) },
      "@/lib/toast": { toast: { error: (message: string) => { errors.push(message); } } },
      "@/lib/utils": { getErrorMessage: String },
    });
    const tree = RegisterRecordPage({ object, id: row.id } as never);
    const panels = (tree.props.children as Element[])[1];
    const sections = (panels.props.renderSections as (replaced: ReadonlySet<string>) => Element)(new Set());
    const section = sections.props.children as Element;
    const save = section.props.saveField as (field: { apiName: string; label: string }, value: string, version: number) => Promise<boolean>;
    const field = { apiName: "name", label: "Name" };
    assert.equal(await save(field, "Draft", 1), false);
    assert.equal(writes, 0);
    assert.equal(errors.length, 1);
    freshVersion = 1;
    assert.equal(await save(field, "Draft", 1), true);
    assert.equal(writes, 1);
  }
});
