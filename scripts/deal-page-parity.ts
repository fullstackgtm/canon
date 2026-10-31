/**
 * The button parity lever for the deal page (docs/recipes.md, "Actions"). It renders the deal play from this checkout
 * and from a git ref with the same control planes, section by section, and lists every control each section shows:
 * buttons, links, fields and folds, with their labels and whether they're disabled. The planes are fixtures that reach
 * every action (each step channel and draft state, a queued LinkedIn step, research rows, flags, items, read-only
 * viewers, a workspace without Gmail or a LinkedIn sender) at every stage, plus any plane files given.
 *
 *   node --experimental-strip-types scripts/deal-page-parity.ts                      this checkout against origin/main
 *   node --experimental-strip-types scripts/deal-page-parity.ts --ref <ref>          against another ref
 *   node --experimental-strip-types scripts/deal-page-parity.ts --plane <file.json>  also a plane read from a stack
 *   node --experimental-strip-types scripts/deal-page-parity.ts --list               print this checkout's controls
 *
 * Exits 1 when any section's controls differ.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as committee from "../convex/lib/committee.ts";
import * as drafts from "../convex/lib/plays/drafts.ts";
import * as icpGates from "../convex/lib/icpGates.ts";
import * as icps from "../convex/lib/icps.ts";
import * as model from "../convex/lib/plays/model.ts";
import * as peopleResearch from "../convex/lib/plays/peopleResearch.ts";
import * as runs from "../convex/lib/plays/runs.ts";
import * as selection from "../convex/lib/plays/prospectSelection.ts";
import * as recipes from "../recipes/index.ts";
import { readRecipeDir } from "./build-recipes.ts";

const require = createRequire(import.meta.url);
const runtime = require("react/jsx-runtime");
const ROOT = new URL("../", import.meta.url);
const DEAL_PLAY = "src/components/crm/deal-play.tsx";
const PAGE_SECTIONS = "src/components/records/page-sections.tsx";

const transpile = (source: string) => ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText;
const atRef = (ref: string, path: string): string | null => {
  try { return execFileSync("git", ["show", `${ref}:${path}`], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; }
};

type Plane = Record<string, unknown> & { stage: string; canEdit: boolean };
type World = { gmail: boolean; linkedin: boolean; allSteps?: boolean };

/** The deal play module from `sources`, with the app's imports stubbed so a plane renders without a backend. */
function load(sources: { dealPlay: string; pageSections: string | null }, world: World) {
  const savedIcps = [{ _id: "icp", name: "Revenue leaders", active: true, spec: { ...icps.emptySpec(), persona: { levels: [], departments: [], titles: ["VP Revenue"] } } }];
  const fields = recipes.defaultPlays("fsgtm-enterprise-deal")!.people.fields.map((f) => ({ ...f, options: undefined }));
  const stubs: Record<string, unknown> = {
    react: require("react"),
    "react/jsx-runtime": runtime,
    "lucide-react": require("lucide-react"),
    "@/components/ui/dialog": {
      Dialog: ({ open, children }: { open?: boolean; children: ReactNode }) => (open === false ? null : children),
      DialogTrigger: ({ children }: { children: ReactNode }) => children,
      DialogContent: ({ children }: { children: ReactNode }) => createElement("div", { role: "dialog" }, children),
      DialogHeader: ({ children }: { children: ReactNode }) => children,
      DialogTitle: ({ children }: { children: ReactNode }) => createElement("h2", {}, children),
      DialogDescription: ({ children }: { children: ReactNode }) => createElement("p", {}, children),
    },
    "next/link": { default: ({ children, href }: { children: ReactNode; href: string }) => createElement("a", { href }, children) },
    "convex/react": {
      useAction: () => () => Promise.resolve(null),
      useQuery: (query: string) => ({
        "icps.list": { icps: savedIcps }, "chatgptAuth.status": { status: "connected" }, "credits.summary": { spendable: 1000 },
        "emailAccounts.mine": { accounts: world.gmail ? [{ _id: "mail", status: "ok", address: "rep@example.com" }] : [] },
        "linkedin.mine": { account: world.linkedin ? { _id: "li", status: "ok", profileName: "Rep" } : null },
      } as Record<string, unknown>)[query],
    },
    "../../../convex/_generated/api": { api: new Proxy({}, { get: (_, mod: string) => new Proxy({}, { get: (__, fn: string) => `${mod}.${fn}` }) }) },
    "../../../convex/lib/committee": committee,
    "../../../convex/lib/plays/model": model,
    "../../../convex/lib/plays/drafts": drafts,
    "../../../convex/lib/plays/prospectSelection": selection,
    "../../../convex/lib/icps": icps,
    "../../../convex/lib/icpGates": icpGates,
    "../../../convex/lib/plays/peopleResearch": peopleResearch,
    "../../../convex/lib/plays/runs": runs,
    "../../../recipes": recipes,
    "@/components/research/ai-cell": {
      useContactAiFields: () => fields, useContactAnswers: () => ({}),
      AiCell: ({ answer }: { answer?: { value: string } }) => answer?.value ?? "—",
      quoteAndSource: (evidence: string | null) => ({ quote: evidence, url: null }),
    },
    "@/components/records/lookup-field": { recordHref: (object: string, id: string) => `/${object}/${id}` },
    "@/components/ui/select": { SelectField: ({ options, value, disabled, "aria-label": label }: { options: Array<{ value: string; label: string }>; value: string; disabled?: boolean; "aria-label"?: string }) =>
      createElement("select", { "aria-label": label, disabled, value, onChange: () => {} }, options.map((o) => createElement("option", { key: o.value, value: o.value }, o.label))) },
    "@/components/ui/multi-select": { MultiSelect: ({ label }: { label: string }) => createElement("button", { type: "button", "aria-label": label }) },
    "@/lib/toast": { toast: {} },
    "@/lib/utils": { cn: (...v: unknown[]) => v.filter(Boolean).join(" "), formatCurrency: (n: number) => `$${n}`, getErrorMessage: String },
    "@/lib/background-activity": { formatRelativeTime: () => "recently" },
  };
  const run = (text: string) => {
    const exports: Record<string, unknown> = {};
    runInNewContext(transpile(text), { exports, require: (id: string) => {
      if (!Object.hasOwn(stubs, id)) throw new Error(`deal play imports ${id}, which the lever doesn't stub`);
      return stubs[id];
    } });
    return exports;
  };
  if (sources.pageSections) stubs["@/components/records/page-sections"] = run(sources.pageSections);
  return run(sources.dealPlay) as { DealPlay: (props: Record<string, unknown>) => ReactNode };
}

/** The deal play rendered on `plane`, its first state the plane: the play loads before anything shows. */
function render(mod: ReturnType<typeof load>, plane: Plane, page: recipes.PageSpec, world: World): string {
  const React = require("react");
  const real = React.useState;
  let first = true;
  React.useState = (initial: unknown) => {
    if (first) { first = false; return [plane, () => {}]; }
    const stack = new Error().stack ?? "";
    if (stack.includes("at DealQueue (")) return [QUEUE, () => {}];
    if (world.allSteps && initial === false && stack.includes("at Plan (")) return [true, () => {}];
    return real(initial);
  };
  try {
    const record = Object.fromEntries(recipes.RECORD_COMPONENTS.map((c) => [c, () => null]));
    return renderToStaticMarkup(createElement(mod.DealPlay, { streamId: String(plane.streamId), team: [{ _id: "u1", name: "Rep" }], page, sections: page, record }));
  } finally {
    React.useState = real;
  }
}

/** The caller's open deals, as the queue reads them once dealPlays.list answers. */
const QUEUE = [
  { streamId: "deal", name: "This deal", isClosed: false, mine: true, health: "needs_attention", windowDays: 48, windowLabel: "RFP", summary: null },
  { streamId: "next", name: "Beta deal", isClosed: false, mine: true, health: "at_risk", windowDays: 12, windowLabel: null, summary: { repliesOwed: 1 } },
];

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? null;

/** Every control in `html`, in order: its kind, its accessible name, and whether it's disabled. */
function controls(html: string): string[] {
  const out: string[] = [];
  const re = /<(button|a|summary|select|input|textarea)\b([^>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const [open, tag, rest] = m;
    const close = ["button", "a", "summary", "select", "textarea"].includes(tag) ? html.indexOf(`</${tag}>`, m.index) : -1;
    const inner = close > 0 ? html.slice(m.index + open.length, close) : "";
    const name = attr(rest, "aria-label") ?? (tag === "select" ? "" : text(inner.replace(/<option[\s\S]*?<\/option>/g, "")));
    const kind = tag === "input" ? `input[${attr(rest, "type") ?? "text"}]` : tag;
    out.push(`${kind} "${name}"${/\sdisabled=""/.test(rest) ? " disabled" : ""}`);
  }
  return out;
}

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-13T12:00:00Z");
const thread = (state: string, touches = 0) => ({ state, touches, lastOut: touches ? NOW - 2 * DAY : null, lastIn: state === "replied" ? NOW - DAY : null, lastChannel: touches ? "email" : null });
const checks = (channel: model.Channel, subject: string | null, body: string) => recipes.defaultPlays("fsgtm-enterprise-deal")!.drafts.check(channel, subject, body);
const step = (id: string, channel: model.Channel, targetId: string, extra: Record<string, unknown> = {}) => ({
  id, title: `Step ${id}`, channel, state: "planned", targetId, contactId: targetId, role: null, ownerUserId: null, origin: "user", doneBy: null, draft: null, dueOn: "2026-10-20", queuedAt: null, ...extra,
});
const keeperDraft = (channel: model.Channel, subject: string | null, body: string) => ({ subject: subject ?? undefined, body, by: "keeper", at: NOW, checks: checks(channel, subject, body) });

/** A rich plane: people with and without email or LinkedIn, research rows, flags with and without a proposed step, items. */
function basePlane(): Plane {
  const people = [
    { contactId: "ana", name: "Ana Ruiz", title: "VP Revenue", email: "ana@example.com", linkedinUrl: "https://linkedin.com/in/ana", role: "champion", thread: thread("waiting", 2), atCompany: true, persona: null, angle: null, reportsTo: null, confidence: null },
    { contactId: "bo", name: "Bo Chen", title: "CFO", email: null, linkedinUrl: null, role: "executive", thread: thread("untouched"), atCompany: true, persona: "Owns the budget", angle: null, reportsTo: null, confidence: "high" },
  ];
  return {
    streamId: "deal", canEdit: true, started: true, stage: "case",
    recipe: { id: "fsgtm-enterprise-deal", settings: recipes.RECIPES["fsgtm-enterprise-deal"].settings },
    recipeData: { stages: recipes.defaultPlays("fsgtm-enterprise-deal")!.stages, peopleFields: recipes.defaultPlays("fsgtm-enterprise-deal")!.people.fields, peopleSlugs: recipes.defaultPlays("fsgtm-enterprise-deal")!.people.slugs },
    deal: { companyId: "acme", companyName: "Acme", domain: "acme.com", amount: 50000, currency: "USD", ownerName: "Rep", closeDate: "2026-12-01" },
    brief: { context: "ICM", whyNow: null, alphaHypothesis: null, alphaPitch: null, windowLabel: "RFP", windowClosesOn: "2026-11-30", briefBy: "research" },
    research: { status: "done", finishedAt: NOW - DAY, searches: 3, pages: 5, kept: 4, dropped: 1 }, peopleResearch: null, keeperCheck: { at: NOW - DAY, drafted: 1 },
    keeper: { health: "needs_attention", windowDays: 48, flags: [
      { key: "a", severity: "high", text: "No signer named", propose: { title: "Ask who signs", channel: "email", contactId: "ana" } },
      { key: "b", severity: "medium", text: "Single-threaded" },
    ] },
    people, steps: [],
    items: [
      { id: "i1", kind: "signal", text: "Hiring three comp analysts", quote: "three comp analysts", sourceUrl: "https://acme.com/jobs", evidence: "verified", occurredOn: "2026-10-01", person: null },
      { id: "i2", kind: "gap", text: "Who runs sales comp?", sourceUrl: "https://acme.com/team", person: { name: "Dee Park", title: "Comp Lead", role: "user" } },
      { id: "i3", kind: "gap", text: "Someone in finance systems", person: { name: "Eli Fox", title: null, role: null } },
      { id: "i4", kind: "risk", text: "Incumbent renewal in Q1", person: null },
    ],
    others: [{ id: "cy", name: "Cy Ode", title: "Engineer" }],
    suggested: [{ contactId: "cy", name: "Cy Ode", title: "Engineer", role: "user", angle: null }],
    touches: [{ at: NOW - DAY, contactId: "ana", direction: "out", summary: "Email sent" }],
    pointOfView: { icpId: "icp", icpName: "Revenue leaders", text: "Routing, not volume." },
    prospects: [
      { key: "c:ana", contactId: "ana", itemId: null, name: "Ana Ruiz", title: "VP Revenue", source: "deal", role: "champion", buyer: true, researched: true, why: null, reached: "waiting", suggested: true, center: null, capability: null },
      { key: "c:bo", contactId: "bo", itemId: null, name: "Bo Chen", title: "VP Revenue Finance", source: "deal", role: "executive", buyer: false, researched: false, why: null, reached: null, suggested: false, center: null, capability: null },
      { key: "c:cy", contactId: "cy", itemId: null, name: "Cy Ode", title: "VP Revenue Engineering", source: "company", role: null, buyer: false, researched: false, why: null, reached: null, suggested: false, center: null, capability: null },
      { key: "i:i2", contactId: null, itemId: "i2", name: "Dee Park", title: "VP Revenue Comp", source: "research", role: null, buyer: false, researched: true, why: "Named on the team page", reached: null, suggested: false, center: null, capability: null },
    ],
    prep: { verdict: "Ana is carrying this alone.", stall: null, questions: [], checks: [{ key: "signer", label: "We know who signs", ok: false, evidence: "Nobody named." }], answers: [] },
  };
}

/** The step a plan leads with, one per draft state, each for Ana (email and LinkedIn on file) or Bo (neither). */
const STEP_CASES: Record<string, ReturnType<typeof step>[]> = {
  "email, keeper draft": [step("e1", "email", "ana", { draft: keeperDraft("email", "plan sprawl", "Hi Ana,\n\nYour team posted three roles.\nWant the teardown?\n\nRyan") })],
  "email, draft without subject": [step("e2", "email", "ana", { draft: { body: "Hi Ana, a note.", by: "user", at: NOW, checks: checks("email", null, "Hi Ana, a note.") } })],
  "email, no address": [step("e3", "email", "bo", { draft: keeperDraft("email", "budget", "Hi Bo, a note.") })],
  "email, no draft": [step("e4", "email", "ana")],
  "linkedin, keeper draft": [step("l1", "linkedin", "ana", { draft: keeperDraft("linkedin", null, "Ana, routing beats volume. Worth a look?") })],
  "linkedin, queued": [step("l2", "linkedin", "ana", { queuedAt: NOW - DAY, draft: keeperDraft("linkedin", null, "Ana, a note.") })],
  "linkedin, no profile": [step("l3", "linkedin", "bo", { draft: keeperDraft("linkedin", null, "Bo, a note.") })],
  "call, no draft": [step("c1", "call", "ana")],
  "meeting, no draft": [step("m1", "meeting", "ana")],
  "done by touch": [step("d1", "email", "ana", { doneBy: { at: NOW - DAY } }), step("d2", "email", "bo", { state: "done" })],
  "no steps": [],
};

type Scenario = { name: string; plane: Plane; world: World };

function scenarios(planeFiles: readonly string[]): Scenario[] {
  const out: Scenario[] = [];
  const worlds: Array<[string, World]> = [
    ["Gmail and LinkedIn linked", { gmail: true, linkedin: true }], ["nothing linked", { gmail: false, linkedin: false }],
    ["every step shown", { gmail: true, linkedin: true, allSteps: true }],
  ];
  for (const [steps, plan] of Object.entries(STEP_CASES)) {
    for (const [w, world] of worlds) {
      for (const canEdit of [true, false]) {
        for (const stage of model.DEAL_STAGES) out.push({ name: `${steps} · ${w} · ${canEdit ? "editor" : "viewer"} · ${stage}`, plane: { ...basePlane(), steps: plan, canEdit, stage }, world });
      }
    }
  }
  const quiet: Plane = { ...basePlane(), research: null, started: false, others: [], suggested: [], items: [], keeper: { health: "on_track", windowDays: null, flags: [] }, deal: { ...(basePlane().deal as object), companyId: null } };
  for (const stage of model.DEAL_STAGES) out.push({ name: `no company, no research · ${stage}`, plane: { ...quiet, stage }, world: worlds[0][1] });
  const running: Plane = { ...basePlane(), research: { status: "running" }, peopleResearch: { status: "running", startedAt: NOW, finishedAt: null, contactIds: ["ana"], note: null } };
  for (const stage of model.DEAL_STAGES) out.push({ name: `research running · ${stage}`, plane: { ...running, stage }, world: worlds[0][1] });
  for (const file of planeFiles) {
    const plane = JSON.parse(readFileSync(file, "utf8")) as Plane;
    for (const [w, world] of worlds) for (const stage of model.DEAL_STAGES) out.push({ name: `${file.split("/").at(-1)} · ${w} · ${stage}`, plane: { ...plane, stage }, world });
  }
  return out;
}

/** Each play section of `page` alone, the rest kept in the page but hidden, so a panel finds its actions. */
function alone(page: recipes.PageSpec, i: number): recipes.PageSpec {
  return page.map((s, j) => (j === i ? s : { ...s, when: { stage: [] } }));
}

type Report = Map<string, string[]>;

function report(sources: { dealPlay: string; pageSections: string | null }, page: recipes.PageSpec, list: Scenario[]): Report {
  const out: Report = new Map();
  const mods = new Map<string, ReturnType<typeof load>>();
  for (const sc of list) {
    const key = JSON.stringify(sc.world);
    if (!mods.has(key)) mods.set(key, load(sources, sc.world));
    const mod = mods.get(key)!;
    page.forEach((section, i) => {
      if (!(recipes.PLAY_COMPONENTS as readonly string[]).includes(section.component)) return;
      const html = render(mod, sc.plane, alone(page, i), sc.world);
      const shown = text(html).length > 0 || controls(html).length > 0;
      const folded = /^(<div[^>]*>)*<details/.test(html);
      out.set(`${sc.name} · ${section.title ?? section.component}`, shown ? [folded ? "(folded)" : "(open)", ...controls(html)] : ["(hidden)"]);
    });
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const ref = args.includes("--ref") ? args[args.indexOf("--ref") + 1] : "origin/main";
  const planeFiles = args.flatMap((a, i) => (a === "--plane" ? [args[i + 1]] : []));
  const list = scenarios(planeFiles);
  const head = { dealPlay: readFileSync(new URL(DEAL_PLAY, ROOT), "utf8"), pageSections: readFileSync(new URL(PAGE_SECTIONS, ROOT), "utf8") };
  const velocity = (await readRecipeDir(new URL("../recipes/fsgtm-velocity-deal", import.meta.url).pathname)).recipe.dealPage;
  const pages: Array<[string, recipes.PageSpec]> = [["FSGTM enterprise", recipes.RECIPES["fsgtm-enterprise-deal"].dealPage], ["FSGTM velocity", velocity]];
  if (args.includes("--list")) {
    for (const [name, page] of pages) for (const [k, v] of report(head, page, list)) console.log(`${name} · ${k}\n  ${v.join("\n  ")}`);
    return;
  }
  const base = { dealPlay: atRef(ref, DEAL_PLAY)!, pageSections: atRef(ref, PAGE_SECTIONS) };
  if (!base.dealPlay) throw new Error(`${ref} has no ${DEAL_PLAY}`);
  let differ = 0, same = 0, controlsSeen = 0;
  for (const [name, page] of pages) {
    const a = report(base, page, list), b = report(head, page, list);
    const ids = new Set<string>();
    for (const [k, v] of a) {
      const w = b.get(k) ?? ["(missing)"];
      for (const c of v) if (c.startsWith("button") || c.startsWith("a ")) ids.add(c.replace(/ disabled$/, ""));
      controlsSeen += v.length;
      if (JSON.stringify(v) === JSON.stringify(w)) { same++; continue; }
      differ++;
      if (differ <= 20) console.log(`${name} · ${k}\n  ${ref}: ${v.join(" | ")}\n  head: ${w.join(" | ")}`);
    }
    console.log(`${name}: ${a.size} section renders (${list.length} planes × ${page.filter((s) => (recipes.PLAY_COMPONENTS as readonly string[]).includes(s.component)).length} play sections), ${ids.size} distinct buttons and links`);
  }
  console.log(`\n${same} section renders the same, ${differ} differ, ${controlsSeen} controls compared against ${ref}.`);
  if (differ) process.exit(1);
}

await main();
