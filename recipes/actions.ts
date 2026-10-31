/**
 * The actions a deal, account or contact page can offer (docs/recipes.md, "Actions"). A recipe's ```action block names
 * one of these by its `runs:` id and gives it a label, a place in its section and the conditions it shows and runs
 * under. The kernel owns everything else: where the action can sit on each object's page, what it acts on, the Convex
 * function it calls, whether that writes, and the gate that function keeps. A recipe can rename, reorder or leave out
 * an action; it can't add one or loosen a gate. Pure, so the parser, an install, the server and the browser all read
 * the same table.
 */
import { DEAL_STAGES, ITEM_KINDS, PLAY_CHANNELS, type DealStage } from "../convex/lib/plays/model.ts";
import { shows, type PageComponent, type PageObject, type PageSpec } from "./kernel.ts";
import { holds, parseCondition, type Condition, type Context, type Scope, type VarType } from "./conditions.ts";

/** A part of a section with actions of its own, and the section it sits in. */
export const PANELS = { draftPanel: "plan" } as const;
export type Panel = keyof typeof PANELS;
/** Where an action sits on a page: a section's component, or a panel. The draft panel also opens from a person's row in fanOut. */
export type Host = PageComponent | Panel;

const bool: VarType = { kind: "bool" };
const num: VarType = { kind: "number" };
const oneOf = (...values: readonly string[]): VarType => ({ kind: "enum", values });
const RUN_STATUS = ["none", "running", "done", "failed"];

/** What every action on each object's page can read. */
const PAGE: Readonly<Record<PageObject, Scope>> = {
  deal: {
    canEdit: bool,
    canDelete: bool,
    deleted: bool,
    stage: oneOf(...DEAL_STAGES),
    "deal.companyId": bool,
    "research.status": oneOf(...RUN_STATUS),
    "people.research.status": oneOf(...RUN_STATUS),
    "play.started": bool,
    "others.count": num,
    "suggested.count": num,
  },
  account: { canEdit: bool, canDelete: bool, deleted: bool },
  contact: { canEdit: bool, canDelete: bool, deleted: bool, "contact.email": bool, "contact.phone": bool, "contact.company": bool },
};
const STEP: Scope = {
  "step.channel": oneOf(...PLAY_CHANNELS),
  "step.done": bool,
  "step.doneByTouch": bool,
  "step.queued": bool,
  "draft.exists": bool,
  "draft.by": oneOf("keeper", "user", "none"),
  "draft.subject": bool,
  "person.email": bool,
  "person.linkedinUrl": bool,
};

/** A value a label can name: the picked people's count, an item's person's role, an activity's kind, the number a call dials. */
type Placeholder = "n" | "role" | "kind" | "phone";
export type LabelValues = { n?: number; role?: string | null; kind?: string; phone?: string | null };

/** What an action acts on, and so what else its conditions can read and its label can name. */
export const BINDINGS = {
  deal: { scope: {}, placeholders: [] },
  queue: { scope: { "queue.next": bool }, placeholders: [] },
  picked: { scope: { "picked.count": num, "shown.count": num }, placeholders: ["n"] },
  targets: { scope: { "targets.count": num, "picked.count": num }, placeholders: ["n"] },
  row: { scope: { "row.source": oneOf("deal", "company", "research"), "row.inCanon": bool, "row.hasStep": bool }, placeholders: [] },
  step: { scope: STEP, placeholders: [] },
  draft: { scope: { ...STEP, "gmail.linked": bool, "linkedin.sender": bool }, placeholders: [] },
  flag: { scope: { "flag.propose": bool }, placeholders: [] },
  item: { scope: { "item.kind": oneOf(...ITEM_KINDS), "item.person": bool }, placeholders: ["role"] },
  person: { scope: {}, placeholders: [] },
  suggestion: { scope: {}, placeholders: [] },
  record: { scope: {}, placeholders: [] },
  activity: { scope: {}, placeholders: ["kind"] },
  personRow: { scope: { "row.primary": bool, "row.email": bool, "row.phone": bool }, placeholders: [] },
  companyRow: { scope: { "row.primary": bool }, placeholders: [] },
  hierarchy: { scope: { "parent.exists": bool }, placeholders: [] },
  childRow: { scope: {}, placeholders: [] },
  newDeal: { scope: { "deal.canCreate": bool }, placeholders: [] },
  dialer: { scope: { "call.blocked": bool }, placeholders: ["phone"] },
  call: { scope: {}, placeholders: [] },
  email: { scope: { "gmail.linked": bool }, placeholders: [] },
  aiField: { scope: { "field.answered": bool }, placeholders: [] },
  signals: { scope: { "signals.canManage": bool, "signals.enabled": bool, "signals.running": bool }, placeholders: [] },
} as const satisfies Record<string, { scope: Scope; placeholders: readonly Placeholder[] }>;
export type Binding = keyof typeof BINDINGS;

/** One place an action sits: what it acts on there, and conditions or a gate that hold there instead of the action's own. */
export type Placement = { on: Binding; requires?: string; ready?: string; after?: string; gate?: string };

/**
 * A kernel action. `hosts` maps each object's page to the places the action can sit there and what it acts on in
 * each, as a binding or a full placement. `requires` hides it and `ready` disables it whatever the recipe says,
 * because the call can't run without them; `after` switches its label to `label_after`. All three are conditions over
 * the placement's scope, and a placement's own replace the action's.
 */
export type KernelAction = {
  hosts: Partial<Record<PageObject, Partial<Record<Host, Binding | Placement>>>>;
  /** The Convex function it calls, or null for a navigation. */
  calls: string | null;
  writes: boolean;
  gate: string;
  /** The canon_deal_play method an agent calls for the same thing, when there is one. */
  mcp?: string;
  requires?: string;
  ready?: string;
  after?: string;
};

export const KERNEL_ACTIONS = {
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
} as const satisfies Record<string, KernelAction>;

export type ActionId = keyof typeof KERNEL_ACTIONS;
export const ACTION_IDS = Object.keys(KERNEL_ACTIONS) as ActionId[];
export const isActionId = (s: string): s is ActionId => Object.hasOwn(KERNEL_ACTIONS, s);
export const kernelAction = (id: ActionId): KernelAction => KERNEL_ACTIONS[id];

/**
 * One action as a recipe places it, in its section's `actions`, in file order. `panel` names the panel it sits in.
 * `shows` hides it and `enabled` disables it when false; the rest describes it for people and the install screen.
 * Only text crosses to the page: an action's `input:` and `writes:` stay in recipe.md as documentation.
 */
export type PageAction = {
  id: string; label: string; runs: ActionId; labelAfter?: string; panel?: Panel; shows?: string; enabled?: string;
  prompts?: string[]; fields?: string[]; llm?: string; gate?: string; done?: string; note?: string;
};

/** Where `id` sits in `host` on `object`'s page, with its conditions and gate there, or null when it doesn't. */
export function placement(id: ActionId, host: Host, object: PageObject = "deal"): Required<Pick<Placement, "on" | "gate">> & Omit<Placement, "on" | "gate"> | null {
  const k: KernelAction = KERNEL_ACTIONS[id];
  const at = k.hosts[object]?.[host];
  if (!at) return null;
  const p: Placement = typeof at === "string" ? { on: at } : at;
  return { requires: k.requires, ready: k.ready, after: k.after, ...p, gate: p.gate ?? k.gate };
}

/** Every place each kernel action sits, by object and host, for the grammar and the docs. */
export const placements = () => ACTION_IDS.flatMap((id) => Object.entries(KERNEL_ACTIONS[id].hosts as KernelAction["hosts"]).flatMap(([object, hosts]) =>
  Object.keys(hosts ?? {}).map((host) => ({ id, object: object as PageObject, host: host as Host, ...placement(id, host as Host, object as PageObject)! }))));

/** What `action` reads in `host` on `object`'s page: the page, plus its binding's scope. */
export function scopeOf(id: ActionId, host: Host, object: PageObject = "deal"): Scope {
  const p = placement(id, host, object);
  return p ? { ...PAGE[object], ...BINDINGS[p.on].scope } : PAGE[object];
}

const PLACEHOLDER = /<([a-z]+)>/g;

/** Why `label` isn't a label for `binding`: a placeholder it can't fill, or brackets that don't pair. */
function labelProblem(label: string, binding: Binding): string | null {
  const allowed: readonly string[] = BINDINGS[binding].placeholders;
  for (const [, name] of label.matchAll(PLACEHOLDER)) if (!allowed.includes(name)) return `<${name}> isn't a value this action has (${allowed.map((p) => `<${p}>`).join(", ") || "none"})`;
  if (/\{[^}]*\}/.test(label) && !allowed.includes("n")) return "{one|many} picks a word by <n>, which this action doesn't have";
  if (/\[[^\]]*[[]|\][^[]*\]/.test(label) || (label.match(/\[/g)?.length ?? 0) !== (label.match(/\]/g)?.length ?? 0)) return "a [ ... ] part opens and closes once";
  return null;
}

/**
 * Why a recipe can't place `action` in `host`, each problem with the action key it is about: a host the kernel action
 * doesn't sit in, a label naming a value it lacks, or a condition that doesn't parse over its scope.
 */
export function actionProblems(action: Pick<PageAction, "runs" | "label" | "labelAfter" | "shows" | "enabled">, host: Host, object: PageObject = "deal"): Array<{ key: string; message: string }> {
  const binding = placement(action.runs, host, object)?.on;
  if (!binding) {
    const where = placements().filter((p) => p.id === action.runs).map((p) => (p.object === object ? p.host : `${p.object}.${p.host}`));
    return [{ key: "runs", message: `${action.runs} can't sit in ${object === "deal" ? host : `${object}.${host}`} (it sits in ${where.join(", ")})` }];
  }
  const out: Array<{ key: string; message: string }> = [];
  for (const [key, label] of [["label", action.label], ["label_after", action.labelAfter]] as const) {
    const problem = label === undefined ? null : labelProblem(label, binding);
    if (problem) out.push({ key, message: problem });
  }
  for (const key of ["shows", "enabled"] as const) {
    const text = action[key];
    if (text === undefined) continue;
    const parsed = parseCondition(text, scopeOf(action.runs, host, object));
    if (!parsed.ok) out.push({ key, message: `${key} "${text}", at column ${parsed.column}: ${parsed.error}` });
  }
  return out;
}

/**
 * A label with its values filled in: `<n>`, `<role>` and `<kind>`, `{person|people}` by whether n is 1, and a `[ ... ]`
 * part dropped when a value in it is empty, so "Add to deal[ as <role>]" reads "Add to deal" for nobody in particular.
 */
export function fillLabel(label: string, values: LabelValues): string {
  const has = (name: string) => { const v = values[name as keyof typeof values]; return v !== undefined && v !== null && v !== ""; };
  return label
    .replace(/\[([^\]]*)\]/g, (_, part: string) => ([...part.matchAll(PLACEHOLDER)].every(([, name]) => has(name)) ? part : ""))
    .replace(/\{([^|}]*)\|([^}]*)\}/g, (_, one: string, many: string) => (values.n === 1 ? one : many))
    .replace(PLACEHOLDER, (_, name: string) => (has(name) ? String(values[name as keyof typeof values]) : ""));
}

/** An action the page offers: its label filled in, and whether it can run now. */
export type Offer = { action: PageAction; label: string; disabled: boolean };

const parsed = new Map<string, Condition | null>();
function passes(text: string | undefined, id: ActionId, host: Host, object: PageObject, ctx: Context): boolean {
  if (text === undefined) return true;
  const key = `${object} ${id} ${host} ${text}`;
  if (!parsed.has(key)) {
    const p = parseCondition(text, scopeOf(id, host, object));
    if (!p.ok) console.warn(`${id} in ${object}.${host}: ${p.error}`);
    parsed.set(key, p.ok ? p.condition : null);
  }
  const c = parsed.get(key);
  return c ? holds(c, ctx) : false;
}

/**
 * Which of `actions` running one of `runs` the page offers in `host` on `object`'s page with `ctx`, in the recipe's
 * order. The kernel's `requires` and the recipe's `shows` decide whether it shows, `ready` and `enabled` whether it can
 * run, and `after` whether it reads its `label_after`. An action placed where the kernel doesn't sit it is never offered.
 */
export function offered(actions: readonly PageAction[], host: Host, runs: readonly ActionId[], ctx: Context, values: LabelValues = {}, object: PageObject = "deal"): Offer[] {
  return actions.filter((a) => runs.includes(a.runs)).flatMap((action) => {
    const p = placement(action.runs, host, object);
    const holdsHere = (text: string | undefined) => passes(text, action.runs, host, object, ctx);
    if (!p || !holdsHere(p.requires) || !holdsHere(action.shows)) return [];
    const label = p.after && action.labelAfter && holdsHere(p.after) ? action.labelAfter : action.label;
    return [{ action, label: fillLabel(label, values), disabled: !holdsHere(p.ready) || !holdsHere(action.enabled) }];
  });
}

/** One action as an agent reads it from canon_deal_play get: where the page offers it, and the method that does the same. */
export type AgentAction = { section: string; id: string; label: string; runs: ActionId; method: string | null; writes: boolean; gate: string; shows?: string; enabled?: string };

/**
 * The actions the deal page offers at `stage`, in the page's order: those of each section the stage shows, and the
 * draft panel's, which opens from a person's row too. `method` is null for what only a person does on the page,
 * such as sending from their Gmail.
 */
export function agentActions(page: PageSpec, stage: DealStage): AgentAction[] {
  return page.flatMap((section) => (section.actions ?? []).filter((a) => a.panel || shows(section, stage)).map((a): AgentAction => {
    const k: KernelAction = KERNEL_ACTIONS[a.runs];
    return {
      section: a.panel ?? section.title ?? section.component, id: a.id, label: a.label, runs: a.runs, method: k.mcp ?? null, writes: k.writes,
      gate: a.gate ?? placement(a.runs, a.panel ?? section.component)?.gate ?? k.gate,
      ...(a.shows ? { shows: a.shows } : {}), ...(a.enabled ? { enabled: a.enabled } : {}),
    };
  }));
}
