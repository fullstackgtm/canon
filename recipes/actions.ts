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
import { KERNEL_ACTIONS, PANELS } from "./blocks.ts";
import { holds, parseCondition, type Condition, type Context, type Scope, type VarType } from "./conditions.ts";

/** A part of a section with actions of its own, and the section it sits in. */
export { PANELS } from "./blocks.ts";
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

export { KERNEL_ACTIONS } from "./blocks.ts";

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
