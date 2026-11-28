import { DATA_QUERIES } from "./data.ts";
/** The page block vocabulary shared by recipes, the editor and renderer coverage types. Pure: no Node imports. */
import { z } from "zod";
import { DEAL_STAGES, type DealStage } from "../convex/lib/plays/model.ts";
import type { KernelAction } from "./actions.ts";
import type { PageSection } from "./kernel.ts";

export const PAGE_OBJECTS = ["deal", "account", "contact"] as const;
export type PageObject = (typeof PAGE_OBJECTS)[number];
export const PANELS = { draftPanel: "plan" } as const;

const ACTION_CATALOG = {
  "nav.nextDeal": { hosts: { deal: { queue: "queue" } }, calls: null, writes: false, gate: "opens the next open deal in the queue", requires: "queue.next" },
  "kernel.researchAccount": {
    hosts: { deal: { summary: "deal" } }, calls: "dealPlayActions.research", writes: true, mcp: "research", after: 'research.status != "none"',
    gate: "every cited item's quote is found word for word on a page read, or it is dropped; it never overwrites what a person wrote; without a ChatGPT plan it asks before it spends credits",
  },
  "kernel.researchPeople": {
    hosts: { deal: { fanOut: "targets" } }, calls: "dealPlayActions.researchPeople", writes: true, mcp: "research_people", ready: "targets.count > 0",
    gate: "at most 25 people a run; answers are cited inferences; without a ChatGPT plan it asks before it spends credits",
  },
  "kernel.firstTouches": { hosts: { deal: { fanOut: "picked" } }, calls: "dealPlayKeeper.firstTouches", writes: true, mcp: "first_touches", requires: "picked.count > 0", gate: "never sends; a person reviews and sends each draft" },
  "kernel.firstTouch": { hosts: { deal: { fanOut: "row" } }, calls: "dealPlayKeeper.firstTouches", writes: true, mcp: "first_touches", requires: "row.inCanon && !row.hasStep", gate: "never sends; a person reviews and sends the draft" },
  "kernel.addToCanon": {
    hosts: { deal: { fanOut: "row" } }, calls: "records.upsert, dealCommittee.setRole, dealPlays.dismissItem", writes: true, requires: 'row.source == "research"',
    gate: "makes the contact research named at the deal's company, puts them on the deal and closes the gap item",
  },
  "kernel.addToDeal": {
    hosts: { deal: { brief: "item" } }, calls: "records.upsert, dealCommittee.setRole, dealPlays.dismissItem", writes: true, requires: "item.person",
    gate: "makes the contact the item names at the deal's company, puts them on the deal in its role and closes the item",
  },
  "kernel.markDone": { hosts: { deal: { plan: "step" } }, calls: "dealPlays.saveStep", writes: true, mcp: "save_step", ready: "!step.doneByTouch", after: "step.done", gate: "a step a touch completed stays done" },
  "kernel.setStepOwner": { hosts: { deal: { plan: "step" } }, calls: "dealPlays.saveStep", writes: true, mcp: "save_step", gate: "a teammate in the workspace" },
  "kernel.setStepDue": { hosts: { deal: { plan: "step" } }, calls: "dealPlays.saveStep", writes: true, mcp: "save_step", gate: "a date" },
  "kernel.removeStep": { hosts: { deal: { plan: "step" } }, calls: "dealPlays.removeStep", writes: true, mcp: "remove_step", gate: "removes the step and its draft" },
  "kernel.addStep": { hosts: { deal: { plan: "deal" } }, calls: "dealPlays.saveStep", writes: true, mcp: "save_step", gate: "a step for a person on the deal or whoever holds a role" },
  "kernel.draftStep": { hosts: { deal: { draftPanel: "draft" } }, calls: "dealPlayKeeper.draftStep", writes: true, mcp: "draft_step", requires: "!draft.exists", gate: "drafts on the acting person's plan; never sends" },
  "kernel.writeDraft": { hosts: { deal: { draftPanel: "draft" } }, calls: "dealPlays.setDraft", writes: true, mcp: "set_draft", requires: "!draft.exists", gate: "the rule checks run on what the person writes" },
  "kernel.editDraft": { hosts: { deal: { draftPanel: "draft" } }, calls: "dealPlays.setDraft", writes: true, mcp: "set_draft", requires: "draft.exists", gate: "a person's edit drops the model review; the rule checks run again" },
  "kernel.redraftStep": { hosts: { deal: { draftPanel: "draft" } }, calls: "dealPlayKeeper.draftStep", writes: true, mcp: "draft_step", requires: "draft.exists", gate: "drafts on the acting person's plan; never sends" },
  "kernel.sendEmail": {
    hosts: {
      deal: { draftPanel: { on: "draft", requires: 'step.channel == "email" && draft.exists && gmail.linked && person.email', gate: "sends only on this click, from the person's own linked Gmail; the sent email completes the step as a touch" } },
      contact: { composeEmail: { on: "email", requires: "contact.email", ready: "gmail.linked" } },
    },
    calls: "emailActions.sendToContact", writes: true, gate: "sends only on this click, from the person's own linked Gmail, within its daily cap",
  },
  "kernel.saveGmailDraft": {
    hosts: {
      deal: { draftPanel: { on: "draft", requires: 'step.channel == "email" && draft.exists && gmail.linked && person.email' } },
      contact: { composeEmail: { on: "email", requires: "contact.email", ready: "gmail.linked" } },
    },
    calls: "emailActions.draftToContact", writes: true, gate: "saves to the person's Gmail drafts; nothing sends",
  },
  "nav.linkedinProfile": { hosts: { deal: { draftPanel: "draft" } }, calls: null, writes: false, requires: 'step.channel == "linkedin" && draft.exists && person.linkedinUrl', gate: "opens the person's LinkedIn profile" },
  "kernel.queueLinkedin": {
    hosts: { deal: { draftPanel: "draft" } }, calls: "dealPlays.queueLinkedin", writes: true, mcp: "queue_linkedin",
    requires: 'step.channel == "linkedin" && draft.exists && person.linkedinUrl && linkedin.sender && !step.queued',
    gate: "an invite, then the message, within the sender's daily limits, window and warm-up; a contact in another active cadence is refused",
  },
  "kernel.checkNow": { hosts: { deal: { keeper: "deal" } }, calls: "dealPlayKeeper.checkNow", writes: true, mcp: "check_now", gate: "drafts the steps coming due; never notifies Slack; never sends" },
  "kernel.planFlag": { hosts: { deal: { keeper: "flag" } }, calls: "dealPlays.saveStep", writes: true, mcp: "save_step", requires: "flag.propose", gate: "adds the flag's proposed step to the plan" },
  "kernel.setWindow": { hosts: { deal: { brief: "deal" } }, calls: "dealPlays.setBrief", writes: true, mcp: "set_brief", gate: "a label and a date" },
  "kernel.setBrief": { hosts: { deal: { brief: "deal" } }, calls: "dealPlays.setBrief", writes: true, mcp: "set_brief", gate: "research never overwrites a person's brief" },
  "kernel.dismissItem": { hosts: { deal: { brief: "item" } }, calls: "dealPlays.dismissItem", writes: true, mcp: "dismiss_item", gate: "research skips anything a person dismissed" },
  "kernel.addItem": { hosts: { deal: { brief: "deal" } }, calls: "dealPlayActions.addItems", writes: true, mcp: "add_items", gate: "Canon fetches the page and marks the quote verified or unverified" },
  "kernel.setPerson": { hosts: { deal: { accountMap: "person" } }, calls: "dealPlays.setPerson", writes: true, mcp: "set_person", gate: "persona and angle are hypotheses" },
  "kernel.addSuggested": { hosts: { deal: { accountMap: "suggestion" } }, calls: "dealCommittee.setRole", writes: true, gate: "puts the person research suggested on the deal in the role it suggested" },
  "kernel.setRole": { hosts: { deal: { accountMap: "deal" } }, calls: "dealCommittee.setRole", writes: true, requires: "others.count > 0", gate: "a person already at the deal's company" },
  "kernel.setStatus": { hosts: { account: { header: "record" } }, calls: "records.edit", writes: true, requires: "!deleted", ready: "canEdit", gate: "the edit lands on the company's ledger, with the person as its author" },
  "kernel.setOwner": { hosts: { account: { header: "record" } }, calls: "records.edit", writes: true, requires: "!deleted", ready: "canEdit", gate: "an active teammate, or nobody; the edit lands on the company's ledger" },
  "kernel.editField": {
    hosts: { account: { fields: "record" }, contact: { fields: "record" } }, calls: "records.edit", writes: true, ready: "canEdit && !deleted",
    gate: "a field the workspace made read-only stays so; an edit to a row nobody has worked puts it on the ledger first",
  },
  "kernel.findEmail": {
    hosts: { contact: { header: { on: "record", requires: "canEdit && contact.company && !contact.email" } }, account: { related: { on: "personRow", requires: "row.primary && !row.email" } } },
    calls: "records.findEmail", writes: true, gate: "reads the person's company domain; within the workspace's lookup limit, and it writes only what it finds",
  },
  "kernel.findPhone": {
    hosts: { contact: { header: { on: "record", requires: "canEdit && contact.company && !contact.phone" } }, account: { related: { on: "personRow", requires: "row.primary && !row.phone" } } },
    calls: "records.findPhone", writes: true, gate: "reads the person's company domain; within the workspace's lookup limit, and it writes only what it finds",
  },
  "kernel.merge": {
    hosts: { account: { header: "record" }, contact: { header: "record" } }, calls: "recordMerges.merge", writes: true, requires: "canDelete && !deleted",
    gate: "a person compares the records and picks each value; the merge is undone from the kept record's history",
  },
  "kernel.archive": {
    hosts: { deal: { header: "record" }, account: { header: "record" }, contact: { header: "record" } }, calls: "records.bulkRegister, objects.remove", writes: true, requires: "canDelete && !deleted",
    gate: "the record leaves lists, search, reports and agents; nothing is erased, and Restore or the toast's Undo brings it back",
  },
  "kernel.restore": { hosts: { deal: { header: "record" }, account: { header: "record" }, contact: { header: "record" } }, calls: "records.bulkRegister, objects.restore", writes: true, requires: "canDelete && deleted", gate: "brings an archived record back" },
  "kernel.logActivity": {
    hosts: { account: { timeline: "activity" }, contact: { timeline: "activity" } }, calls: "activityTargets.logScoped", writes: true,
    gate: "a note, task, call or meeting about the record and the records it implies, such as a person's company",
  },
  "kernel.link": { hosts: { account: { related: "record" }, contact: { related: "record" } }, calls: "associations.link", writes: true, gate: "links a person and a company; a person's first company is their primary" },
  "kernel.unlink": {
    hosts: { account: { related: "personRow" }, contact: { related: "companyRow" } }, calls: "associations.unlink", writes: true,
    gate: "unlinks a person from a company; their next company becomes their primary",
  },
  "kernel.makePrimary": { hosts: { contact: { related: { on: "companyRow", requires: "!row.primary" } } }, calls: "associations.makePrimary", writes: true, gate: "one primary company a person, whose domain their lookups read" },
  "kernel.setParent": { hosts: { account: { related: "hierarchy" } }, calls: "associations.setParent", writes: true, after: "parent.exists", gate: "a company can't sit under itself or its own children" },
  "kernel.removeParent": { hosts: { account: { related: "hierarchy" } }, calls: "associations.setParent", writes: true, requires: "parent.exists", gate: "the company stands on its own" },
  "kernel.addChild": { hosts: { account: { related: "record" } }, calls: "associations.setParent", writes: true, gate: "a company can't sit under itself or its own children" },
  "kernel.removeChild": { hosts: { account: { related: "childRow" } }, calls: "associations.setParent", writes: true, gate: "the child company stands on its own" },
  "kernel.newDeal": { hosts: { account: { companyDeals: "newDeal" } }, calls: "deals.createScoped", writes: true, requires: "deal.canCreate", gate: "a deal at this company, from the deal form" },
  "kernel.callContact": {
    hosts: { contact: { callPanel: "dialer" } }, calls: "dialerActions.callContact", writes: true, ready: "!call.blocked",
    gate: "rings from the person's own dialer session; the do-not-call list and the contact's calling hours are checked again on the server",
  },
  "kernel.hangup": { hosts: { contact: { callPanel: "call" } }, calls: "dialer.hangupCall", writes: true, gate: "ends the person's live call" },
  "kernel.setCallOutcome": { hosts: { contact: { callPanel: "call" } }, calls: "dialer.setOutcome", writes: true, gate: "logs the person's own ended call; a do-not-call answer stops every later call to the number" },
  "kernel.runAiField": {
    hosts: { contact: { aiFields: "aiField" } }, calls: "researchAgents.startRun", writes: true,
    gate: "researches this one person; answers are cited and wait for review unless the field accepts them; without a ChatGPT plan it spends credits",
  },
  "kernel.checkSignals": {
    hosts: { account: { topSignals: "signals" } }, calls: "signals.checkNow", writes: true, requires: "signals.canManage", ready: "!signals.running",
    gate: "checks the workspace's accounts' job boards and websites now; one check runs at a time",
  },
  "kernel.toggleSignals": { hosts: { account: { topSignals: "signals" } }, calls: "signals.setEnabled", writes: true, requires: "signals.canManage", after: "signals.enabled", gate: "an admin or manager switches the daily check" },
} as const;
export const KERNEL_ACTIONS = ACTION_CATALOG satisfies Record<string, KernelAction>;

/** `stage = in`, `stage != in`, `stage in [in, case]` or `stage not in [...]`. */
export function whenOf(text: string): PageSection["when"] | null {
  const m = /^stage\s*(=|!=|in|not in)\s*(\[[\w,\s]*\]|\w+)$/.exec(text.trim());
  const stages = m?.[2].replace(/[[\]]/g, "").split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  if (!m || !stages.length || !stages.every((s) => (DEAL_STAGES as readonly string[]).includes(s))) return null;
  return m[1] === "=" || m[1] === "in" ? { stage: stages as DealStage[] } : { notStage: stages as DealStage[] };
}

export const SECTION_ATTRIBUTES = ["section", "when", "collapsed", "show"] as const;

function headingSchema(id: string, parts?: readonly string[]) {
  return z.object({
    section: z.literal(id),
    title: z.string().min(1, "a section needs a title"),
    when: z.string().superRefine((s, ctx) => {
      if (!whenOf(s)) ctx.addIssue({ code: "custom", message: `when="${s}" must be stage = <${DEAL_STAGES.join("|")}>, stage != …, or stage in [ … ]` });
    }).optional(),
    collapsed: z.enum(["true", "false"], { error: "collapsed= is true or false" }).optional(),
    show: z.string().refine((s) => Boolean(parts) && s.split(",").map((x) => x.trim()).filter(Boolean).every((x) => parts!.includes(x)), {
      message: parts ? `show= names ${id}'s parts: ${parts.join(", ")}` : `show= picks a component's parts, and ${id} has none to pick`,
    }).optional(),
  });
}

/** Pure call sites let play-runtime bundles omit the editor schemas and catalog metadata. */
function block<const I extends string, const G extends string, const O extends Partial<Record<PageObject, number>>>(
  id: I, group: G, objects: O, title: string, purpose: string, parts?: readonly string[],
) {
  const actions = Object.entries(ACTION_CATALOG).flatMap(([action, spec]) => Object.entries(spec.hosts).flatMap(([object, hosts]) =>
    Object.keys(hosts).filter((host) => host === id || PANELS[host as keyof typeof PANELS] === id).map((host) => ({ id: action as keyof typeof ACTION_CATALOG, object: object as PageObject, host })),
  ));
  return { id, group, objects, title, purpose, parts, actions, props: headingSchema(id, parts) };
}

function dataBlock<K extends keyof typeof DATA_QUERIES>(id: K, title: string, rank: number) {
  return { ...block(id, "data", { deal: rank, account: rank, contact: rank }, title, "Read records through a declarative query."), query: DATA_QUERIES[id] };
}

/** Object ranks preserve the existing add-menu and grammar order, independently of catalog order. */
export const BLOCKS = {
  table: /* @__PURE__ */ dataBlock("table", "Table", 30),
  list: /* @__PURE__ */ dataBlock("list", "List", 31),
  metric: /* @__PURE__ */ dataBlock("metric", "Metric", 32),
  chart: /* @__PURE__ */ dataBlock("chart", "Chart", 33),
  queue: /* @__PURE__ */ block("queue", "play", { deal: 1 }, "Queue", "The rep's open deals, at risk and closing soon first, and why the next one needs them."),
  summary: /* @__PURE__ */ block("summary", "play", { deal: 2 }, "Summary", "The deal's health, amount, close date and owner, and the account research run with its status.", ["health", "amount", "closeDate", "owner", "research"]),
  stageRail: /* @__PURE__ */ block("stageRail", "play", { deal: 3 }, "Stage rail", "The three stages, the current one marked, and its exit."),
  fanOut: /* @__PURE__ */ block("fanOut", "play", { deal: 4 }, "Fan out", "Everyone Canon could reach first, with their goal, systems and first touch. Search, the ICP buyer filter and picking people are the page's own controls."),
  prep: /* @__PURE__ */ block("prep", "play", { deal: 5 }, "Prep", "Where the deal stands and what it needs before it can move: the executive has heard from us, more than one person is engaged, the next call is booked within `nextCallDays`, and the signer is known."),
  plan: /* @__PURE__ */ block("plan", "play", { deal: 6 }, "Plan", "The first open step, soonest due first, with its draft."),
  keeper: /* @__PURE__ */ block("keeper", "play", { deal: 7 }, "Keeper", "The keeper's flags, most urgent first, each with the step that would fix it: the champion missing, a reply owed, quiet and untouched threads, overdue steps, the decision window and stale research."),
  brief: /* @__PURE__ */ block("brief", "play", { deal: 8 }, "Brief", "The decision window, why now, the alpha and its cited evidence."),
  accountMap: /* @__PURE__ */ block("accountMap", "play", { deal: 9 }, "Account map", "The deal's committee, sorted by role, as a table (role, person, reports to, persona, angle, confidence, thread) or an org chart from reports-to. Persona and angle are hypotheses and the page says so. Below: the people research suggests, and anyone else at the company."),
  touches: /* @__PURE__ */ block("touches", "play", { deal: 10 }, "Touches", "LinkedIn, email, calls and meetings with the people on this deal, newest first."),
  fieldGrid: /* @__PURE__ */ block("fieldGrid", "record", { deal: 11 }, "Field grid", "The deal's own fields, its timeline, history and related records, folded."),
  fields: /* @__PURE__ */ block("fields", "record", { deal: 12, account: 2, contact: 1 }, "Fields", "A section lists field api names, and rest."),
  timeline: /* @__PURE__ */ block("timeline", "record", { deal: 13, account: 5, contact: 6 }, "Timeline", "The record's activity timeline."),
  history: /* @__PURE__ */ block("history", "record", { deal: 14, account: 10, contact: 7 }, "History", "The record's history."),
  related: /* @__PURE__ */ block("related", "record", { deal: 15, account: 9, contact: 3 }, "Related", "The record's related people, companies and hierarchy."),
  products: /* @__PURE__ */ block("products", "record", { deal: 16 }, "Products", "The deal's line items: each product, its quantity and price, and the total, which can set the deal's amount."),
  splits: /* @__PURE__ */ block("splits", "record", { deal: 17 }, "Splits", "Who gets credit for the deal and their share, when the workspace splits credit."),
  apps: /* @__PURE__ */ block("apps", "record", { deal: 18 }, "Apps", "The panels the workspace's apps add to a deal."),
  header: /* @__PURE__ */ block("header", "party", { deal: 0, account: 0, contact: 0 }, "Header", "The record's name, status and owner, and whether it is archived."),
  fitBar: /* @__PURE__ */ block("fitBar", "party", { account: 1 }, "Fit bar", "The company's ICP fit beside its name."),
  whyFit: /* @__PURE__ */ block("whyFit", "party", { account: 3 }, "Why fit", "Why the company fits the ICP."),
  scoreHistory: /* @__PURE__ */ block("scoreHistory", "party", { account: 4 }, "Score history", "The company's fit score history."),
  topSignals: /* @__PURE__ */ block("topSignals", "party", { account: 6 }, "Top signals", "The company's latest signals and their status."),
  companyDeals: /* @__PURE__ */ block("companyDeals", "party", { account: 7 }, "Company deals", "The deals at this company."),
  peopleAcrossDeals: /* @__PURE__ */ block("peopleAcrossDeals", "party", { account: 8 }, "People across deals", "People across the company's deals."),
  aiFields: /* @__PURE__ */ block("aiFields", "party", { contact: 2 }, "Ai fields", "The person's AI field answers and research."),
  callPanel: /* @__PURE__ */ block("callPanel", "party", { contact: 4 }, "Call panel", "Call the person and log the call's outcome."),
  composeEmail: /* @__PURE__ */ block("composeEmail", "party", { contact: 5 }, "Compose email", "Draft or send email to the person through linked Gmail."),
} as const;
export type PageComponent = keyof typeof BLOCKS;
type Block = (typeof BLOCKS)[PageComponent];
type InGroup<G extends Block["group"]> = Extract<Block, { group: G }>["id"];
export const PAGE_COMPONENTS = /* @__PURE__ */ Object.keys(BLOCKS) as readonly PageComponent[];
const inGroup = <G extends Block["group"]>(group: G) => PAGE_COMPONENTS.filter((id): id is InGroup<G> => BLOCKS[id].group === group);
export const PLAY_COMPONENTS = /* @__PURE__ */ inGroup("play");
export const RECORD_COMPONENTS = /* @__PURE__ */ inGroup("record");
export const PARTY_COMPONENTS = /* @__PURE__ */ inGroup("party");
export type PlayComponent = (typeof PLAY_COMPONENTS)[number];
export type RecordComponent = (typeof RECORD_COMPONENTS)[number];
export type PartyComponent = (typeof PARTY_COMPONENTS)[number];
export type ComponentOf<O extends PageObject> = { [K in PageComponent]: O extends keyof (typeof BLOCKS)[K]["objects"] ? K : never }[PageComponent];
export const componentsOf = <O extends PageObject>(object: O): ComponentOf<O>[] => Object.values(BLOCKS)
  .filter((b) => object in b.objects)
  .sort((a, b) => (a.objects as Partial<Record<PageObject, number>>)[object]! - (b.objects as Partial<Record<PageObject, number>>)[object]!)
  .map((b) => b.id) as ComponentOf<O>[];
export const COMPONENTS = { deal: /* @__PURE__ */ componentsOf("deal"), account: /* @__PURE__ */ componentsOf("account"), contact: /* @__PURE__ */ componentsOf("contact") };
/**
 * The parts a component draws that a section's `show=` can pick, in the order they draw. A section without `show=`
 * draws them all; with it, only those it names.
 */
export const PARTS: Partial<Record<PageComponent, readonly string[]>> = /* @__PURE__ */ (() => Object.fromEntries(Object.values(BLOCKS).filter((b) => b.parts).map((b) => [b.id, b.parts])))();
