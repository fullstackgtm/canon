import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { isFactualField } from "../convex/lib/research/agentLoop.ts";
import { factualModel } from "../convex/lib/research/factualExtraction.ts";
import * as runPlan from "../convex/lib/research/runPlan.ts";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../src/app/dashboard/fields/page.tsx", import.meta.url), "utf8");
const field = {
  id: "field", slug: "buyer", label: "Buyer responsibility", attribute: "custom.buyer",
  question: "What does this buyer do?", kind: "qa", answerType: "text", entityType: "contact",
  autoAcceptMinConfidence: 0.8, refresh: { cadence: null, nextAt: null, hold: null },
  agent: { status: "active", owner: { name: "Taylor" }, message: null }, latestRun: null,
};
type RenderOptions = {
  expanded?: boolean; canEdit?: boolean; answersOpen?: boolean; recordsOpen?: boolean; traceOpen?: string | null;
  traces?: object[]; answers?: object[]; traceReads?: string[];
};
function render(agents: object[] | undefined, { expanded = false, canEdit = true, answersOpen = false, recordsOpen = false, traceOpen = null, traces, answers = [], traceReads }: RenderOptions = {}) {
  let state = 0;
  const stubs: Record<string, unknown> = {
    react: { ...require("react"), useEffect: () => {}, useState: (initial: unknown) => {
      const index = state++;
      let value = initial;
      if (index === 1) value = expanded;
      if (index === 2) value = answersOpen;
      if (index === 5 && initial === false) value = recordsOpen;
      if (index === 7 && initial === null) value = traceOpen;
      return [value, () => {}];
    } },
    "next/link": { default: ({ children }: { children: ReactNode }) => children },
    "convex/react": {
      useQuery: (query: string, args?: { runId: string }) => {
        if (query === "traces") { traceReads?.push(args!.runId); return traces; }
        if (query === "answers") return answers;
        assert.equal(query, "list");
        return agents === undefined ? undefined : { agents, canEditGate: canEdit, canRefresh: canEdit };
      },
      useMutation: () => () => Promise.resolve(), useAction: () => () => Promise.resolve([]),
    },
    "../../../../convex/_generated/api": { api: { researchAgents: { list: "list", traces: "traces", answers: "answers" } } },
    "@/components/records/object-labels": { useObjectLabels: () => (o: string) => ({ label: o, pluralLabel: o === "contact" ? "People" : o === "account" ? "Accounts" : `${o}s` }) },
    "@/components/dashboard": {
      ViewFrame: ({ children }: { children?: ReactNode }) => createElement("section", null, children), LoadingRows: () => "Loading", EmptyState: () => "No fields",
      StatusBadge: ({ status }: { status: string }) => status,
    },
    "@/components/agents/agent-owner-line": { AgentOwnerLine: () => "Owner settings" },
    "@/components/research/ai-field-dialog": { AiFieldDialog: () => null },
    "@/components/research/run-preview-dialog": { RunPreviewDialog: () => null, formatUsd: String },
    "@/components/research/ai-cell": { quoteAndSource: () => ({}) },
    "@/components/research/probe-verdict": { ProbeVerdictLine: () => null },
    "@/components/research/pi-run-live": { PiRunLive: () => "Watching live" },
    "../../../../convex/lib/research/agentLoop": { isFactualField },
    "../../../../convex/lib/research/runPlan": runPlan,
    "@/lib/utils": { cn: (...v: unknown[]) => v.filter(Boolean).join(" "), getErrorMessage: String },
    "@/components/ui/select": { SelectField: ({ options, value, disabled, "aria-label": label }: { options: { value: string; label: ReactNode }[]; value: string; disabled?: boolean; "aria-label"?: string }) => createElement("button", { type: "button", role: "combobox", "aria-label": label, disabled }, options.find((o) => o.value === value)?.label) },
    "@/lib/toast": { toast: {} },
  };
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2017, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } });
  const exports: Record<string, () => ReactNode> = {};
  runInNewContext(outputText, { exports, require: (id: string) => {
    if (Object.hasOwn(stubs, id)) return stubs[id];
    assert.ok(["react/jsx-runtime", "lucide-react"].includes(id), `Unexpected dependency: ${id}`);
    return require(id);
  } });
  return renderToStaticMarkup(createElement(exports.default));
}

test("fields renders compact, aligned rows with details collapsed and run actions available", () => {
  const html = render([field, { ...field, id: "second", entityType: "account", kind: "classify", autoAcceptMinConfidence: null, agent: { ...field.agent, status: "paused" } }]);
  assert.match(html, /overflow-x-auto/);
  assert.match(html, /<table aria-label="AI fields"/);
  assert.deepEqual([...html.matchAll(/<th[^>]*scope="col"[^>]*>(.*?)<\/th>/g)].map((m) => m[1]),
    ["Field", "Type", "Applies to", "Owner", "Review", "Refresh", "Latest run", "Actions"]);
  assert.equal((html.match(/scope="row"/g) ?? []).length, 2);
  assert.equal((html.match(/aria-expanded="false"/g) ?? []).length, 2);
  assert.doesNotMatch(html, /What does this buyer do\?/);
  for (const value of ["People", "Accounts", "Taylor", "Auto-accept ≥ 0.80", "Manual review", "Not run yet", "Classify"]) assert.ok(html.includes(value), value);
  assert.equal((html.match(/aria-label="Delete Buyer responsibility"/g) ?? []).length, 2);
  assert.equal((html.match(/aria-label="Edit Buyer responsibility"/g) ?? []).length, 2);
  assert.doesNotMatch(render([field], { canEdit: false }), /aria-label="Edit/);
  assert.equal((html.match(/disabled=""/g) ?? []).length, 1);
  const running = render([{ ...field, latestRun: { id: "run", status: "running", answered: 3, errors: 1 } }]);
  assert.match(running, /Stop/);
  assert.match(running, /3 answered/);
  assert.match(running, /1 errors/);
});

test("expanded field retains question, options, permission-gated settings and answers disclosure", () => {
  const data = [{ ...field, options: [{ key: "a", label: "Option A", description: "Meaning" }] }];
  const html = render(data, { expanded: true });
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /colSpan="8"/);
  assert.match(html, /What does this buyer do\?/);
  assert.match(html, /Option A/);
  assert.match(html, /Owner settings/);
  assert.match(html, /aria-label="Auto-accept threshold"/);
  assert.match(html, /aria-label="Refresh cadence"/);
  assert.match(html, /Answers/);
  assert.match(render([{ ...field, refresh: { cadence: "weekly", nextAt: null, hold: null } }], { expanded: true }), /Clairic/);
  const readOnly = render(data, { expanded: true, canEdit: false });
  assert.doesNotMatch(readOnly, /role="combobox"/);
});

test("fields keeps every content state inside the view frame", () => {
  for (const agents of [undefined, [], [field]]) {
    assert.match(render(agents), /^<section>/);
  }
});

test("fields retains loading and empty states without an empty table", () => {
  assert.match(render(undefined), /Loading/);
  assert.match(render([]), /No fields/);
  assert.doesNotMatch(render(undefined) + render([]), /<table/);
});

const run = {
  id: "latest-run", status: "done", planned: 1, done: 1, answered: 1, unknown: 0, noEvidence: 0, inferred: 0,
  errors: 0, skipped: 0, pagesRead: 2, llmCalls: 3, credits: { cap: null, spent: 0 }, runtime: "pi",
};
const trace = {
  id: "trace", recordId: "record", label: "Example", status: "answered", value: "Paris", quote: "Based in Paris",
  model: factualModel("gpt-6-luna"), promptVersion: "clairic-navigation:test", calls: 3, ms: 1000,
  steps: [{ kind: "model", action: "read" }, { kind: "model", action: "search" }, { kind: "model", action: "answer" }],
};
const withRun = { ...field, latestRun: run };

test("expanded latest run shares its recorded model query with record details", () => {
  const traceReads: string[] = [];
  const options = { traces: [trace], traceReads };
  render([withRun], options);
  assert.deepEqual(traceReads, []);
  const html = render([withRun], { ...options, expanded: true });
  assert.deepEqual(traceReads, [run.id]);
  assert.match(html, /Latest run · Extraction model: Clairic/);
  assert.match(html, /Navigation model: gpt-6-luna/);
  assert.match(html, /From available record traces/);
  assert.doesNotMatch(html, /Extracted by Clairic/);
  traceReads.length = 0;
  const details = render([withRun], { ...options, expanded: true, recordsOpen: true, traceOpen: trace.id });
  assert.deepEqual(traceReads, [run.id]);
  assert.match(details, /Extracted by Clairic/);
  assert.match(details, /Navigator asked to read/);
  assert.match(details, /Navigator asked to search/);
  assert.match(details, /Clairic extracted the answer/);
  assert.ok(details.includes(`title="${trace.model}"`));
  assert.ok(details.includes(`${trace.model} · prompt`));
});

test("latest run conservatively distinguishes historical, mixed and missing model metadata", () => {
  const expanded = { expanded: true };
  for (const model of ["gpt-6-luna", "custom-clairic-model", "@cf/cloudflare/clairic-v2", "@cf/cloudflare/clairic; navigator=", `${trace.model}; future=other`]) {
    const html = render([withRun], { ...expanded, traces: [{ ...trace, model }] });
    assert.ok(html.includes(`Research model: ${model}`));
    assert.doesNotMatch(html, /Extraction model: Clairic|Navigation model:/);
  }
  const bare = render([withRun], { ...expanded, traces: [{ ...trace, model: "@cf/cloudflare/clairic" }] });
  assert.match(bare, /Extraction model: Clairic/);
  assert.doesNotMatch(bare, /Navigation model:/);
  const mixed = render([withRun], { ...expanded, traces: [trace, { ...trace, id: "old", model: "gpt-6-luna" }, { ...trace, id: "missing", model: "" }, { ...trace, id: "duplicate" }] });
  for (const label of [/Recorded models:/, /Clairic \(extraction; navigation: gpt-6-luna\)/, /gpt-6-luna \(research\)/, /unrecorded/]) assert.match(mixed, label);
  assert.equal((mixed.match(/Clairic \(extraction/g) ?? []).length, 1);
  assert.doesNotMatch(mixed, /Latest run · Extraction model:/);
  const navigators = render([withRun], { ...expanded, traces: [trace, { ...trace, id: "other", model: factualModel("other-navigator") }] });
  assert.match(navigators, /Recorded models:/);
  assert.match(navigators, /navigation: other-navigator/);
  const traceReads: string[] = [];
  const loading = render([{ ...withRun, latestRun: { ...run, id: "new-run", status: "running" } }], { ...expanded, traceReads });
  assert.deepEqual(traceReads, ["new-run"]);
  assert.match(loading, /Loading model provenance/);
  assert.doesNotMatch(loading, /Extraction model:|Research model:/);
  for (const traces of [[], [{ ...trace, model: "" }], [{ ...trace, model: " " }]]) {
    const html = render([withRun], { ...expanded, traces });
    assert.match(html, /Model provenance unavailable/);
    assert.doesNotMatch(html, /Extraction model:|Research model:/);
  }
});

test("trace attribution preserves Jev inference and write-gate rejection over the recorded pipeline", () => {
  const options = { expanded: true, recordsOpen: true, traceOpen: trace.id };
  const jev = { choice: "Paris", confidence: 0, probabilities: { Paris: 0 } };
  for (const status of ["unknown", "no_evidence", "answered"]) {
    for (const read of [undefined, jev]) {
      const html = render([withRun], { ...options, traces: [{ ...trace, status, inferred: true, jev: read }] });
      assert.match(html, /Answer inferred by Jev/);
      assert.doesNotMatch(html, /Extracted by Clairic|Clairic extracted the answer/);
      if (read) assert.match(html, /inferred by Jev \(0.00\)/);
    }
  }
  const rejected = render([withRun], { ...options, traces: [{ ...trace, status: "rejected", inferred: true, jev, reason: "Low confidence" }] });
  assert.match(rejected, /rejected by the write gate: Low confidence/);
  assert.match(rejected, /Candidate inferred by Jev/);
  assert.doesNotMatch(rejected, /Extracted by Clairic|Clairic extracted the answer/);
  const gated = render([withRun], { ...options, traces: [{ ...trace, status: "rejected" }] });
  assert.match(gated, /rejected by the write gate/);
  assert.match(gated, /Clairic extracted a candidate answer/);
  assert.doesNotMatch(gated, /Extracted by Clairic|Clairic extracted the answer/);
  const checked = render([withRun], { ...options, traces: [{ ...trace, jev }] });
  assert.match(checked, /Extracted by Clairic/);
  assert.doesNotMatch(checked, /Answer inferred by Jev/);
});

test("answers label fact-local quote checks and inference confidence without inheriting the latest run model", () => {
  const answer = { factId: "fact", account: "Earlier answer", value: "London", status: "accepted", evidence: null, verification: 0.87, verifiedBy: "evidence" };
  const html = render([withRun], { expanded: true, answersOpen: true, traces: [trace], answers: [
    answer, { ...answer, factId: "inferred", verifiedBy: "read", verification: 0 },
    { ...answer, factId: "zero-check", verification: 0 }, { ...answer, factId: "unchecked", verification: null, verifiedBy: null },
  ] });
  const table = html.slice(html.indexOf("<caption"));
  assert.match(table, /Answers may include earlier runs/);
  assert.match(table, /Earlier answer/);
  assert.match(table, /Quote checked by Jev.*0.87/);
  assert.match(table, /Inferred by Jev · confidence.*0.00/);
  assert.equal((table.match(/by Jev/g) ?? []).length, 3);
  assert.equal((table.match(/0\.00/g) ?? []).length, 2);
  assert.doesNotMatch(table, /Clairic|Jev check|Jev read/);
});
