/**
 * The one way the kernel runs a recipe's play code (docs/recipes.md, R3): a batch of named calls against play code bound
 * to a set of settings. The same function runs in the recipe runtime's isolate (bundled with each recipe by
 * scripts/build-recipes.ts) and in-process (convex/lib/recipeRuntime.ts), so both return the same results.
 * Inputs and results are plain JSON: they cross the wire.
 */
import type { Channel, DealStage, KeeperInput, KeeperReport, Prep, PrepInput, Prospect } from "../convex/lib/plays/model.ts";
import type { DraftCheck, DraftInput, IcpPov, PointOfView } from "../convex/lib/plays/drafts.ts";
import type { ResearchSubject } from "../convex/lib/plays/research.ts";
import type { FetchedPage } from "../convex/lib/research/agentLoop.ts";
import type { CapabilityInput, PlayCode, RecipeAbout, StageInput } from "./kernel.ts";

type Signature<A extends unknown[], R> = { args: A; result: R };

/** Every play function the kernel may call, by path, with its arguments and its result as JSON. */
export type PlayFns = {
  keeper: Signature<[KeeperInput], KeeperReport>;
  prep: Signature<[PrepInput], Prep>;
  stage: Signature<[StageInput], DealStage>;
  fanOut: Signature<[ReadonlyArray<Omit<Prospect, "suggested">>], Prospect[]>;
  pointOfView: Signature<[readonly string[], readonly IcpPov[]], PointOfView | null>;
  "drafts.prompt": Signature<[DraftInput], string>;
  "drafts.reviewPrompt": Signature<[Pick<DraftInput, "channel" | "person" | "company" | "pointOfView">, { subject?: string; body: string }], string>;
  "drafts.check": Signature<[Channel, string | null, string], DraftCheck[]>;
  "research.planPrompt": Signature<[ResearchSubject, number], string>;
  "research.briefPrompt": Signature<[ResearchSubject, readonly FetchedPage[], string], string>;
  "people.productContext": Signature<[{ context: string | null }, Pick<PointOfView, "icpName" | "text" | "offer"> | null], string | null>;
  "people.capability.prompt": Signature<[CapabilityInput], string>;
  /** A Map doesn't survive JSON, so the cleaned capabilities come back as entries. */
  "people.capability.clean": Signature<[unknown, readonly string[]], Array<[string, string | null]>>;
  /** Not a play: what an install asks a bundle to check it against its recipe.md. */
  "recipe.about": Signature<[], RecipeAbout>;
};
export type PlayFn = keyof PlayFns;

/**
 * One call. `with` fills keys of the first argument from earlier calls' results, so a call that needs another's
 * output still travels in the same batch: `{ windowDays: { call: 1, field: "windowDays" } }`.
 */
export type PlayCall = { [F in PlayFn]: { fn: F; input: PlayFns[F]["args"]; with?: Record<string, { call: number; field: string }> } }[PlayFn];
export type CallError = { kind: "unknown_fn" | "bad_input" | "threw" | "dependency"; message: string };
export type CallResult = { ok: true; value: unknown } | { ok: false; error: CallError };

/** What a batch of calls returns, position by position. */
export type ResultsOf<C extends readonly PlayCall[]> = { [K in keyof C]: C[K] extends { fn: infer F extends PlayFn } ? PlayFns[F]["result"] : never };

const FNS: { [F in PlayFn]: (code: PlayCode, args: PlayFns[F]["args"]) => PlayFns[F]["result"] } = {
  keeper: (p, [input]) => p.keeper(input),
  prep: (p, [input]) => p.prep(input),
  stage: (p, [input]) => p.stage(input),
  fanOut: (p, [rows]) => p.fanOut(rows),
  pointOfView: (p, [icpIds, icps]) => p.pointOfView(icpIds, icps),
  "drafts.prompt": (p, [input]) => p.drafts.prompt(input),
  "drafts.reviewPrompt": (p, [input, draft]) => p.drafts.reviewPrompt(input, draft),
  "drafts.check": (p, [channel, subject, body]) => p.drafts.check(channel, subject, body),
  "research.planPrompt": (p, [subject, year]) => p.research.planPrompt(subject, year),
  "research.briefPrompt": (p, [subject, pages, today]) => p.research.briefPrompt(subject, pages, today),
  "people.productContext": (p, [brief, pov]) => p.people.productContext(brief, pov),
  "people.capability.prompt": (p, [input]) => p.people.capability.prompt(input),
  "people.capability.clean": (p, [raw, ids]) => [...p.people.capability.clean(raw, ids)],
  "recipe.about": (p) => p.about(),
};

export const PLAY_FNS = Object.keys(FNS) as readonly PlayFn[];

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

/** Run `calls` in order against `code`. A call that throws fails alone; the rest still run. */
export function runCalls(code: PlayCode, calls: readonly PlayCall[]): CallResult[] {
  const results: CallResult[] = [];
  for (const call of calls) {
    const fn = Object.hasOwn(FNS, call.fn) ? (FNS[call.fn] as (c: PlayCode, a: unknown[]) => unknown) : null;
    if (!fn) { results.push({ ok: false, error: { kind: "unknown_fn", message: `no play function ${String(call.fn)}` } }); continue; }
    if (!Array.isArray(call.input)) { results.push({ ok: false, error: { kind: "bad_input", message: `${call.fn}: input must be an argument list` } }); continue; }
    const args: unknown[] = [...call.input];
    const deps = Object.entries(call.with ?? {});
    const failed = deps.find(([, d]) => !(d.call >= 0 && d.call < results.length && results[d.call].ok));
    if (failed) { results.push({ ok: false, error: { kind: "dependency", message: `${call.fn}: ${failed[0]} needs call ${failed[1].call}, which failed or hasn't run` } }); continue; }
    if (deps.length) {
      const first = { ...(args[0] as object) } as Record<string, unknown>;
      for (const [key, d] of deps) first[key] = ((results[d.call] as { value: Record<string, unknown> }).value ?? {})[d.field];
      args[0] = first;
    }
    try {
      results.push({ ok: true, value: fn(code, args) });
    } catch (e) {
      results.push({ ok: false, error: { kind: "threw", message: `${call.fn}: ${message(e)}` } });
    }
  }
  return results;
}
