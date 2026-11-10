/**
 * What a recipe's TypeScript sees (docs/recipes.md, "Writing a recipe"), the way a pi extension sees `ExtensionAPI`.
 * A `.ts` file in a recipe package exports `defineRecipe((canon) => { ... })` and registers named functions; the
 * recipe's markdown says which play each one runs (`keeper: rule keeper`). Every function is pure: it gets the play
 * call's arguments, then the settings in force, and returns data. It runs in the recipe runtime's isolate, with no
 * network and no secrets.
 */
import type { Channel, DealStage, KeeperInput, KeeperReport, Prep, PrepInput, Prospect } from "../convex/lib/plays/model.ts";
import type { DraftCheck, IcpPov, PointOfView } from "../convex/lib/plays/drafts.ts";
import type { StageInput } from "./kernel.ts";

export { ROLE_LABEL } from "../convex/lib/committee.ts";
export { CHANNEL_LABEL, daysUntil } from "../convex/lib/plays/model.ts";
export { LINKEDIN_MAX } from "../convex/lib/plays/drafts.ts";
export type { DealRole } from "../convex/lib/objects/registry.ts";
export type { DraftCheck } from "../convex/lib/plays/drafts.ts";
export type { Channel, DealStage, Flag, KeeperInput, KeeperReport, Prep, PrepCheck, PrepInput, Prospect, Severity, Stall } from "../convex/lib/plays/model.ts";
export type { StageInput } from "./kernel.ts";

export const DAY = 86_400_000;

/** What a registered function is, which decides the plays it can run. */
export const KINDS = ["rule", "check", "viewModel", "parse"] as const;
export type Kind = (typeof KINDS)[number];

/** The draft a check reads. */
export type Draft = { channel: Channel; subject: string | null; body: string };
type Brief = { context: string | null };

/** Each view model's signature, by the play it runs: the call's arguments, then the settings. */
export type ViewModels<S> = {
  stage: (input: StageInput, settings: S) => DealStage;
  prep: (input: PrepInput, settings: S) => Prep;
  fanOut: (rows: ReadonlyArray<Omit<Prospect, "suggested">>, settings: S) => Prospect[];
  pointOfView: (icpIds: readonly string[], icps: readonly IcpPov[], settings: S) => PointOfView | null;
  "people.productContext": (brief: Brief, pointOfView: Pick<PointOfView, "icpName" | "text" | "offer"> | null, settings: S) => string | null;
};

/** The registration API, typed by the recipe's settings `S`. A name is registered once per kind. */
export type Canon<S> = {
  /** Flags on a deal: the keeper (`keeper: rule <name>`). */
  rule(name: string, fn: (input: KeeperInput, settings: S) => KeeperReport): void;
  /** Pass or fail lines on a draft (`drafts.check: check <name>`). A play may list several checks; their lines join in order. */
  check(name: string, fn: (draft: Draft, settings: S) => DraftCheck[]): void;
  /** The data a page section or a prompt reads (`prep: viewModel <name>`). Annotate the parameters: they pick the signature. */
  viewModel(name: string, fn: ViewModels<S>[keyof ViewModels<S>]): void;
  /** A model's raw answer made safe to keep (`people.capability.clean: parse <name>`). */
  parse(name: string, fn: (raw: unknown, contactIds: readonly string[], settings: S) => Map<string, string | null>): void;
};

export type Registration = { kind: Kind; name: string; fn: (...args: never[]) => unknown };
/** What a recipe's TypeScript exports: its registrations, in order. */
export type Extension = { readonly registrations: readonly Registration[] };

export const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** A recipe's TypeScript: `setup` registers its functions on `canon`. Throws on a bad or repeated name. */
export function defineRecipe<S = Record<string, never>>(setup: (canon: Canon<S>) => void): Extension {
  const registrations: Registration[] = [];
  const add = (kind: Kind) => (name: string, fn: (...args: never[]) => unknown) => {
    if (!NAME.test(name)) throw new Error(`${kind} "${name}": a name is letters, digits and _, starting with a letter`);
    if (registrations.some((r) => r.kind === kind && r.name === name)) throw new Error(`${kind} ${name} is registered twice`);
    registrations.push({ kind, name, fn });
  };
  setup({ rule: add("rule"), check: add("check"), viewModel: add("viewModel"), parse: add("parse") } as Canon<S>);
  return Object.freeze({ registrations: Object.freeze(registrations) });
}
