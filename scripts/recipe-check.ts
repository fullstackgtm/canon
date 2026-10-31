/**
 * The recipe equivalence lever (docs/recipes.md, "Writing a recipe"). tests/fixtures/recipe-equivalence.json is a
 * frozen snapshot of what the FSGTM play code on origin/main returned before its recipes became markdown: the calls
 * from tests/dealPlays.test.ts, both recipes' evals, twelve deal page batches and a seeded random sweep, each run on
 * the enterprise defaults, the Velocity defaults and an altered set. This checks that the markdown recipes (FSGTM on
 * markdown and TypeScript, Velocity on markdown and Canon's built-ins) still return the same thing for every call.
 *
 *   node --experimental-strip-types scripts/recipe-check.ts                  compare in-process
 *   node --experimental-strip-types scripts/recipe-check.ts --url <runtime>  compare through the recipe runtime, and time it
 *   node --experimental-strip-types scripts/recipe-check.ts --capture        rewrite the fixture from the code in force
 *
 * --capture blesses whatever the code returns now, so run it only for a change meant to alter behaviour.
 * The runtime secret comes from RECIPE_RUNTIME_SECRET, else the local stack's .devstack/recipe-runtime/.dev.vars or
 * services/recipe-runtime/.dev.vars, never from argv. Exits 1 when any call differs.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEAL_ROLES, type DealRole } from "../convex/lib/objects/registry.ts";
import { threadOf, type Channel, type Prospect, type StepState, type Touch } from "../convex/lib/plays/model.ts";
import type { DraftInput } from "../convex/lib/plays/drafts.ts";
import { peopleResearchDue } from "../convex/lib/plays/peopleResearch.ts";
import { briefSchema, draftInputOf, draftSchema, firstTouchChannel, planSchema, researchDue, researchLimits, reviewSchema, scheduledBuyers } from "../convex/lib/plays/runs.ts";
import { runPlays, runSettled, type Target } from "../convex/lib/recipeRuntime.ts";
import { BUILTINS_BUNDLE, RECIPE_BUNDLES } from "../recipes/_bundles.generated.ts";
import { markdownBundle, recipeOf } from "../recipes/compose.ts";
import { DEAL_FRAME, RECIPES, firstPartyCode, refOf, type PlayCode, type RecipeDefinition, type RecipeRef, type Settings } from "../recipes/index.ts";
import { MODEL_POINTS, isModelPoint } from "../recipes/models.ts";
import { runCalls, type CallResult, type PlayCall } from "../recipes/run.ts";
import { bundleHash } from "../services/recipe-runtime/src/protocol.ts";
import { readRecipeDir } from "./build-recipes.ts";

export const FIXTURE_FILE = fileURLToPath(new URL("../tests/fixtures/recipe-equivalence.json", import.meta.url));

const DAY = 86_400_000;

/** A seeded PRNG (mulberry32): the same seed gives the same calls. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PAGE_NOW = Date.parse("2026-10-13T15:00:00Z");
const FIRST = ["Priya", "Marcus", "Dana", "Amanda", "Luis", "Kenji", "Sofia", "Omar", "Grace", "Tomas"];
const LAST = ["Shah", "Reed", "Okafor", "Lind", "Moreno", "Ito", "Brandt", "Haddad", "Kim", "Novak"];
const TITLES = ["VP Revenue Operations", "Chief Revenue Officer", "Director of Sales Ops", "Head of Finance Systems", "CFO", "Comp Analyst", "RevOps Manager", "Procurement Lead"];
const PAGE_CHANNELS: Channel[] = ["email", "linkedin", "call", "meeting"];
const PAGE_DRAFTS = [
  { channel: "email" as Channel, subject: "plan sprawl", body: "Hi Amanda,\n\nYour team posted three comp analyst roles this quarter.\nMost of that work is chasing plan exceptions, not math.\nWe wrote up how two RevOps teams cut it in half.\nWant me to send it?\n\nRyan" },
  { channel: "email" as Channel, subject: "", body: `Hi Priya,\n\n${"We are better than Relay. ".repeat(5)}What keeps you up at night? Can we talk?\n\nRyan` },
  { channel: "linkedin" as Channel, subject: null, body: "Our platform automates commissions. Want a demo?" },
  { channel: "call" as Channel, subject: null, body: "Open: their Q3 plan change.\n- Is it measured today?\n- What have they tried?\nClose: book the next call and ask who else should join." },
];

/** A deal page's runtime batch as buildPlane sends it (convex/dealPlays.ts), for a generated deal on `recipe`. */
export function dealPageBatch(seed: number, recipe: RecipeDefinition = RECIPES["fsgtm-enterprise-deal"], bundle: RecipeRef["bundle"] = null): { ref: RecipeRef; calls: PlayCall[] } {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  // Every third deal runs on a workspace's edited settings.
  const settings = seed % 3 === 2 ? { ...recipe.settings, quietDays: 7, emailMaxWords: 60, coreRoles: ["champion", "signer"] } : recipe.settings;
  const quietDays = settings.quietDays as number;
  const people = Array.from({ length: 2 + Math.floor(r() * 6) }, (_, i) => {
    const contactId = `c${i}`;
    const touches: Touch[] = Array.from({ length: Math.floor(r() * 5) }, () => ({
      contactId, channel: pick(PAGE_CHANNELS), direction: pick(["out", "out", "in", "both"] as const), at: PAGE_NOW - Math.floor(r() * 40) * DAY, summary: "a touch",
    }));
    return { contactId, name: `${pick(FIRST)} ${pick(LAST)}`, title: pick(TITLES), role: pick(DEAL_ROLES) as DealRole, thread: threadOf(touches, PAGE_NOW, quietDays), persona: r() < 0.5 ? "Owns the comp plan" : null, angle: r() < 0.3 ? "Plan exceptions" : null };
  });
  const steps = Array.from({ length: Math.floor(r() * 5) }, (_, i) => ({
    id: `s${i}`, title: `Touch ${i}`, channel: pick(PAGE_CHANNELS), contactId: pick(people).contactId, role: null, dueOn: new Date(PAGE_NOW + (Math.floor(r() * 20) - 8) * DAY).toISOString().slice(0, 10),
    state: pick(["planned", "planned", "done", "skipped"] as StepState[]), createdAt: PAGE_NOW - 30 * DAY, doneByTouch: r() < 0.2,
  }));
  const icps = [
    { id: "icp-a", name: "Platform teams", pointOfView: "Most plan disputes come from routing, not math.", offer: "A teardown of one plan", isDefault: r() < 0.5, createdAt: 1, buyer: null },
    { id: "icp-b", name: "Finance-led", pointOfView: null, offer: null, isDefault: false, createdAt: 2, buyer: null },
  ];
  const icpIds = icps.filter(() => r() < 0.6).map((i) => i.id);
  const windowClosesOn = r() < 0.6 ? new Date(PAGE_NOW + (Math.floor(r() * 90) - 10) * DAY).toISOString().slice(0, 10) : null;
  const rows = (buyerTitle: string | null): Array<Omit<Prospect, "suggested">> => people.map((p) => ({
    key: `c:${p.contactId}`, contactId: p.contactId, itemId: null, name: p.name, title: p.title, source: "deal", role: p.role,
    buyer: buyerTitle !== null && p.title.includes(buyerTitle), researched: Boolean(p.persona || p.angle), why: p.angle ?? p.persona,
    reached: p.thread.touches > 0 ? p.thread.state : null, center: null, capability: null,
  }));
  const variants = icpIds.length ? icpIds.map((id) => (id === "icp-a" ? "Revenue" : "Finance")) : [null];
  const drafts = PAGE_DRAFTS.filter(() => r() < 0.6);
  const draftInput: DraftInput = {
    channel: "email", stepTitle: "First touch", company: "Northstar", context: "Commission plans", whyNow: null, alphaPitch: null,
    person: { name: people[0].name, title: people[0].title, role: "Champion", persona: people[0].persona, angle: people[0].angle },
    pointOfView: { icp: "Platform teams", text: icps[0].pointOfView! }, offer: icps[0].offer, openQuestions: [], facts: [{ text: "Hiring three comp analysts", quote: null }], history: [], sender: "Ryan",
  };
  return {
    ref: refOf(recipe, settings, bundle),
    calls: [
      { fn: "pointOfView", input: [icpIds, icps] },
      { fn: "keeper", input: [{ now: PAGE_NOW, hasCompany: r() < 0.9, windowClosesOn, windowLabel: r() < 0.5 ? "The RFP" : null, members: people, steps, researchedAt: r() < 0.5 ? PAGE_NOW - Math.floor(r() * 60) * DAY : null, hasBrief: r() < 0.5 }] },
      { fn: "stage", input: [{ probability: Math.round(r() * 10) / 10, members: people }] },
      { fn: "prep", with: { windowDays: { call: 1, field: "windowDays" } }, input: [{ now: PAGE_NOW, company: "Northstar", dealName: "Northstar ICM", windowLabel: null, windowDays: null, hasWhyNow: r() < 0.5, members: people, steps }] },
      ...variants.map((title): PlayCall => ({ fn: "fanOut", input: [rows(title)] })),
      ...drafts.map((d): PlayCall => ({ fn: "drafts.check", input: [d.channel, d.subject, d.body] })),
      { fn: "drafts.prompt", input: [draftInput] },
    ],
  };
}

/** Seeded random calls that reach every branch of the rules, the checks and the prompts. */
function randomCalls(n: number): PlayCall[] {
  const r = rng(0x5eed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const maybe = <T>(x: T, p = 0.5): T | null => (r() < p ? x : null);
  const some = <T>(max: number, f: (i: number) => T) => Array.from({ length: Math.floor(r() * (max + 1)) }, (_, i) => f(i));
  const NOW = Date.parse("2026-10-11T12:00:00Z");
  const NAMES = ["Dana Reyes", "Sam Ortiz", "Priya Raman", "Marcus Webb", "Lee", "Ana de la Cruz", "Tim"];
  const CHANNELS = ["linkedin", "email", "call", "meeting", "task", "other"] as const;
  const iso = (days: number) => new Date(NOW + days * DAY).toISOString().slice(0, 10);
  const thread = () => ({ state: pick(["untouched", "waiting", "replied", "engaged", "quiet"] as const), lastOut: maybe(NOW - Math.floor(r() * 40) * DAY), lastIn: maybe(NOW - Math.floor(r() * 40) * DAY, 0.4), lastChannel: maybe(pick(CHANNELS)), touches: Math.floor(r() * 4) });
  const member = (i: number) => ({ contactId: `c${i}`, name: pick(NAMES), role: pick(DEAL_ROLES), thread: thread() });
  const step = (i: number) => ({ id: `s${i}`, title: `Step ${i}`, channel: pick(CHANNELS), contactId: maybe(`c${i}`), dueOn: maybe(iso(Math.floor(r() * 20) - 10), 0.8), state: pick(["planned", "planned", "done", "skipped"] as const), createdAt: NOW - 5 * DAY, doneByTouch: r() < 0.2 });
  const SENTENCES = ["Your team pays placement fees by hand each month.", "Most firms that size lose a day to it.", "We are better than Relay.", "Our platform automates it.", "My view is that it's the plans; not the math.", "What keeps you up at night?", "Want me to send it?", "Can we book the next call?", "How are you measuring or managing that work today, and have you tried a hire, a tool, or neither of those?", "I believe this matters.", "It's on your calendar."];
  const body = () => [pick(["Hi Dana,", "Hello Sam,", "Dana,", ""]), some(6, () => pick(SENTENCES)).join(r() < 0.5 ? " " : "\n"), pick(["Ryan", "", "Thanks, Ryan"])].filter(Boolean).join("\n\n");
  const pov = () => maybe({ icp: pick(["Platform", "RevOps"]), text: pick(["Most alert noise comes from routing.", "Comp plans break at quarter end.\nEvery time."]) }, 0.6);
  const draftInput = () => ({
    channel: pick(CHANNELS), stepTitle: pick(["First touch: Dana", "Follow up"]), company: pick(["Atlas", "Northwind"]), context: pick([null, "", "  ", "ICM for a comp transition"]),
    whyNow: maybe("New CRO"), alphaPitch: maybe("Lead with ramp."), person: { name: pick(NAMES), title: pick([null, "", "VP Sales Ops"]), role: pick(["Champion", "Executive"]), persona: maybe("Cares about ramp"), angle: maybe("Open with quota") },
    pointOfView: pov(), offer: pick([null, undefined, "", "a sample payout example"]), facts: some(3, () => ({ text: "Hiring comp analysts", quote: maybe("hiring five analysts") })),
    ...(r() < 0.7 ? { openQuestions: some(3, (i) => `Question ${i}?`) } : {}), history: some(3, () => ({ summary: "Email sent", direction: pick(["out", "in", "both"] as const), daysAgo: Math.floor(r() * 3) })), sender: "Ryan",
  });
  const subject = () => ({ company: pick(["Atlas", "Northstar"]), domain: "atlas.example", dealName: "Platform Expansion", context: pick([null, "", "ICM"]), people: some(3, () => ({ name: pick(NAMES), title: maybe("CRO"), role: maybe(pick(DEAL_ROLES)) })), questions: some(3, (i) => `Q${i}?`) });
  const prospect = (i: number) => ({ key: `k${i}`, contactId: maybe(`c${i}`, 0.8), itemId: null, name: pick(NAMES), title: maybe("VP"), source: pick(["deal", "company", "research"] as const), role: maybe(pick(DEAL_ROLES)), buyer: r() < 0.5, researched: r() < 0.5, why: null, reached: maybe("Waiting", 0.3), center: null, capability: null });
  const one = (): PlayCall => {
    switch (pick(["keeper", "prep", "stage", "fanOut", "pointOfView", "drafts.prompt", "drafts.reviewPrompt", "drafts.check", "research.planPrompt", "research.briefPrompt", "people.productContext", "people.capability.prompt", "people.capability.clean"] as const)) {
      case "keeper": return { fn: "keeper", input: [{ now: NOW, hasCompany: r() < 0.8, windowClosesOn: maybe(iso(Math.floor(r() * 90) - 20)), windowLabel: maybe("ICM RFP"), members: some(4, member), steps: some(3, step), researchedAt: maybe(NOW - Math.floor(r() * 60) * DAY), hasBrief: r() < 0.5 }] } as PlayCall;
      case "prep": return { fn: "prep", input: [{ now: NOW, company: maybe("Atlas", 0.8), dealName: "X", members: some(4, member), steps: some(3, step), windowLabel: maybe("Budget lock"), windowDays: maybe(Math.floor(r() * 60) - 5), hasWhyNow: r() < 0.5 }] } as PlayCall;
      case "stage": return { fn: "stage", input: [{ probability: maybe(r()), members: some(3, () => ({ thread: thread() })) }] } as PlayCall;
      case "fanOut": return { fn: "fanOut", input: [some(6, prospect)] } as PlayCall;
      case "pointOfView": { const icps = some(3, (i) => ({ id: `i${i}`, name: `ICP ${i}`, pointOfView: pick([null, " ", "Routing."]), offer: pick([null, undefined, "a sample"]), isDefault: r() < 0.3, createdAt: i })); return { fn: "pointOfView", input: [icps.filter(() => r() < 0.6).map((i) => i.id), icps] } as PlayCall; }
      case "drafts.prompt": return { fn: "drafts.prompt", input: [draftInput()] } as PlayCall;
      case "drafts.reviewPrompt": return { fn: "drafts.reviewPrompt", input: [draftInput(), { ...(r() < 0.5 ? { subject: "fee payouts" } : {}), body: body() }] } as PlayCall;
      case "drafts.check": return { fn: "drafts.check", input: [pick(CHANNELS), pick([null, "", "placement fee payouts", "a much longer subject line that runs past the limit here"]), body()] } as PlayCall;
      case "research.planPrompt": return { fn: "research.planPrompt", input: [subject(), 2026] } as PlayCall;
      case "research.briefPrompt": return { fn: "research.briefPrompt", input: [subject(), Array.from({ length: 1 + Math.floor(r() * 3) }, (_, i) => ({ url: `https://a.example/${i}`, text: "Page text\n\nwith paragraphs.", links: [], ...(r() < 0.3 ? { snippet: true } : {}) })), "2026-10-11"] } as PlayCall;
      case "people.productContext": return { fn: "people.productContext", input: [{ context: pick([null, "", "  ", "ICM"]) }, maybe({ icpName: "Platform", text: pick([null, "Routing."]), offer: pick([null, "a sample"]) })] } as PlayCall;
      case "people.capability.prompt": return { fn: "people.capability.prompt", input: [{ company: "Atlas", product: "ICM\nfor comp", people: Array.from({ length: 1 + Math.floor(r() * 3) }, (_, i) => ({ contactId: `c${i}`, name: pick(NAMES), title: maybe("VP"), goal: maybe("Cut ramp"), systems: maybe("Salesforce") })) }] } as PlayCall;
      case "people.capability.clean": return { fn: "people.capability.clean", input: [pick([null, {}, { people: [{ contactId: "c0", capability: "  New   capability " }, { contactId: "c9", capability: "x" }, { contactId: "c1", capability: "y".repeat(500) }, { contactId: "c2" }] }]), ["c0", "c1", "c2"]] } as PlayCall;
    }
  };
  return Array.from({ length: n }, one);
}

/** The inputs tests/dealPlays.test.ts runs through the recipe, as play calls. */
function testCalls(): PlayCall[] {
  const T = Date.parse("2026-10-11T12:00:00Z");
  const th = (state: string, lastOut: number | null, lastIn: number | null, touches: number, lastChannel: string | null = null) => ({ state, lastOut, lastIn, lastChannel, touches });
  return [
    { fn: "keeper", input: [{ now: T, hasCompany: true, windowClosesOn: "2026-11-15", windowLabel: "ICM RFP", researchedAt: null, hasBrief: true,
      members: [{ contactId: "cro", name: "Dana", role: "executive", thread: th("waiting", T - 3 * DAY, null, 1, "linkedin") }, { contactId: "ops", name: "Lee", role: "n1", thread: th("replied", T - 6 * DAY, T - DAY, 2, "linkedin") }],
      steps: [{ id: "s1", title: "Pre-demo", channel: "meeting", state: "planned", dueOn: "2026-10-01", createdAt: T - 20 * DAY, doneByTouch: false }] }] },
    { fn: "drafts.check", input: ["email", "For Marcus", "Hi Priya,\n\nMarcus wants pages halved next year. Your pilot cut alerts 38%.\nWould 20 minutes with him next week help?\n\nRyan"] },
    { fn: "drafts.check", input: ["email", "", `Hi Priya,\n\n${"We are better than Relay. ".repeat(5)}What keeps you up at night? Can we talk?\n\nRyan`] },
    { fn: "drafts.check", input: ["call", null, "Open: hi.\n- Is it measured?\nClose: book the next call."] },
    { fn: "drafts.check", input: ["linkedin", null, "Our platform automates commissions. Want a demo?"] },
    { fn: "drafts.check", input: ["email", "plan sprawl", "Hi Amanda,\n\nMy view is that the hard part isn't the math; it's the plans.\nHow are you measuring or managing that work today, and have you tried a hire, a tool, or neither?\n\nRyan"] },
    ...[["a", "b"], ["a"], []].map((ids) => ({ fn: "pointOfView", input: [ids, [{ id: "a", name: "Old", pointOfView: "Routing, not volume.", isDefault: false, createdAt: 1 }, { id: "b", name: "Default", pointOfView: null, isDefault: true, createdAt: 2 }]] })),
    ...[{ icp: "Platform", text: "Most alert noise comes from routing." }, null].flatMap((p) => ["email", "call"].map((channel) => ({ fn: "drafts.prompt", input: [{ channel, stepTitle: "Arm Priya", company: "Atlas", context: null, whyNow: null, alphaPitch: null, person: { name: "Priya", title: "Director", role: "Champion", persona: null, angle: null }, pointOfView: p, facts: [], history: [], sender: "Ryan" }] }))),
    { fn: "prep", input: [{ now: T, company: "Atlas", dealName: "Platform Expansion", windowLabel: "Budget lock", windowDays: 19, hasWhyNow: true, steps: [],
      members: [{ name: "Priya Raman", role: "champion", thread: th("quiet", T - 11 * DAY, T - 12 * DAY, 3, "email") }, { name: "Marcus Webb", role: "executive", thread: th("untouched", null, null, 0) }] }] },
    { fn: "prep", input: [{ now: T, company: "Atlas", dealName: "X", windowLabel: null, windowDays: null, hasWhyNow: false, members: [{ name: "Marcus Webb", role: "executive", thread: th("quiet", T - 11 * DAY, T - 12 * DAY, 3, "email") }], steps: [{ channel: "call", dueOn: "2026-10-14", state: "planned", doneByTouch: false }] }] },
    ...[[0.4, false], [0.2, true], [0.7, "only"]].map(([probability, replied]) => ({ fn: "stage", input: [{ probability, members: [...(replied !== "only" ? [{ thread: th("waiting", T, null, 1) }] : []), ...(replied ? [{ thread: th("replied", T, T, 2) }] : [])] }] })),
    { fn: "fanOut", input: [["exec", "buyer", "other", "reached"].map((key) => ({ key, contactId: key, itemId: null, name: key, title: null, source: "company", role: key === "exec" ? "executive" : null, buyer: key !== "other", researched: false, why: null, reached: key === "reached" ? "Waiting" : null, center: null, capability: null }))] },
  ] as unknown as PlayCall[];
}

/**
 * What the kernel's runs send the model and when they run, on a recipe's settings (convex/lib/plays/runs.ts): a draft's
 * input and prompt from a deal with more facts and touches than a draft takes, the review, the draft, plan and brief
 * tool schemas, a first touch's channel, a research run's limits, when the keeper researches the account and its
 * people again, who its people research covers, and Jev's buyer-fit question. Each by name.
 */
export async function kernelCases(recipe: RecipeDefinition, settings: Settings, run: Runner): Promise<Record<string, unknown>> {
  const plays = refOf(recipe, settings).plays!;
  const T = Date.parse("2026-10-11T12:00:00Z");
  const kinds = ["timeline", "signal", "competitor", "risk", "gap"] as const;
  const items = Array.from({ length: 20 }, (_, i) => ({
    id: `i${i}`, kind: kinds[i % 5], text: `Item ${i}`, quote: i % 3 ? `quote ${i}` : null, sourceUrl: null, evidence: i === 4 || i === 7 ? "unverified" : "verified",
    occurredOn: null, origin: "research", createdAt: T - i * DAY, person: null,
  }));
  const touches = Array.from({ length: 12 }, (_, i) => ({ contactId: i % 4 === 3 ? "other" : "p1", channel: "email" as Channel, direction: (["out", "in", "both"] as const)[i % 3], at: T - i * 2 * DAY - 3_600_000, summary: `Touch ${i}` }));
  const person = { contactId: "p1", name: "Priya Raman", title: "VP Revenue Operations", role: "champion" as DealRole, persona: "Owns the comp plan", angle: null };
  const plane = {
    deal: { companyName: "Northstar" }, brief: { context: "Commission plans", whyNow: "New CRO", alphaPitch: null }, people: [person],
    pointOfView: { icpId: "a", icpName: "Platform teams", text: "Most plan disputes come from routing, not math.", offer: "A teardown of one plan" },
    prep: { answers: [{ question: "Who signs?", answer: null, asked: true }, { question: "Is it measured?", answer: "Monthly", asked: true }, { question: "What did they try?", answer: null, asked: false }] },
    items, touches,
  } as unknown as Parameters<typeof draftInputOf>[0];
  const inputs = (["email", "call", "linkedin"] as Channel[]).map((channel) => draftInputOf(plane, { channel, title: "First touch: Priya", targetId: "p1" }, "Ryan", T, plays));
  const draft = { subject: "plan disputes", body: "Hi Priya,\n\nMost plan disputes come from routing.\nWant the teardown?\n\nRyan" };
  const subject = { company: "Northstar", domain: "northstar.example", dealName: "Northstar ICM", context: "Commission plans", people: [{ name: "Priya Raman", title: "VP Revenue Operations", role: "champion" as DealRole }], questions: ["Who signs?", "Is it measured?"] };
  const prompts = await run(settings, [
    ...inputs.map((input): PlayCall => ({ fn: "drafts.prompt", input: [input] })),
    ...inputs.map((input): PlayCall => ({ fn: "drafts.reviewPrompt", input: [input, draft] })),
    { fn: "research.planPrompt", input: [subject, 2026] },
    { fn: "research.briefPrompt", input: [subject, [{ url: "https://northstar.example/", text: "Northstar pays commissions monthly.", links: [] }], "2026-10-11"] },
  ]);
  const value = (i: number) => (prompts[i].ok ? (prompts[i] as { value: unknown }).value : prompts[i]);
  const research = (status: string, ageDays: number) => ({ status, startedAt: T - ageDays * DAY - 60_000, finishedAt: status === "done" ? T - ageDays * DAY : null });
  const ages = [0, 0.5, 1.5, 2, 3, 4, 6, 6.9, 7.1, 8, 14, 31];
  const prospects = Array.from({ length: 14 }, (_, i) => ({ key: `k${i}`, contactId: i === 2 ? null : `c${i}`, itemId: null, name: `P${i}`, title: null, source: "company", role: null, buyer: i !== 5, researched: false, why: null, reached: null, suggested: false, center: null, capability: null })) as Prospect[];
  return {
    ...Object.fromEntries(inputs.flatMap((input, i) => [[`draft/${input.channel}`, { input, prompt: value(i) }], [`review/${input.channel}`, value(inputs.length + i)]])),
    "draft schema": draftSchema(plays, settings),
    "review schema": reviewSchema(plays, settings),
    "first touch channel": [{ email: "p@x.example", linkedinUrl: "https://linkedin.com/in/p" }, { email: null, linkedinUrl: "https://linkedin.com/in/p" }, { email: "p@x.example", linkedinUrl: null }, { email: null, linkedinUrl: null }].map((p) => firstTouchChannel(p, plays)),
    "research limits": researchLimits(plays),
    plan: { schema: planSchema(plays), prompt: value(2 * inputs.length) },
    brief: { schema: [0, 2, 5].map((n) => briefSchema(plays, settings, n)), prompt: value(2 * inputs.length + 1) },
    "research due": [null, research("running", 0), research("running", 0.01), research("failed", 0.5), research("failed", 1.5), ...ages.map((a) => research("done", a))]
      .map((r) => [false, true].map((newQuestions) => researchDue(r, newQuestions, T, plays))),
    "people research due": [null, research("running", 0), research("running", 0.05), ...ages.map((a) => research("done", a)), ...ages.map((a) => research("failed", a))].map((r) => peopleResearchDue(r, T, plays.people.everyDays)),
    "scheduled buyers": scheduledBuyers(prospects, plays),
    "buyer fit": plays.people.fit,
  };
}

/** Each kernel case's hash, by name. */
export const kernelHashes = async (recipe: RecipeDefinition, settings: Settings, run: Runner) =>
  Object.fromEntries(Object.entries(await kernelCases(recipe, settings, run)).map(([k, v]) => [k, resultHash({ ok: true, value: v })]));

export type Fixture = {
  captured: string;
  settings: Record<string, Settings>;
  /** Each batch runs as one runCalls batch, so a call's `with` names a call in its own batch. */
  batches: Array<{ name: string; calls: PlayCall[] }>;
  /** Per settings set and batch, each call's result as the hash of its canonical JSON. */
  results: Record<string, string[][]>;
  /** What each recipe declares besides its code: meta, settings, page, plays data at its defaults, evals. */
  recipes: Record<string, Structure>;
  /** Per settings set, each kernel case's hash (kernelCases). */
  kernel: Record<string, Record<string, string>>;
};

export type Structure = Pick<RecipeDefinition, "id" | "version" | "title" | "description" | "author" | "permissions" | "settings" | "settingsSchema" | "dealPage" | "evals"> & { plays: RecipeRef["plays"] };
export const structureOf = (r: RecipeDefinition): Structure => JSON.parse(JSON.stringify({
  id: r.id, version: r.version, title: r.title, description: r.description, author: r.author, permissions: r.permissions,
  settings: r.settings, settingsSchema: r.settingsSchema, dealPage: r.dealPage, evals: r.evals, plays: refOf(r).plays,
}));

/** A value's JSON with object keys sorted: equal for deep-equal JSON values, whatever order their keys came in. */
const canonical = (x: unknown): unknown => Array.isArray(x) ? x.map(canonical)
  : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, canonical(v)])) : x;
export const resultHash = (r: CallResult) => createHash("sha256").update(JSON.stringify(canonical(r))).digest("hex").slice(0, 20);

/** A batch runner: settings and calls in, one result per call out. */
export type Runner = (settings: Settings, calls: readonly PlayCall[]) => CallResult[] | Promise<CallResult[]>;
export const inProcess = (code: (s: Settings) => PlayCode): Runner => (settings, calls) => JSON.parse(JSON.stringify(runCalls(code(settings), JSON.parse(JSON.stringify(calls)))));

export const readFixture = (): Fixture => JSON.parse(readFileSync(FIXTURE_FILE, "utf8"));

/**
 * Every fixture call through `run`, and every kernel case on `recipe`, on every settings set against the frozen results.
 * A set holds the settings a recipe had when it was captured; a setting added since takes `recipe`'s default.
 */
export async function compare(fixture: Fixture, run: Runner, recipe: RecipeDefinition) {
  const byFn = new Map<string, { same: number; differ: number; example?: string }>();
  let same = 0, differ = 0;
  const tally = (fn: string, ok: boolean, example: () => string) => {
    const t = byFn.get(fn) ?? { same: 0, differ: 0 };
    if (ok) { t.same++; same++; } else { t.differ++; differ++; t.example ??= example(); }
    byFn.set(fn, t);
  };
  for (const [setName, captured] of Object.entries(fixture.settings)) {
    const settings = { ...recipe.settings, ...captured };
    for (const [b, batch] of fixture.batches.entries()) {
      const got = await run(settings, batch.calls);
      batch.calls.forEach((call, i) => tally(call.fn, resultHash(got[i]) === fixture.results[setName][b][i], () => `${setName} / ${batch.name} #${i}: ${JSON.stringify(got[i]).slice(0, 400)}`));
    }
    const cases = await kernelCases(recipe, settings, run);
    for (const [name, want] of Object.entries(fixture.kernel[setName])) {
      tally(`kernel: ${name.split("/")[0]}`, resultHash({ ok: true, value: cases[name] }) === want, () => `${setName} / ${name}: ${JSON.stringify(cases[name]).slice(0, 400)}`);
    }
  }
  return { same, differ, byFn };
}

/** Today's recipes as the fixture's settings sets and batches see them: each target's name and its runner. */
export async function targets(): Promise<Array<{ name: string; run: Runner; recipe: RecipeDefinition }>> {
  const velocity = await velocityPackage();
  const enterprise = RECIPES["fsgtm-enterprise-deal"];
  const load = async (code: string) => ((await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)) as { run: Runner }).run;
  return [
    { name: "FSGTM enterprise (recipe.md + fsgtm.ts), in-process", run: inProcess((s) => firstPartyCode("fsgtm-enterprise-deal", s)!), recipe: enterprise },
    { name: "FSGTM enterprise, its bundle", run: viaJson(await load(RECIPE_BUNDLES["fsgtm-enterprise-deal"]!.code)), recipe: enterprise },
    { name: "Velocity (recipe.md on Canon's built-ins), the bundle an install makes", run: viaJson(await load(velocity.code)), recipe: velocity.definition },
  ];
}

const VELOCITY_DIR = fileURLToPath(new URL("../recipes/fsgtm-velocity-deal", import.meta.url));
/** Velocity as an install builds it: recipe.md compiled, on Canon's built-ins bundle. */
export async function velocityPackage() {
  const dir = await readRecipeDir(VELOCITY_DIR);
  const code = markdownBundle(BUILTINS_BUNDLE, dir.recipe, await bundleHash(dir.markdown));
  return { dir, code, hash: await bundleHash(code), definition: recipeOf(dir.recipe, []) };
}

const viaJson = (run: Runner): Runner => async (settings, calls) => JSON.parse(JSON.stringify(await run(settings, JSON.parse(JSON.stringify(calls)))));

/** What differs between each recipe's declarations and the frozen ones: its settings, page, plays data, evals and meta. */
export async function structureDiffs(fixture: Fixture): Promise<string[]> {
  const velocity = (await velocityPackage()).definition;
  // A section other than a fields section had no title before markdown. Its actions, and the folding of the play's
  // panels, were code until P3; scripts/deal-page-parity.ts holds them to what that code rendered. The header, products,
  // splits and apps were drawn around the page until C1, and a section's show= parts came with it.
  const page = (p: Structure["dealPage"]) => p.filter((s) => !DEAL_FRAME.includes(s.component)).map((s) => (s.component === "fields" ? s : Object.fromEntries(Object.entries(s).filter(([k]) => !["title", "actions", "collapsed", "show"].includes(k) || (k === "collapsed" && s.component === "fieldGrid")))));
  // Templates, AI fields and model points came after the freeze and aren't plays; the points they fill are left out of
  // the slots compared, and a model point's settings out of the settings compared.
  const permissions = (p: Structure["permissions"]) => ({ ...p, slots: p.slots.filter((s) => !s.startsWith("templates.") && s !== "fields" && !isModelPoint(s)) });
  const modelKeys = new Set(Object.values(MODEL_POINTS).flatMap((m) => Object.keys(m.settings)));
  const settings = (x: Structure) => ({ settings: Object.fromEntries(Object.entries(x.settings).filter(([k]) => !modelKeys.has(k))), settingsSchema: x.settingsSchema.filter((d) => !modelKeys.has(d.key)) });
  // The deal state's qualification framework (DS1, docs/deal-state.md) came after the freeze too: plays data without it.
  const plays = (p: Structure["plays"]) => (p ? Object.fromEntries(Object.entries(p).filter(([k]) => k !== "qualification")) : p);
  const shape = (x: Structure, ignore: readonly string[]) => canonical({ ...Object.fromEntries(Object.entries(x).filter(([k]) => !ignore.includes(k))), ...settings(x), dealPage: page(x.dealPage), permissions: permissions(x.permissions), plays: plays(x.plays) });
  const diffs: string[] = [];
  for (const [id, now, ignore] of [["fsgtm-enterprise-deal", RECIPES["fsgtm-enterprise-deal"], []], ["@fsgtm/velocity-deal", velocity, ["version"]]] as const) {
    const a = shape(fixture.recipes[id], ignore) as Record<string, unknown>, b = shape(structureOf(now), ignore) as Record<string, unknown>;
    for (const k of Object.keys(a)) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) diffs.push(`${id}: ${k} differs`);
  }
  return diffs;
}

/** The local stack's Worker secret (scripts/dev/dev-isolated.sh), else the one a hand-started `wrangler dev` reads. */
function secret(): string | undefined {
  if (process.env.RECIPE_RUNTIME_SECRET) return process.env.RECIPE_RUNTIME_SECRET;
  const vars = ["../.devstack/recipe-runtime/.dev.vars", "../services/recipe-runtime/.dev.vars"].map((p) => fileURLToPath(new URL(p, import.meta.url))).find(existsSync);
  return vars ? readFileSync(vars, "utf8").match(/^RECIPE_RUNTIME_SECRET=(.+)$/m)?.[1]?.trim() : undefined;
}

/** A runner through the recipe runtime at `url`. A batch with no `with` goes in chunks, as a deal page batch would. */
function viaWorker(url: string, target: (settings: Settings) => Target): Runner {
  return async (settings, calls) => {
    process.env.RECIPE_RUNTIME_URL = url;
    const chunks = calls.some((c) => c.with) ? [calls] : Array.from({ length: Math.ceil(calls.length / 100) }, (_, i) => calls.slice(i * 100, i * 100 + 100));
    const out: CallResult[] = [];
    for (const chunk of chunks) out.push(...(await runSettled(target(settings), chunk)));
    return out;
  };
}

async function time(runs: number, fn: () => Promise<unknown>) {
  for (let i = 0; i < 20; i++) await fn();
  const ms: number[] = [];
  for (let i = 0; i < runs; i++) { const t = performance.now(); await fn(); ms.push(performance.now() - t); }
  ms.sort((a, b) => a - b);
  const at = (p: number) => ms[Math.min(ms.length - 1, Math.floor(p * ms.length))].toFixed(3);
  return `p50 ${at(0.5)} ms  p95 ${at(0.95)} ms  (n=${runs})`;
}

function report(name: string, out: Awaited<ReturnType<typeof compare>>) {
  console.log(`${name}: ${out.same} same, ${out.differ} different`);
  for (const [fn, t] of [...out.byFn].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${fn.padEnd(26)} ${t.same} same, ${t.differ} different`);
    if (t.example) console.log(`    ${t.example}`);
  }
}

async function capture(): Promise<Fixture> {
  const enterprise = RECIPES["fsgtm-enterprise-deal"];
  const velocity = (await velocityPackage()).definition;
  const altered: Settings = { ...enterprise.settings, coreRoles: ["champion", "signer"], quietDays: 3, emailMaxWords: 40, subjectMaxWords: 6, askMaxWords: 6, maxPrepQuestions: 1, suggestedFirstTouches: 1, comparativePhrases: String.raw`\b(unmatched)\b`, nextCallDays: 30, closeProbability: 0.3, staleResearchDays: 10, windowUrgentDays: 90, politeDays: 3 };
  const batches = [
    { name: "tests/dealPlays.test.ts", calls: testCalls() },
    { name: "FSGTM evals", calls: enterprise.evals.map((e) => e.call) },
    { name: "Velocity evals", calls: velocity.evals.map((e) => e.call) },
    ...Array.from({ length: 12 }, (_, i) => ({ name: `deal page ${i + 1}`, calls: dealPageBatch(i + 1).calls })),
    { name: "random sweep", calls: randomCalls(1500) },
  ];
  const settings = { defaults: enterprise.settings, velocity: velocity.settings, altered };
  const run = inProcess((s) => firstPartyCode("fsgtm-enterprise-deal", s)!);
  const results = Object.fromEntries(Object.entries(settings).map(([name, s]) => [name, batches.map((b) => (run(s, b.calls) as CallResult[]).map(resultHash))]));
  const kernel = Object.fromEntries(await Promise.all(Object.entries(settings).map(async ([name, s]) => [name, await kernelHashes(enterprise, s, run)] as const)));
  return {
    captured: "recaptured from recipes/fsgtm-enterprise-deal (recipe.md and fsgtm.ts)", settings, batches: JSON.parse(JSON.stringify(batches)), results,
    recipes: { "fsgtm-enterprise-deal": structureOf(enterprise), "@fsgtm/velocity-deal": structureOf(velocity) }, kernel,
  };
}

async function main(argv: string[]) {
  if (argv.includes("--capture")) {
    const fixture = await capture();
    writeFileSync(FIXTURE_FILE, `${JSON.stringify(fixture)}\n`);
    console.log(`wrote ${FIXTURE_FILE}: ${fixture.batches.reduce((n, b) => n + b.calls.length, 0)} calls on ${Object.keys(fixture.settings).length} settings sets`);
    return;
  }
  const fixture = readFixture();
  console.log(`Fixture: ${fixture.captured}. ${fixture.batches.reduce((n, b) => n + b.calls.length, 0)} calls, each on ${Object.keys(fixture.settings).join(", ")} settings.\n`);
  const diffs = await structureDiffs(fixture);
  console.log(diffs.length ? `Structure: ${diffs.join("; ")}` : "Structure: settings, page, plays data, evals and meta are the same for both recipes.");
  let differ = diffs.length;
  const url = argv.includes("--url") ? argv[argv.indexOf("--url") + 1] : null;
  const runs = argv.includes("--runs") ? Number(argv[argv.indexOf("--runs") + 1]) : 200;
  const list = await targets();
  if (url) {
    const key = secret();
    if (!key) throw new Error("set RECIPE_RUNTIME_SECRET or run the local stack, which writes .devstack/recipe-runtime/.dev.vars");
    process.env.RECIPE_RUNTIME_SECRET = key;
    const velocity = await velocityPackage();
    list.push(
      { name: `FSGTM enterprise through the runtime at ${url}`, run: viaWorker(url, (settings) => ({ id: "fsgtm-enterprise-deal", settings, installed: null })), recipe: RECIPES["fsgtm-enterprise-deal"] },
      { name: `Velocity through the runtime at ${url}, as an installed package`, run: viaWorker(url, (settings) => ({ id: velocity.definition.id, settings, installed: { hash: velocity.hash, code: async () => velocity.code } })), recipe: velocity.definition },
    );
  }
  for (const t of list) {
    const out = await compare(fixture, t.run, t.recipe);
    report(t.name, out);
    differ += out.differ;
  }
  if (url) {
    const page = Array.from({ length: 12 }, (_, i) => dealPageBatch(i + 1)).sort((a, b) => b.calls.length - a.calls.length || JSON.stringify(b).length - JSON.stringify(a).length)[0];
    const ctx = {} as never;
    console.log(`\ndeal page batch: ${page.calls.length} calls, ${JSON.stringify(page).length} bytes`);
    console.log(`in-process          ${await time(runs, () => { delete process.env.RECIPE_RUNTIME_URL; return runPlays(ctx, page.ref, page.calls); })}`);
    console.log(`runtime, empty      ${await time(runs, () => { process.env.RECIPE_RUNTIME_URL = url; return runPlays(ctx, page.ref, []); })}`);
    console.log(`runtime, deal page  ${await time(runs, () => { process.env.RECIPE_RUNTIME_URL = url; return runPlays(ctx, page.ref, page.calls); })}`);
  }
  console.log(differ ? "\nSomething differs: see above." : "\nEvery call is the same.");
  process.exitCode = differ ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
