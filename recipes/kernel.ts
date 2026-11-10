/**
 * Recipes (docs/recipes.md): a methodology packaged against Canon's kernel. A recipe names the deal page's sections
 * (the `deal.page` slot) and, when it has one, the play methodology the keeper, research and drafts run on.
 * Recipe code runs in the recipe runtime's isolate, or in-process without one (convex/lib/recipeRuntime.ts). It
 * imports only the kernel's pure shapes, so it bundles for the isolate and loads in Convex's default runtime: no
 * Node imports here or below.
 */
import type { DealTerm } from "./terms.ts";
import { isHexColor, type ThemeDecl } from "./theme.ts";
import type { DealRole } from "../convex/lib/objects/registry.ts";
import type { Channel, DealStage, KeeperInput, KeeperReport, Prep, PrepInput, Prospect, Thread } from "../convex/lib/plays/model.ts";
import type { DraftCheck, DraftInput, IcpPov, PointOfView } from "../convex/lib/plays/drafts.ts";
import type { ResearchSubject } from "../convex/lib/plays/research.ts";
import type { FetchedPage } from "../convex/lib/research/agentLoop.ts";
import { PEOPLE_RESEARCH_MAX } from "../convex/lib/plays/peopleResearch.ts";
import type { RefreshCadence } from "../convex/lib/research/runPlan.ts";
import type { SystemOneQuestion } from "../convex/lib/segments/jev.ts";
import type { Panel, PageAction } from "./actions.ts";
import type { RecipeEval } from "./evals.ts";
import { unsafePattern } from "./regex.ts";
import type { PointId } from "./points.ts";
import type { RecipeField } from "./fields.ts";
import type { ModelPart } from "./models.ts";
import type { Template } from "./templates.ts";
import type { Kind } from "./sdk.ts";

/**
 * The recipe format this Canon reads: `engines: { canon: "2" }` in a recipe.md's frontmatter. A recipe written for
 * another format is refused before its grammar is read (docs/recipes.md, "Format changelog").
 */
export const RECIPE_FORMAT = "3";
/**
 * The sha256 of the grammar format RECIPE_FORMAT reads (`RECIPE_GRAMMAR` in recipes/md/parse.ts). A change to the
 * grammar fails tests/recipeFormat.test.ts until this is updated, and a change that refuses a recipe the old grammar
 * read also bumps RECIPE_FORMAT and adds a changelog entry, so a published recipe fails with one clear line.
 */
export const RECIPE_GRAMMAR_SHA256 = "ca117df72b1090e113b534ab812768bcd11c996c9992c902912bf169529b26e3";

export const RECIPE_IDS = ["canon-base", "fsgtm-enterprise-deal", "canon-ledger", "canon-plain-html"] as const;
/** A first-party recipe, in this repo. An installed package's id is namespaced instead: `@fsgtm/velocity-deal`. */
export type RecipeId = (typeof RECIPE_IDS)[number];

/** The records whose page a recipe lays out, each its own point (`deal.page`, `account.page`, `contact.page`). */
export const PAGE_OBJECTS = ["deal", "account", "contact"] as const;
export type PageObject = (typeof PAGE_OBJECTS)[number];

/** The deal play's sections, drawn by `DealPlay` (src/components/crm/deal-play.tsx). */
export const PLAY_COMPONENTS = ["queue", "summary", "stageRail", "fanOut", "prep", "plan", "keeper", "brief", "accountMap", "touches"] as const;
export type PlayComponent = (typeof PLAY_COMPONENTS)[number];
/**
 * The record's own pieces, drawn by the record page. `fieldGrid` is all of them in one block (its fields grouped as the
 * default page groups them); a page can instead place `fields` groups, `timeline`, `history` and `related` itself.
 * Each draws what its object has: an account's timeline holds its signals and deals, a contact's its LinkedIn events.
 * A deal also has its products, its credit splits and the panels its workspace's apps add (`apps`).
 */
export const RECORD_COMPONENTS = ["fieldGrid", "fields", "timeline", "history", "related", "products", "splits", "apps"] as const;
export type RecordComponent = (typeof RECORD_COMPONENTS)[number];
/** The pieces of an account's or a contact's page past its fields, drawn by the record page. */
export const PARTY_COMPONENTS = ["header", "fitBar", "whyFit", "scoreHistory", "topSignals", "companyDeals", "peopleAcrossDeals", "aiFields", "callPanel", "composeEmail"] as const;
export type PartyComponent = (typeof PARTY_COMPONENTS)[number];
export const PAGE_COMPONENTS = [...PLAY_COMPONENTS, ...RECORD_COMPONENTS, ...PARTY_COMPONENTS] as const;
/** The kernel components a page is built from. */
export type PageComponent = (typeof PAGE_COMPONENTS)[number];
/** The components each object's page can place. */
export const COMPONENTS = {
  deal: ["header", ...PLAY_COMPONENTS, ...RECORD_COMPONENTS],
  account: ["header", "fitBar", "fields", "whyFit", "scoreHistory", "timeline", "topSignals", "companyDeals", "peopleAcrossDeals", "related", "history"],
  contact: ["header", "fields", "aiFields", "related", "callPanel", "composeEmail", "timeline", "history"],
} as const satisfies Record<PageObject, readonly PageComponent[]>;
export type ComponentOf<O extends PageObject> = (typeof COMPONENTS)[O][number];
export const isComponentOf = (object: PageObject, component: string): component is PageComponent => (COMPONENTS[object] as readonly string[]).includes(component);
/**
 * A section that draws inside the one before it when it follows it: the score history sits in the fit's panel, and
 * the fit bar beside the record's title. Placed anywhere else, each draws on its own.
 */
export const HOLDS: Partial<Record<PageComponent, readonly PageComponent[]>> = { header: ["fitBar"], whyFit: ["scoreHistory"] };
/** The sections that read beside a run of fields sections, in the right-hand column; any other section takes the page's width. */
export const BESIDE: Readonly<Record<PageObject, readonly PageComponent[]>> = {
  deal: ["timeline", "history"],
  account: ["timeline", "history", "whyFit", "scoreHistory", "topSignals"],
  contact: ["timeline", "history", "aiFields", "related", "callPanel", "composeEmail"],
};

/**
 * The parts a component draws that a section's `show=` can pick, in the order they draw. A section without `show=`
 * draws them all; with it, only those it names.
 */
export const PARTS: Partial<Record<PageComponent, readonly string[]>> = { summary: ["health", "amount", "closeDate", "owner", "research"] };
/** Whether `section` draws `part`. */
export const showsPart = (section: PageSection, part: string): boolean => !section.show || section.show.includes(part);

/** What a deal page drew around its recipe before C1, and every recipe since places itself. */
export const DEAL_FRAME: readonly PageComponent[] = ["header", "products", "splits", "apps"];

/** In a `fields` section's list, every field of the object that no section of the page names. */
export const REST_FIELDS = "rest";

/** What each component takes besides the props every section has. */
type ComponentProps = { [K in PageComponent]: K extends "fields" ? { title: string; fields: readonly string[] } : { title?: string } };
/**
 * One section of a page: a kernel component and its props. `when` shows it only in those stages, on a deal's page;
 * `collapsed` starts it folded; `show` picks which of its component's PARTS it draws. A `fields` section lists field api names, and `rest`. `actions` are what a person can
 * do there, in the recipe's order (recipes/actions.ts); a section without them offers none.
 */
export type PageSection = {
  [K in PageComponent]: { component: K; when?: { stage?: readonly DealStage[]; notStage?: readonly DealStage[] }; collapsed?: boolean; show?: readonly string[]; actions?: readonly PageAction[] } & ComponentProps[K];
}[PageComponent];
export type FieldsSection = Extract<PageSection, { component: "fields" }>;
/** A page as a recipe lays it out (the `deal.page`, `account.page` or `contact.page` point): its sections in order. */
export type PageSpec = readonly PageSection[];
/** Where a recipe definition holds each object's page. */
export const PAGE_KEYS = { deal: "dealPage", account: "accountPage", contact: "contactPage" } as const satisfies Record<PageObject, string>;
/** A recipe's page for `object`, empty when it lays out none. */
export const pageOf = (recipe: Partial<Pick<RecipeDefinition, (typeof PAGE_KEYS)[PageObject]>>, object: PageObject): PageSpec => recipe[PAGE_KEYS[object]] ?? [];

/** Whether a section shows at `stage`. Before the stage is known (or with no plays), only `stage` lists hide it. */
export function shows(section: PageSection, stage: DealStage | null): boolean {
  const w = section.when;
  if (!w) return true;
  if (w.stage && !(stage !== null && w.stage.includes(stage))) return false;
  return !(w.notStage && stage !== null && w.notStage.includes(stage));
}

export const isFieldsSection = (s: PageSection): s is FieldsSection => s.component === "fields";

/** A section's own actions, outside any panel. */
export const sectionActions = (section: PageSection): readonly PageAction[] => (section.actions ?? []).filter((a) => !a.panel);
/** A panel's actions, from whichever section of the page holds them: the draft panel also opens outside its section. */
export const panelActions = (page: PageSpec, panel: Panel): readonly PageAction[] => page.flatMap((s) => (s.actions ?? []).filter((a) => a.panel === panel));

/** A page's `fields` section filled from the object's fields. */
export type FieldGroup<F> = { section: FieldsSection; fields: F[] };

/**
 * The page's field sections filled from `fields` (the object's shown fields, in their order), in section order.
 * `rest` takes every field no section names, so a custom field always shows; a name the object lacks is skipped.
 */
export function groupFields<F extends { apiName: string }>(page: PageSpec, fields: readonly F[]): FieldGroup<F>[] {
  const sections = page.filter(isFieldsSection);
  const named = new Set(sections.flatMap((s) => s.fields));
  const byName = new Map(fields.map((f) => [f.apiName, f]));
  return sections.map((section) => ({
    section,
    fields: section.fields.flatMap((name) => (name === REST_FIELDS ? fields.filter((f) => !named.has(f.apiName)) : byName.has(name) ? [byName.get(name)!] : [])),
  }));
}

/**
 * Why a page's sections don't hold together, each problem with the index of its section: a `fields` section with no
 * fields, a field in two sections, or `rest` not listed exactly once, which would leave a custom field nowhere.
 */
export function pageProblems(page: PageSpec): Array<{ section: number; message: string }> {
  const out: Array<{ section: number; message: string }> = [];
  const seen = new Set<string>();
  let rest = -1;
  page.forEach((s, i) => {
    if (!isFieldsSection(s)) return;
    if (!s.fields.length) out.push({ section: i, message: `section ${s.title} names no fields` });
    for (const f of s.fields) {
      if (f === REST_FIELDS) {
        if (rest >= 0) out.push({ section: i, message: `only one section lists ${REST_FIELDS}` });
        rest = i;
      } else if (seen.has(f)) out.push({ section: i, message: `field ${f} is in more than one section` });
      seen.add(f);
    }
  });
  const first = page.findIndex(isFieldsSection);
  if (first >= 0 && rest < 0) out.push({ section: first, message: `one fields section must list ${REST_FIELDS}, so every field shows` });
  return out;
}

export type StageInput = { probability: number | null; members: ReadonlyArray<{ thread: Thread }> };
/**
 * A contact AI field people research runs on each person. `judgment`: no page states it outright (a goal, the
 * systems someone runs), so it is answered as a cited inference. `replaces`: earlier default questions, so a
 * workspace field still asking one of them moves to `question`; a question someone wrote stays.
 */
export type PeopleField = { slug: string; label: string; kind: "qa"; answerType: "text" | "boolean"; question: string; judgment?: boolean; replaces?: readonly string[] };
export type CapabilityInput = {
  company: string;
  /** What the seller sells and how it differs: the deal's brief, the ICP's point of view and its offer. */
  product: string;
  people: Array<{ contactId: string; name: string; title: string | null; goal: string | null; systems: string | null }>;
};

/**
 * The fields of the model's answer a prompt describes in its ```output block, as `key: description`. The answer's
 * shape is the kernel's, which stores it; what each field asks for is the recipe's. A description is a template on
 * `settings` and `kernel`, like a prompt.
 */
export const OUTPUTS = {
  "drafts.prompt": ["subject"],
  "drafts.reviewPrompt": ["relevant", "pointOfView", "surprising", "wouldReply", "note"],
  "research.briefPrompt": ["whyNow", "alphaHypothesis", "alphaPitch", "item", "persona", "angle"],
} as const;
export type Output<P extends keyof typeof OUTPUTS> = Readonly<Record<(typeof OUTPUTS)[P][number], string>>;

/**
 * Kernel ceilings, by the plays data path they cap: a recipe chooses a value up to one, and the kernel never goes past
 * it whatever the recipe says. A research run's searches, reads and pages bound what one run costs; the draft input
 * caps bound a prompt; the buyers a weekly people research covers are at most one request.
 */
export const CEILINGS = {
  "research.searches": 5,
  "research.readsPerSearch": 3,
  "research.pages": 18,
  "drafts.facts": 20,
  "drafts.touches": 20,
  "people.buyers": PEOPLE_RESEARCH_MAX,
} as const;

/**
 * What queries and mutations read of a recipe's plays: plain data, resolved from the recipe's `data` against a
 * workspace's settings with no recipe code (resolveData). It crosses queries and the wire to actions.
 */
export type PlaysData = {
  terms?: readonly DealTerm[];
  qualification?: { name: string; lines: readonly { key: string; group: string; label: string }[] };
  coreRoles: readonly DealRole[];
  /** No touch either way in this many days reads as quiet. */
  quietDays: number;
  stages: Record<DealStage, { label: string; exit: string }>;
  drafts: {
    channels: readonly Channel[]; reviewed: readonly Channel[]; perCheck: number; aheadDays: number;
    /** The most verified facts and recent touches with the person a draft's input carries. */
    facts: number; touches: number;
    /** A first touch goes on the first of these Canon can reach the person on, else on the first. */
    firstTouch: readonly Channel[];
    output: Output<"drafts.prompt">;
    review: Output<"drafts.reviewPrompt">;
  };
  research: {
    /** The keeper researches the account again once research is this many days old, or `newQuestionsAfterDays` when the prep asks something new. */
    everyDays: number; newQuestionsAfterDays: number;
    /** One run's searches, results read per search, and pages kept, the home page included. */
    searches: number; readsPerSearch: number; pages: number;
    output: Output<"research.briefPrompt">;
  };
  people: {
    fields: readonly PeopleField[];
    /** How often the fields re-ask their answers: a deal's research only fills gaps. */
    refresh: RefreshCadence;
    /** Which fields say whether they're still there, their goal and their systems. */
    slugs: { employed: string; goal: string; systems: string };
    center: SystemOneQuestion;
    centerMinConfidence: number;
    capability: { tool: string; schema: object };
    /** The keeper researches the deal's first `buyers` ICP buyers once its last people research is `everyDays` old. */
    everyDays: number; buyers: number;
    /** Jev's question comparing two ICP buyers for the order they're reached in: left, right or tie. */
    fit: SystemOneQuestion;
  };
};

/**
 * A recipe's play code, bound to its settings. Rules, checks and view models are pure; prompts are text the kernel
 * sends on the acting person's plan. Only runCalls (run.ts) calls it, in the recipe runtime or, for a first-party
 * recipe without one, in-process.
 */
export type PlayCode = {
  stage(input: StageInput): DealStage;
  keeper(input: KeeperInput): KeeperReport;
  prep(input: PrepInput): Prep;
  fanOut(rows: ReadonlyArray<Omit<Prospect, "suggested">>): Prospect[];
  pointOfView(icpIds: readonly string[], icps: readonly IcpPov[]): PointOfView | null;
  drafts: {
    prompt(input: DraftInput): string;
    reviewPrompt(input: Pick<DraftInput, "channel" | "person" | "company" | "pointOfView">, draft: { subject?: string; body: string }): string;
    check(channel: Channel, subject: string | null, body: string): DraftCheck[];
  };
  research: {
    planPrompt(subject: ResearchSubject, year: number): string;
    briefPrompt(subject: ResearchSubject, pages: readonly FetchedPage[], today: string): string;
  };
  people: {
    capability: { prompt(input: CapabilityInput): string; clean(raw: unknown, contactIds: readonly string[]): Map<string, string | null> };
    productContext(brief: { context: string | null }, pointOfView: Pick<PointOfView, "icpName" | "text" | "offer"> | null): string | null;
  };
  /** What the code registers and the hash of the recipe.md it was built from, which an install checks. */
  about(): RecipeAbout;
};

export type RecipeAbout = { names: Array<{ kind: string; name: string }>; markdown: string | null };

/** Data and code together, as tests and the dev seed use a first-party recipe. */
export type Plays = PlaysData & PlayCode;

/** A setting's value as stored and sent: a number, a string, a yes or no, or a list of strings or of whole numbers. */
export type SettingValue = number | string | boolean | readonly string[] | readonly number[];
export type Settings = Readonly<Record<string, SettingValue>>;

/** The editor a setting gets, decided by its value's type: a number can't be described as a phrase list. */
type KindOf<T> =
  T extends number ? { kind: "int"; min: number; max: number } | { kind: "number"; min: number; max: number; step: number }
  : T extends readonly DealRole[] ? { kind: "roles"; options: readonly DealRole[] }
  : T extends readonly Channel[] ? { kind: "channels"; options: readonly Channel[] }
  : T extends string ? { kind: "phrases"; maxLength: number } | { kind: "text"; minLength: number; maxLength: number } | { kind: "color" } | { kind: "choice"; options: readonly string[] }
  : T extends boolean ? { kind: "bool" }
  : T extends readonly number[] ? { kind: "ints"; min: number; max: number; maxItems: number }
  : never;
type About<K> = { key: K; label: string; help: string; group: string };
/** A descriptor without its recipe's types, as the settings form and the wire see it. */
export type AnyDescriptor = About<string> & (KindOf<number> | KindOf<readonly DealRole[]> | KindOf<readonly Channel[]> | KindOf<string> | KindOf<boolean> | KindOf<readonly number[]>
  | { kind: "rules"; options: readonly string[] } | { kind: "levels"; options: readonly string[] });

/** A value in a recipe's `data`: a literal, or `{ setting }`, the workspace's value of a setting of that type. */
type KeysOf<S, T> = { [K in keyof S & string]: S[K] extends T ? K : never }[keyof S & string];
export type Bind<T, S> = T | { setting: KeysOf<S, T> };

/** A recipe's PlaysData as it declares it, each bindable value a literal or a setting (BINDABLE lists where). */
export type DataSpec<S> = {
  qualification?: PlaysData["qualification"];
  terms?: PlaysData["terms"];
  coreRoles: Bind<readonly DealRole[], S>;
  quietDays: Bind<number, S>;
  stages: Record<DealStage, { label: Bind<string, S>; exit: Bind<string, S> }>;
  drafts: Pick<PlaysData["drafts"], "output" | "review"> & {
    channels: Bind<readonly Channel[], S>; reviewed: Bind<readonly Channel[], S>; perCheck: Bind<number, S>; aheadDays: Bind<number, S>;
    facts: Bind<number, S>; touches: Bind<number, S>; firstTouch: Bind<readonly Channel[], S>;
  };
  research: Pick<PlaysData["research"], "output"> & {
    everyDays: Bind<number, S>; newQuestionsAfterDays: Bind<number, S>; searches: Bind<number, S>; readsPerSearch: Bind<number, S>; pages: Bind<number, S>;
  };
  people: Omit<PlaysData["people"], "fields" | "centerMinConfidence" | "everyDays" | "buyers"> & {
    fields: ReadonlyArray<Omit<PeopleField, "label" | "question"> & { label: Bind<string, S>; question: Bind<string, S> }>;
    centerMinConfidence: Bind<number, S>;
    everyDays: Bind<number, S>; buyers: Bind<number, S>;
  };
};

/** Where a binding may sit in `data`, and the setting kinds it may name. `*` is any one key or index. */
export const BINDABLE: Readonly<Record<string, readonly AnyDescriptor["kind"][]>> = {
  "coreRoles": ["roles"],
  "quietDays": ["int"],
  "stages.*.label": ["text"],
  "stages.*.exit": ["text"],
  "drafts.channels": ["channels"],
  "drafts.reviewed": ["channels"],
  "drafts.perCheck": ["int"],
  "drafts.aheadDays": ["int"],
  "drafts.facts": ["int"],
  "drafts.touches": ["int"],
  "drafts.firstTouch": ["channels"],
  "research.everyDays": ["int"],
  "research.newQuestionsAfterDays": ["int"],
  "research.searches": ["int"],
  "research.readsPerSearch": ["int"],
  "research.pages": ["int"],
  "people.fields.*.label": ["text"],
  "people.fields.*.question": ["text"],
  "people.centerMinConfidence": ["number", "int"],
  "people.everyDays": ["int"],
  "people.buyers": ["int"],
};

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isBinding = (x: unknown): x is { setting: string } => isRecord(x) && Object.keys(x).length === 1 && typeof x.setting === "string";

/** Every `{ setting }` in `data`, with its path (`people.fields.1.question`). */
export function bindingsOf(data: unknown, path = ""): Array<{ path: string; key: string }> {
  if (isBinding(data)) return [{ path, key: data.setting }];
  const at = (k: string | number) => (path ? `${path}.${k}` : String(k));
  if (Array.isArray(data)) return data.flatMap((x, i) => bindingsOf(x, at(i)));
  return isRecord(data) ? Object.entries(data).flatMap(([k, x]) => bindingsOf(x, at(k))) : [];
}

/** `data` with each binding replaced by its setting's value. Pure data in, pure data out: no recipe code runs. */
export function resolveData<S>(data: DataSpec<S>, settings: Settings): PlaysData {
  const walk = (x: unknown): unknown =>
    isBinding(x) ? settings[x.setting] : Array.isArray(x) ? x.map(walk) : isRecord(x) ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, walk(v)])) : x;
  return walk(data) as PlaysData;
}

export const RECIPE_OBJECTS = ["deal", "contact", "account", "observations", "icps"] as const;
export const RECIPE_SOURCES = ["web_search", "read_site"] as const;
/** What an install screen shows a recipe asks for. Recipe code only ever sees the inputs a play call sends it. */
export type Permissions = {
  read: readonly (typeof RECIPE_OBJECTS)[number][];
  /** The points it contributes to (recipes/points.ts), which a recipe.md lists as `contributes`. */
  slots: readonly PointId[];
  /** "owner": prompts run on the acting person's model plan. */
  llm: "owner" | "none";
  sources: readonly (typeof RECIPE_SOURCES)[number][];
};

/** Settings whose every key binds any type: what a recipe's data looks like once its own settings type is erased. */
type Erased = { readonly [key: string]: never };
/** A recipe's plays data as it declares it, with bindings to its settings. */
export type BoundData = DataSpec<Erased>;

/**
 * A recipe in the registry, built from its markdown (recipes/compose.ts). `settings` are its defaults and
 * `settingsSchema` lists every one in form order. `data` is the plays data with bindings to settings, and `code`
 * binds the play code to a set of settings that `parseOverrides` has checked; both are null for a recipe without
 * plays. An installed package's `code` is null too: its code is the package's bundle, which runs only in the runtime.
 * `evals` are play calls whose results must keep matching on any settings a workspace runs.
 */
export type RecipeDefinition = {
  id: string;
  version: string;
  title: string;
  description: string;
  author: { org: string; kind: "canon" | "agency" };
  permissions: Permissions;
  settings: Settings;
  settingsSchema: readonly AnyDescriptor[];
  dealPage: PageSpec;
  /** The workspace theme it contributes (recipes/theme.ts), its values bound to settings; null for none. */
  theme: ThemeDecl | null;
  /** Empty when the recipe lays out no account page; the workspace's account.page then comes from another recipe. */
  accountPage: PageSpec;
  contactPage: PageSpec;
  /** What it contributes at each model point it fills (recipes/models.ts): the built-in tables the point reads. */
  models: Readonly<Partial<Record<PointId, ModelPart>>>;
  /** The rows it offers a workspace to install (recipes/templates.ts). */
  templates: readonly Template[];
  /** The AI fields it offers, from its ```ai-fields block (recipes/fields.ts). */
  fields: readonly RecipeField[];
  data: BoundData | null;
  code: ((settings: Settings) => PlayCode) | null;
  evals: readonly RecipeEval[];
};

/** The plays logic runs, and the kind of registered function each takes (recipes/sdk.ts). */
export const LOGIC_PLAYS = {
  stage: "viewModel", keeper: "rule", prep: "viewModel", fanOut: "viewModel", pointOfView: "viewModel",
  "drafts.check": "check", "people.productContext": "viewModel", "people.capability.clean": "parse",
} as const satisfies Record<string, Kind>;
export type LogicPlay = keyof typeof LOGIC_PLAYS;
/** The plays a recipe writes as prompts, and how many arguments each call passes. */
export const PROMPT_ARITY = { "drafts.prompt": 1, "drafts.reviewPrompt": 2, "research.planPrompt": 2, "research.briefPrompt": 3, "people.capability.prompt": 1 } as const;
export type PromptPlay = keyof typeof PROMPT_ARITY;
export const PROMPT_PLAYS = Object.keys(PROMPT_ARITY) as readonly PromptPlay[];

const BINDABLE_AT = Object.entries(BINDABLE).map(([pattern, kinds]) => ({ re: new RegExp(`^${pattern.replace(/\./g, "\\.").replace(/\*/g, "[^.]+")}$`), kinds }));

/**
 * Why `data`'s bindings don't fit `schema`: a binding to no setting, at a place that can't be bound, of the wrong kind,
 * or to a setting a workspace could set past the kernel's ceiling there.
 */
export function bindingProblems(data: unknown, schema: readonly AnyDescriptor[]): string[] {
  const byKey = new Map(schema.map((d) => [d.key, d]));
  return bindingsOf(data).flatMap(({ path, key }) => {
    const d = byKey.get(key);
    const at = BINDABLE_AT.find((b) => b.re.test(path));
    if (!d) return [`data.${path} binds "${key}", which is not a setting`];
    if (!at) return [`data.${path} can't be bound to a setting`];
    if (!at.kinds.includes(d.kind)) return [`data.${path} needs a ${at.kinds.join(" or ")} setting, and "${key}" is ${d.kind}`];
    const ceiling = Object.hasOwn(CEILINGS, path) ? CEILINGS[path as keyof typeof CEILINGS] : null;
    return ceiling !== null && "max" in d && d.max > ceiling ? [`data.${path} binds "${key}", whose limits go to ${d.max}; the kernel's ceiling there is ${ceiling}`] : [];
  });
}

/** A value the descriptor accepts, normalized (lists deduped, in the descriptor's order), or why not. */
export function checkSetting(d: AnyDescriptor, value: unknown): { ok: true; value: SettingValue } | { ok: false; error: string } {
  const no = (error: string) => ({ ok: false as const, error });
  switch (d.kind) {
    case "int":
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value) || (d.kind === "int" && !Number.isInteger(value))) return no(d.kind === "int" ? "a whole number" : "a number");
      return value < d.min || value > d.max ? no(`between ${d.min} and ${d.max}`) : { ok: true, value };
    case "ints":
      if (!Array.isArray(value) || !value.length || value.length > d.maxItems || !value.every((x) => Number.isInteger(x) && x >= d.min && x <= d.max)) {
        return no(`1 to ${d.maxItems} whole numbers between ${d.min} and ${d.max}`);
      }
      return { ok: true, value: [...value] as number[] };
    case "bool":
      return typeof value === "boolean" ? { ok: true, value } : no("yes or no");
    case "roles":
    case "channels":
    case "rules":
    case "levels": {
      const options: readonly string[] = d.options;
      if (!Array.isArray(value) || !value.every((x) => typeof x === "string" && options.includes(x))) return no(`a list of ${options.join(", ")}`);
      return { ok: true, value: options.filter((o) => value.includes(o)) };
    }
    case "phrases": {
      if (typeof value !== "string" || !value.trim()) return no("a pattern");
      if (value.length > d.maxLength) return no(`at most ${d.maxLength} characters`);
      try { new RegExp(value, "i"); } catch (e) { return no(`a valid pattern (${e instanceof Error ? e.message.replace(/^Invalid regular expression: \/[\s\S]*\/[a-z]*: /, "").toLowerCase() : "it doesn't compile"})`); }
      const unsafe = unsafePattern(value);
      return unsafe ? no(`a pattern that can't stall on long text (it has ${unsafe})`) : { ok: true, value };
    }
    case "text": {
      const text = typeof value === "string" ? value.trim() : "";
      return text.length < d.minLength || text.length > d.maxLength ? no(`${d.minLength} to ${d.maxLength} characters`) : { ok: true, value: text };
    }
    case "color": {
      const color = typeof value === "string" ? value.trim().toLowerCase() : "";
      return isHexColor(color) ? { ok: true, value: color } : no("a colour like #1e4d3a");
    }
    case "choice":
      return typeof value === "string" && d.options.includes(value) ? { ok: true, value } : no(`one of ${d.options.join(", ")}`);
  }
}

export const sameSetting = (a: SettingValue, b: SettingValue): boolean =>
  Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((x, i) => x === b[i]) : a === b;

/**
 * A workspace's overrides, checked against the recipe's schema: what passes (minus values equal to the default)
 * and, per key, why the rest didn't. Unknown keys are errors too.
 */
export function parseOverrides(recipe: RecipeDefinition, raw: unknown): { overrides: Settings; errors: Array<{ key: string; error: string }> } {
  const overrides: Record<string, SettingValue> = {};
  const errors: Array<{ key: string; error: string }> = [];
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  for (const [key, value] of Object.entries(input)) {
    const d = recipe.settingsSchema.find((x) => x.key === key);
    if (!d) { errors.push({ key, error: "not a setting of this customization" }); continue; }
    const checked = checkSetting(d, value);
    if (!checked.ok) errors.push({ key, error: `${d.label} must be ${checked.error}` });
    else if (!sameSetting(checked.value, recipe.settings[key])) overrides[key] = checked.value;
  }
  return { overrides, errors };
}

/** Each setting whose value in force differs between two sets of overrides, in schema order. */
export function diffSettings(recipe: RecipeDefinition, from: Settings, to: Settings): Array<{ key: string; from: SettingValue; to: SettingValue }> {
  return recipe.settingsSchema.flatMap(({ key }) => {
    const a = from[key] ?? recipe.settings[key], b = to[key] ?? recipe.settings[key];
    return sameSetting(a, b) ? [] : [{ key, from: a, to: b }];
  });
}
