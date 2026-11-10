import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as model from "../convex/lib/plays/model.ts";
import * as committee from "../convex/lib/committee.ts";
import * as recipes from "../recipes/index.ts";
import * as selection from "../convex/lib/plays/prospectSelection.ts";
import * as icps from "../convex/lib/icps.ts";
import * as icpGates from "../convex/lib/icpGates.ts";
import * as peopleResearch from "../convex/lib/plays/peopleResearch.ts";
import * as drafts from "../convex/lib/plays/drafts.ts";
import * as runs from "../convex/lib/plays/runs.ts";

const savedIcps = [
  { key: "revenue", name: "Revenue leaders", active: true, spec: { ...icps.emptySpec(), persona: { levels: [], departments: [], titles: ["VP Revenue"] } } },
  { key: "engineering", name: "Engineering leaders", active: false, spec: { ...icps.emptySpec(), persona: { levels: [], departments: [], titles: ["VP Engineering"] } } },
];

const require = createRequire(import.meta.url);
const plays = recipes.defaultPlays("fsgtm-enterprise-deal")!;
const empty = () => null;
const step = (title: string, dueOn: string | null, extra = {}) => ({
  id: title, title, dueOn, channel: "email", state: "planned", targetId: "person", contactId: "person",
  role: null, ownerUserId: null, origin: "user", doneBy: null, draft: null, ...extra,
});
const steps = [
  step("Undated action", null), step("Later action", "2026-12-01"),
  step("Skipped action", "2026-01-01", { state: "skipped" }),
  step("Completed action", "2026-01-01", { state: "done" }),
  step("Touched action", "2026-01-01", { doneBy: { at: 1 } }),
  step("Urgent action", "2026-10-01", { draft: { subject: "Draft subject", body: "Long draft body", by: "user", at: 1, checks: plays.drafts.check("email", "Draft subject", "Long draft body") } }),
];

const transpile = (path: string) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const outputText = transpile("../src/components/crm/deal-play.tsx");
const sectionsText = transpile("../src/components/records/page-sections.tsx");
const record = Object.fromEntries(recipes.RECORD_COMPONENTS.map((c) => [c, () => createElement("section", { "data-record": c })]));

function harness(plan = steps, canEdit = true, extra: Record<string, unknown> = {}, page: recipes.PageSpec = recipes.RECIPES["fsgtm-enterprise-deal"].dealPage) {
  const data = {
    streamId: "deal", recipe: { id: "fsgtm-enterprise-deal", settings: recipes.RECIPES["fsgtm-enterprise-deal"].settings }, canEdit, started: true,
    recipeData: { stages: plays.stages, peopleFields: plays.people.fields, peopleSlugs: plays.people.slugs },
    deal: { companyId: "company", companyName: "Example", amount: 100000, currency: "USD", ownerName: "Owner", closeDate: "2026-12-31" },
    brief: {}, research: null, keeperCheck: null, keeperPaused: null,
    keeper: { health: "needs_attention", flags: [{ key: "gap", severity: "medium", text: "Missing champion" }], windowDays: null },
    steps: plan, people: [{ contactId: "person", name: "Buyer", role: "executive", thread: { state: "untouched", touches: 0 } }],
    items: [], others: [], suggested: [], touches: [], pointOfView: { icpId: "icp", icpName: "Platform teams", text: "Routing, not volume." },
    stage: "case", prospects: [],
    prep: {
      verdict: "Buyer is carrying this alone.", stall: null, questions: ["Who signs?"],
      checks: [{ key: "signer", label: "We know who signs", ok: false, evidence: "Nobody is named as the signer." }],
      answers: [{ question: "Who signs?", answer: null, quote: null, sourceUrl: null, asked: true }],
    },
  };
  const states: unknown[] = [{ ...data, ...extra }];
  let index = 0;
  const draftStates: unknown[] = [];
  let draftIndex = 0;
  let toggle: (() => void) | undefined;
  let dialogOpen = false;
  const controls = new Map<string, Record<string, unknown>>();
  const runtime = require("react/jsx-runtime");
  const wrap = (factory: typeof runtime.jsx) => (type: unknown, props: Record<string, unknown>, key: unknown) => {
    if (type === "button" && "aria-expanded" in props) toggle = props.onClick as () => void;
    if (typeof type === "string") {
      const name = props["aria-label"] ?? (type === "button" ? props.children : null);
      if (typeof name === "string") controls.set(name, props);
    }
    return factory(type, props, key);
  };
  const stubs: Record<string, unknown> = {
    "@/components/integration-gate": {
      IntegrationGate: ({ children }: { children: ReactNode }) => children,
      IntegrationActionGate: ({ children }: { children: ReactNode }) => children,
    },
    react: { ...require("react"), useState: (initial: unknown) => {
      // Portal content mounts separately, so its hooks cannot shift the page's hook slots.
      const inDraft = new Error().stack?.includes("at StepDraftContent (");
      const values = inDraft ? draftStates : states;
      const i = inDraft ? draftIndex++ : index++;
      if (!(i in values)) values[i] = initial;
      return [values[i], (value: unknown) => { values[i] = value; }];
    } },
    "react/jsx-runtime": { ...runtime, jsx: wrap(runtime.jsx), jsxs: wrap(runtime.jsxs) },
    "@/components/ui/dialog": {
      Dialog: ({ children }: { children: ReactNode }) => children,
      DialogTrigger: ({ children }: { children: ReactNode }) => {
        const child = children as ReactElement<{ children: string }>;
        controls.set(child.props.children, { onClick: () => { dialogOpen = true; } });
        return child;
      },
      DialogContent: ({ children }: { children: ReactNode }) => dialogOpen ? createElement("section", { role: "dialog" }, children) : null,
      DialogHeader: ({ children }: { children: ReactNode }) => children,
      DialogTitle: ({ children }: { children: ReactNode }) => createElement("h2", {}, children),
      DialogDescription: ({ children }: { children: ReactNode }) => createElement("p", {}, children),
    },
    "next/link": { default: ({ children }: { children: ReactNode }) => children },
    // The viewer has ChatGPT connected, so research starts without the credit confirmation.
    "convex/react": { useAction: () => empty, useQuery: (query: unknown) => query === "icpsInterface.list" ? { icps: savedIcps } : query === "chatgptAuth.status" ? { status: "connected" } : { accounts: [{ _id: "mail", status: "ok", address: "sender@example.com" }] } },
    "../../../convex/_generated/api": { api: { icpsInterface: { list: "icpsInterface.list" }, chatgptAuth: { status: "chatgptAuth.status" }, credits: { summary: "credits.summary" }, dealStateActions: {}, dealPlays: {}, dealPlayActions: {}, dealPlayKeeper: {}, records: {}, dealCommittee: {}, emailActions: {}, emailAccounts: {}, linkedin: {} } },
    "../../../convex/lib/committee": committee,
    "../../../convex/lib/plays/model": model,
    "../../../recipes": recipes,
    "../../../convex/lib/plays/prospectSelection": selection,
    "../../../convex/lib/icps": icps,
    "../../../convex/lib/icpGates": icpGates,
    "../../../convex/lib/plays/peopleResearch": peopleResearch,
    "../../../convex/lib/plays/drafts": drafts,
    "../../../convex/lib/plays/runs": runs,
    "@/components/research/ai-cell": {
      useContactAiFields: () => recipes.defaultPlays("fsgtm-enterprise-deal")!.people.fields.map((f) => ({ ...f, options: undefined })),
      useContactAnswers: () => (extra.answers as Record<string, unknown> | undefined) ?? {},
      AiCell: ({ answer }: { answer?: { value: string } }) => answer?.value ?? "—",
      quoteAndSource: (evidence: string | null) => {
        const m = evidence?.match(/^([\s\S]*?)\n\nSource: (\S+)$/);
        return m ? { quote: m[1], url: m[2] } : { quote: evidence, url: null };
      },
    },
    "@/components/records/lookup-field": { recordHref: () => "/buyer" },
    "@/components/records/crm-note": { CrmRoleNotes: () => null },
    "@/components/records/object-labels": { useObjectLabels: () => () => ({ label: "Person", pluralLabel: "People" }) },
    // The canvas is visual; these tests read the list view it switches with.
    "@/components/flow/flow-canvas": { FlowSwitch: ({ list }: { list: ReactNode }) => list, FlowCanvas: () => null, FlowRows: () => null },
    "@/components/ui/select": { SelectField: ({ options, value, disabled, "aria-label": label }: { options: { value: string; label: string }[]; value: string; disabled?: boolean; "aria-label"?: string }) =>
      createElement("button", { type: "button", role: "combobox", "aria-label": label, disabled }, options.find((o) => o.value === value)?.label) },
    "@/components/ui/multi-select": { MultiSelect: ({ label, options, value, onChange }: { label: string; options: { value: string; label: string }[]; value: string[]; onChange: (next: string[]) => void }) =>
      wrap(runtime.jsx)("button", { "aria-label": label, "data-value": value.join(","), onChange: (e: { target: { value: string[] } }) => onChange(e.target.value), children: options.map((o) => o.label).join("|") }, undefined) },
    "@/lib/toast": {},
    "@/lib/utils": { cn: (...v: unknown[]) => v.filter(Boolean).join(" "), formatCurrency: (n: number) => `$${n}`, getErrorMessage: String },
    "@/lib/background-activity": { formatRelativeTime: () => "recently" },
    // Deal chat has its own test (tests/dealChat.test.ts); here it draws nothing.
    "./deal-chat": { DealChat: () => null, DealChatButton: () => null },
    // Customize mode is off: no shape context, so sections draw unwrapped.
    "./shape/shape-mode": { useShape: () => null, ShapeSection: ({ children }: { children: ReactNode }) => children },
  };
  const pageSections: Record<string, unknown> = {};
  runInNewContext(sectionsText, { exports: pageSections, require: (id: string) => stubs[id] });
  stubs["@/components/records/page-sections"] = pageSections;
  const exports: { DealPlay?: (props: { streamId: string; amount: number | null; currency: string; team: never[]; page: recipes.PageSpec; record: typeof record }) => ReactNode } = {};
  const stored = new Map<string, string>();
  const localStorage = { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => { stored.set(k, v); } };
  runInNewContext(outputText, { exports, localStorage, require: (id: string) => {
    if (Object.hasOwn(stubs, id)) return stubs[id];
    assert.equal(id, "lucide-react");
    return require(id);
  } });
  return {
    render: () => { index = 0; draftIndex = 0; return renderToStaticMarkup(createElement(exports.DealPlay!, { streamId: "deal", amount: 120000, currency: "USD", team: [], page, record })); },
    toggle: () => { assert.ok(toggle); toggle(); },
    control: (name: string) => { const props = controls.get(name); assert.ok(props, name); return props; },
    change: (name: string, value: string | boolean | string[]) => { const props = controls.get(name); assert.ok(props, name); (props.onChange as (e: unknown) => void)({ target: { value, checked: value } }); },
    stored,
    click: (name: string) => { const props = controls.get(name); assert.ok(props, name); assert.ok(!props.disabled); (props.onClick as () => void)(); },
  };
}

test("deal focuses the earliest pending step, with context and drafts closed but accessible", () => {
  const page = harness();
  const html = page.render();
  assert.match(html, /Urgent action/);
  for (const s of steps.slice(0, -1)) assert.ok(!html.includes(s.title), s.title);
  assert.match(html, /<button[^>]*>Review draft<\/button>/);
  assert.doesNotMatch(html, /Long draft body|role="dialog"/);
  assert.ok(html.indexOf("Buyer is carrying this alone.") < html.indexOf("Urgent action"), "the prep leads the page");
  assert.match(html, /Who signs\?[\s\S]*the next call asks it/);
  for (const title of ["Deal health", "Brief &amp; evidence", "People", "Activity"]) {
    assert.match(html, new RegExp(`<details(?![^>]* open)[^>]*><summary[^>]*>${title}`));
  }
  assert.ok(html.indexOf("Urgent action") < html.indexOf("Missing champion"));
  assert.match(html, /\$120000/);
  assert.match(html, /2026-12-31/);
  assert.match(html, /Owner/);
  page.toggle();
  const expanded = page.render();
  for (const s of steps) assert.ok(expanded.includes(s.title), s.title);
  assert.match(expanded, /aria-expanded="true"/);
  assert.ok(expanded.indexOf("Urgent action") < expanded.indexOf("Later action"));
  assert.ok(expanded.indexOf("Later action") < expanded.indexOf("Undated action"));
  page.toggle();
  assert.ok(!page.render().includes("Completed action"));
});

test("email drafts open in a dialog from both deal views and editing stays inside it", () => {
  // Finding the way in opens it from the person's row; building the case, from the plan.
  const row = { key: "c:person", contactId: "person", itemId: null, name: "Buyer", title: "VP Revenue", source: "deal", role: "executive", buyer: true, researched: false, why: null, reached: null, suggested: false, center: null, capability: null };
  for (const stage of ["case", "in"]) {
    const page = harness([{ ...steps[5], title: "First touch email" }], true, {
      stage, prospects: [row],
      people: [{ contactId: "person", name: "Buyer", email: "buyer@example.com", role: "executive", thread: { state: "untouched", touches: 0 } }],
    });
    assert.doesNotMatch(page.render(), /Long draft body|role="dialog"/);
    page.click("Review draft");
    const opened = page.render();
    assert.match(opened, /role="dialog"[\s\S]*Email to Buyer[\s\S]*Draft subject[\s\S]*Long draft body/);
    assert.match(opened, /All 7 checks pass[\s\S]*Point of view from the ICP Platform teams/);
    assert.match(opened, /From[\s\S]*sender@example.com[\s\S]*To[\s\S]*buyer@example.com[\s\S]*Subject[\s\S]*Draft subject[\s\S]*Long draft body[\s\S]*Send/);
    assert.match(opened, /Save to Gmail drafts/);
    assert.match(opened, /Schedule send in Gmail/);
    page.click("Edit");
    assert.match(page.render(), /role="dialog"[\s\S]*aria-label="Subject"[^>]*value="Draft subject"/);
    page.change("Subject", "Revised subject");
    page.change("Message", "Revised message");
    assert.match(page.render(), /value="Revised subject"[\s\S]*Revised message/);
    page.click("Cancel");
    assert.match(page.render(), /role="dialog"[\s\S]*Long draft body/);
    assert.doesNotMatch(page.render(), /Revised message/);

    const blank = harness([{ ...steps[5], title: "First touch email", draft: null }], true, { stage, prospects: [row] });
    assert.doesNotMatch(blank.render(), /Write it/);
    blank.click("Prepare outreach");
    assert.match(blank.render(), /role="dialog"[\s\S]*Write it/);
    blank.click("Write it");
    assert.match(blank.render(), /role="dialog"[\s\S]*aria-label="Subject"[\s\S]*aria-label="Message"/);
  }
});

test("empty and completed plans keep a path to add a next step without exposing outreach to read-only users", () => {
  assert.match(harness([]).render(), /<details[^>]* open=""><summary[^>]*>Add a step/);
  const page = harness(steps.filter((s) => s.state !== "planned" || s.doneBy));
  assert.doesNotMatch(page.render(), /Completed action/);
  page.toggle();
  assert.match(page.render(), /Completed action/);
  const readOnly = harness(steps, false).render();
  assert.doesNotMatch(readOnly, /Review draft|Prepare outreach|Add a step|Mark done"(?! disabled)/);
});

test("contact picking defaults to buyers, searches titles, and selects more than five without losing hidden picks", () => {
  const prospects = Array.from({ length: 8 }, (_, i) => ({
    key: `c:${i}`, contactId: `${i}`, itemId: null, name: `Person ${i}`, title: i === 7 ? "Engineer" : "VP Revenue",
    source: "company", role: null, buyer: i !== 7, researched: false, why: null, reached: null, suggested: false,
  }));
  const page = harness([], true, { stage: "in", prospects });
  assert.doesNotMatch(page.render(), /Person 7/);
  page.click("Select shown");
  assert.match(page.render(), /Draft first touches for 7/);
  assert.equal(page.control("Reach Person 6").disabled, false);
  page.change("Search contacts", "person 6");
  let html = page.render();
  assert.match(html, /7 picked/);
  assert.doesNotMatch(html, /Person 0/);
  page.click("Select shown");
  assert.match(page.render(), /7 picked/);
  page.change("Search contacts", "Engineer");
  assert.match(page.render(), /No contacts match/);
  page.change("ICP buyer filter", []);
  html = page.render();
  assert.match(html, /Person 7/);
  page.click("Select shown");
  assert.match(page.render(), /Draft first touches for 8/);
  page.click("Clear selection");
  assert.doesNotMatch(page.render(), /Draft first touches for/);
  const readOnly = harness([], false, { stage: "in", prospects }).render();
  assert.doesNotMatch(readOnly, /Select shown|Clear selection|Draft first touches for/);
  assert.match(readOnly, /aria-label="Reach Person 0" disabled/);
});

test("saved ICP dropdown includes inactive ICPs and filters buyers without losing picks", () => {
  const prospects = ["VP Revenue", "VP Engineering", null].map((title, i) => ({
    key: `c:${i}`, contactId: `${i}`, itemId: null, name: `Candidate ${i}`, title,
    source: "company", role: null, buyer: i === 0, researched: false, why: null, reached: null, suggested: false,
  }));
  const page = harness([], true, { stage: "in", prospects });
  let html = page.render();
  assert.match(html, /aria-label="ICP buyer filter" data-value="revenue">Revenue leaders\|Engineering leaders \(inactive\)</, "every active ICP until the person picks");
  assert.equal(page.stored.size, 0);
  page.click("Select shown");
  page.change("ICP buyer filter", ["engineering"]);
  assert.match(page.render(), /Candidate 1/);
  assert.doesNotMatch(page.render(), /Candidate 0|Candidate 2/);
  page.click("Select shown");
  assert.match(page.render(), /2 picked/);
  page.change("Search contacts", "Revenue");
  assert.match(page.render(), /No contacts match/);
  page.change("ICP buyer filter", ["revenue"]);
  assert.match(page.render(), /Candidate 0/);
  page.change("Search contacts", "");
  page.change("ICP buyer filter", ["revenue", "engineering"]);
  html = page.render();
  assert.match(html, /Candidate 0[\s\S]*Candidate 1/);
  assert.doesNotMatch(html, /Candidate 2/);
  page.change("ICP buyer filter", []);
  assert.match(page.render(), /Candidate 2/);
  assert.equal(page.stored.get("canon.deal.icpFilter"), "[]", "the pick is remembered for the next deal");
});

test("a deal nobody has replied to opens on choosing contacts and first touches", () => {
  const prospects = [
    { key: "c:a", contactId: "a", itemId: null, name: "Dana Whitfield", title: "VP Revenue Operations", source: "company", role: null, buyer: true, researched: false, why: null, reached: null, suggested: true },
    { key: "i:x", contactId: null, itemId: "x", name: "Sam Ortiz", title: "RevOps Analyst", source: "research", role: null, buyer: false, researched: true, why: "Named on the careers page", reached: null, suggested: false },
  ];
  const html = harness(steps, true, { stage: "in", prospects }).render();
  assert.match(html, /Find the way in[\s\S]*Choose who to reach first[\s\S]*First touch/);
  assert.doesNotMatch(html, /Send the first touches/, "drafts open from each person's row");
  assert.match(html, /Dana Whitfield[\s\S]*>Draft</, "someone with no first touch yet can be drafted from their row");
  assert.doesNotMatch(html, /Know who|Nobody at Example has heard|haven&#x27;t been researched/);
  assert.match(html, /Dana Whitfield[\s\S]*matches your buyer/);
  assert.doesNotMatch(html, /Named by research, not in Canon/);
  assert.match(html, /Draft first touches for 1/);
  assert.doesNotMatch(html, /Missing before it can move/, "the prep waits for the next stage");
  assert.doesNotMatch(html, /Deal health|Brief &amp; evidence|People ·|Activity ·|ranked by pairwise/, "finding the way in is the whole page");
});


test("the people list shows each person's goal, systems, remit and new capability, and researches the picked people", () => {
  const prospects = [
    { key: "c:a", contactId: "a", itemId: null, name: "Priya Raman", title: "VP Revenue Operations", source: "company", role: null, buyer: true, researched: false, why: null, reached: null, suggested: true, center: "innovation", capability: "Trust the forecast without a Friday rebuild." },
    { key: "c:b", contactId: "b", itemId: null, name: "Leo Park", title: "VP Engineering", source: "company", role: null, buyer: true, researched: false, why: null, reached: null, suggested: false, center: null, capability: null },
  ];
  const answers = {
    a: { still_at_company: { value: true, evidence: "VP Revenue Operations at Example.\n\nSource: https://example.com/priya" }, primary_goal: { value: "Rebuild forecasting after the Salesforce move" }, responsible_systems: { value: "Salesforce, HubSpot" } },
    b: { still_at_company: { value: false, evidence: "Joined Acme as CTO in May.\n\nSource: https://example.com/leo" } },
  };
  const peopleResearch = { status: "running", startedAt: 1, finishedAt: null, contactIds: ["a"], note: null };
  const page = harness([], true, { stage: "in", prospects, answers, peopleResearch });
  page.render();
  page.change("ICP buyer filter", []);
  const html = page.render();
  assert.match(html, /Primary goal[\s\S]*Responsible systems[\s\S]*New capability/);
  assert.match(html, /Priya Raman[\s\S]*Rebuild forecasting after the Salesforce move[\s\S]*Innovation center[\s\S]*Salesforce, HubSpot[\s\S]*Trust the forecast without a Friday rebuild\.[\s\S]*Yes[\s\S]*Never/);
  assert.match(html, /Researched<\/span><span>Contacted/);
  assert.match(html, /Priya Raman[\s\S]*Still at Example[\s\S]*Leo Park/);
  assert.match(html, /Leo Park[\s\S]*title="Joined Acme as CTO in May\.[\s\S]*Source: https:\/\/example\.com\/leo"[^>]*>Left Example</, "a departure shows first, with its evidence");
  assert.match(html, /Researching 1 person: goals and systems first/);
  assert.match(html, /Research 1 person/, "the picked person, not everyone shown");
  assert.match(html, /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*Research 1 person/, "one research at a time");
});

test("a person's row opens every pending step for them, and offers nothing to a read-only viewer", () => {
  const row = { key: "c:person", contactId: "person", itemId: null, name: "Buyer", title: "VP Revenue", source: "deal", role: "executive", buyer: true, researched: false, why: null, reached: null, suggested: false, center: null, capability: null };
  const people = [{ contactId: "person", name: "Buyer", email: "buyer@example.com", role: "executive", thread: { state: "untouched", touches: 0 } }];
  const pending: typeof steps = [
    { ...steps[5], id: "li", title: "First touch on LinkedIn", channel: "linkedin", draft: { body: "LinkedIn note body", by: "user", at: 1, checks: plays.drafts.check("linkedin", null, "LinkedIn note body") } as never },
    { ...steps[5], id: "em", title: "Follow-up email" },
  ];
  const page = harness(pending, true, { stage: "in", prospects: [row], people });
  assert.match(page.render(), /Review draft \(2\)/);
  page.click("Review draft (2)");
  assert.match(page.render(), /role="dialog"[\s\S]*Outreach to Buyer[\s\S]*First touch on LinkedIn[\s\S]*LinkedIn note body[\s\S]*Follow-up email[\s\S]*Long draft body/);
  const readOnly = harness(pending, false, { stage: "in", prospects: [row], people }).render();
  assert.doesNotMatch(readOnly, /Review draft|>Draft</);
});

test("the page draws its sections, the play's and the record's, in the recipe's order and folding", () => {
  const fsgtm = recipes.RECIPES["fsgtm-enterprise-deal"].dealPage;
  const pick = (c: string) => fsgtm.find((s) => s.component === c)!;
  const page: recipes.PageSpec = [
    { ...pick("fieldGrid"), when: undefined, collapsed: false }, pick("touches"), pick("plan"), { ...pick("brief"), collapsed: false }, pick("summary"),
  ];
  const html = harness(steps, true, {}, page).render();
  const at = (needle: string) => { const i = html.indexOf(needle); assert.ok(i >= 0, needle); return i; };
  const order = [at('data-record="fieldGrid"'), at("Activity · 0"), at("Next action"), at("Brief &amp; evidence"), at("Research account")];
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.match(html, /<details[^>]*><summary[^>]*>Activity · 0/);
  assert.match(html, /<section[^>]*><div[^>]*><h2[^>]*>Brief &amp; evidence/);
  assert.doesNotMatch(html, /Deal health|Choose who to reach first/);
});

test("a section's toolbar keeps the recipe's order, and a link the recipe disables goes nowhere", () => {
  const fsgtm = recipes.RECIPES["fsgtm-enterprise-deal"].dealPage;
  const page = fsgtm.map((s) => s.component === "fanOut" ? { ...s, actions: [...s.actions!].sort((a) => (a.runs === "kernel.firstTouches" ? -1 : 0)) }
    : s.component === "plan" ? { ...s, actions: s.actions!.map((a) => (a.runs === "nav.linkedinProfile" ? { ...a, enabled: "step.done" } : a)) } : s);
  const row = { key: "c:person", contactId: "person", itemId: null, name: "Buyer", title: "VP Revenue", source: "deal", role: "executive", buyer: true, researched: false, why: null, reached: null, suggested: true, center: null, capability: null };
  const people = [{ contactId: "person", name: "Buyer", linkedinUrl: "https://linkedin.example/buyer", role: "executive", thread: { state: "untouched", touches: 0 } }];
  const li = { ...steps[5], id: "li", title: "First touch on LinkedIn", channel: "linkedin", draft: { body: "LinkedIn note body", by: "user", at: 1, checks: plays.drafts.check("linkedin", null, "LinkedIn note body") } as never };
  const harnessed = harness([li], true, { stage: "in", prospects: [row], people }, page);
  const html = harnessed.render();
  assert.ok(html.indexOf("Draft first touches for 1") < html.indexOf("Research 1 person"), "first touches before research, as the recipe lists them");
  harnessed.click("Review draft");
  assert.match(harnessed.render(), /<a aria-disabled="true"[^>]*>Open LinkedIn<\/a>/);
  assert.doesNotMatch(harnessed.render(), /href="https:\/\/linkedin\.example\/buyer"[^>]*>Open LinkedIn/);
});

test("deal state renders qualification evidence, concern history and coverage with editor-only controls", () => {
  const source = { kind: "email", id: "thread", quote: "Budget is approved.", support: "buyer" };
  const state = {
    summary: "Renewal under review.", stage: { label: "Evaluation", reason: "Buyer is evaluating.", crmStage: "Proposal", mismatch: true },
    framework: "BANT+", generatedAt: 1000, completeness: { established: 1, total: 4 },
    qualification: ["established", "partial", "missing", "unknown"].map((status) => ({ key: status, label: status, group: "Budget", status, text: status, sources: status === "established" ? [source] : [] })),
    concerns: [{ key: "security", title: "Security review", kind: "risk", text: "Review is open.", raisedBy: "Buyer", firstObservedAt: 1, lastObservedAt: 2, count: 2, resolved: false, dismissed: false, sources: [source] }],
    coverage: { read: 2, total: 3, omitted: 1, partial: true, inventoryLimited: false },
  };
  const editor = harness([], true, { state });
  const html = editor.render();
  assert.match(html, /<table[\s\S]*<tbody[\s\S]*<th scope="row"/);
  assert.match(html, /Budget is approved\./);
  assert.equal((html.match(/scope="row"/g) ?? []).length, 4);
  assert.equal(editor.control("Regenerate").disabled, false);
  assert.equal(editor.control("Dismiss").disabled, false);
  const stalled = harness([], true, { state, stateRun: { status: "failed", startedAt: 1 } });
  stalled.render();
  assert.equal(stalled.control("Regenerate").disabled, false);
  const reader = harness([], false, { state });
  assert.ok(reader.render().includes(state.summary));
  assert.throws(() => reader.control("Regenerate"));
  assert.throws(() => reader.control("Dismiss"));
});
