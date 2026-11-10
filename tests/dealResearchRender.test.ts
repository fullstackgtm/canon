import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
const empty = () => null;
const field = { slug: "primary-goal", label: "Primary goal", question: "What is their goal?" };
const data = { canEdit: true, members: [{ contactId: "person-1", name: "Alex", title: "VP", role: "champion" }], crmRoles: [] };
let members = data.members;
let requested: string[] | undefined;
function render() {
  const source = readFileSync(new URL("../src/components/records/related-lists.tsx", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } });
  let state = 0;
  const stubs: Record<string, unknown> = {
    react: { ...require("react"), useState: (initial: unknown) => [state++ === 0 ? { ...data, members } : initial, empty] },
    "next/link": { default: ({ children }: { children: ReactNode }) => createElement("a", null, children) },
    "convex/react": { useAction: () => empty, useQuery: () => undefined },
    "../../../convex/_generated/api": { api: { dealCommittee: {}, customObjects: {} } },
    "../../../convex/lib/committee": { DEAL_ROLES: ["champion"], ROLE_LABEL: { champion: "Champion" } },
    "@/components/crm/deal-committee": { DealCommittee: empty },
    "@/lib/toast": { toast: { error: empty } },
    "@/lib/utils": { getErrorMessage: String },
    "@/components/ui/select": { SelectField: ({ options, value, disabled, "aria-label": label }: { options: { value: string; label: ReactNode }[]; value: string; disabled?: boolean; "aria-label"?: string }) => createElement("button", { type: "button", role: "combobox", "aria-label": label, disabled }, options.find((o) => o.value === value)?.label) },
    "./lookup-field": { RecordPicker: empty, recordHref: (_: string, id: string) => `/contact/${id}` },
    "./crm-note": { CrmParentNote: empty, CrmNote: empty, CrmRoleNotes: empty, CRM_NAME: {} },
    "./record-context": { RecordLink: ({ children }: { children: ReactNode }) => createElement("a", null, children) },
    "@/components/crm/find-contact-info": { FindContactInfo: empty },
    "@/components/research/ai-cell": {
      useContactAiFields: () => [field],
      useContactAnswers: (ids: string[]) => { requested = ids; return { "person-1": { "primary-goal": { value: "Improve retention" } } }; },
      AiCell: ({ answer }: { answer?: { value: string } }) => createElement("span", null, answer?.value ?? "No answer"),
    },
    "@/components/research/research-menu": { ContactResearchMenu: ({ selectedIds }: { selectedIds: string[] }) => createElement("button", { "data-research-ids": selectedIds.join(",") }, "Research") },
    "@/components/research/ai-field-dialog": { AiFieldDialog: empty },
    "../../../recipes": { offered: () => [] },
  };
  const exports: { DealRelations?: (props: { streamId: string }) => ReactNode } = {};
  runInNewContext(outputText, { exports, require: (id: string) => {
    if (Object.hasOwn(stubs, id)) return stubs[id];
    assert.equal(id, "react/jsx-runtime");
    return require(id);
  } });
  return renderToStaticMarkup(createElement(exports.DealRelations!, { streamId: "deal-1" }));
}

test("deal people show contact research and scope the research action to their members", () => {
  const html = render();
  assert.match(html, /Primary goal/);
  assert.match(html, /Improve retention/);
  assert.equal(requested?.join(","), "person-1");
  assert.match(html, /data-research-ids="person-1"/);
  assert.match(html, /Add AI column/);
  members = [];
  const emptyHtml = render();
  assert.doesNotMatch(emptyHtml, /data-research-ids=/, "an empty deal must not offer an all-contacts rollout");
});
