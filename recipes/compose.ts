/**
 * A compiled recipe.md and its TypeScript, put together (docs/recipes.md, "Writing a recipe"). Each play runs what the
 * markdown says: a prompt renders its template, a ```logic line runs a Canon built-in (recipes/builtins.ts) or a
 * function the TypeScript registered (recipes/sdk.ts). The same code runs in-process for a first-party recipe and in
 * the recipe runtime's isolate for a package, so both return the same thing.
 */
import { BUILTINS } from "./builtins.ts";
import { LOGIC_PLAYS, PROMPT_PLAYS, type LogicPlay, type PlayCode, type PromptPlay, type RecipeAbout, type RecipeDefinition, type Settings } from "./kernel.ts";
import type { CompiledRecipe, Runnable, Source } from "./md/parse.ts";
import { runCalls, type CallResult, type PlayCall } from "./run.ts";
import type { Extension, Kind, Registration } from "./sdk.ts";
import { KERNEL_CONSTANTS, render } from "./template.ts";

type Fn = (...args: unknown[]) => unknown;

/** The names a recipe's markdown expects its TypeScript to register, each once. */
export function codeNames(r: Pick<CompiledRecipe, "logic">): Array<{ kind: Kind; name: string; line: number }> {
  const seen = new Set<string>();
  return Object.values(r.logic).flat().flatMap((s) => {
    const key = `${s!.kind} ${s!.name}`;
    if (s!.name.startsWith("canon.") || seen.has(key)) return [];
    seen.add(key);
    return [{ kind: s!.kind, name: s!.name, line: s!.line }];
  });
}

/** Each registered function by `<kind> <name>`. Two packages files registering the same name is an error. */
function registry(extensions: readonly Extension[]): Map<string, Registration> {
  const out = new Map<string, Registration>();
  for (const r of extensions.flatMap((e) => e.registrations)) {
    const key = `${r.kind} ${r.name}`;
    if (out.has(key)) throw new Error(`${key} is registered twice`);
    out.set(key, r);
  }
  return out;
}

/**
 * Why the markdown and the TypeScript don't fit: a name the markdown uses that nothing registers, or one the
 * TypeScript registers that the markdown never uses. Each comes with the markdown line, or with no line.
 */
export function nameProblems(recipe: Pick<CompiledRecipe, "logic">, extensions: readonly Extension[]): Array<{ line: number | null; message: string }> {
  const regs = registry(extensions);
  const used = codeNames(recipe);
  const missing = used.filter((u) => !regs.has(`${u.kind} ${u.name}`)).map((u) => ({ line: u.line, message: `${u.kind} ${u.name} is not registered by the customization's TypeScript` }));
  const unused = [...regs.values()].filter((r) => !used.some((u) => u.kind === r.kind && u.name === r.name)).map((r) => ({ line: null, message: `the TypeScript registers ${r.kind} ${r.name}, which customization.md never uses` }));
  return [...missing, ...unused];
}

/** The function a source names, taking the play call's arguments and then the settings. */
function implement(source: Source, regs: ReadonlyMap<string, Registration>): Fn {
  if (source.name.startsWith("canon.")) return BUILTINS[source.name].make(source.config) as Fn;
  const r = regs.get(`${source.kind} ${source.name}`);
  if (!r) throw new Error(`${source.kind} ${source.name} is not registered by the customization's TypeScript`);
  return r.fn as Fn;
}

/** `_` spreads the argument's fields into the prompt's scope; any other name binds the whole argument. */
function scopeOf(names: readonly string[], args: readonly unknown[], settings: Settings): Record<string, unknown> {
  const v: Record<string, unknown> = { settings, kernel: KERNEL_CONSTANTS };
  names.forEach((n, i) => { if (n === "_") Object.assign(v, args[i]); else v[n] = args[i]; });
  return v;
}

/** The recipe's play code bound to `settings`. */
export function playCode(recipe: Runnable, extensions: readonly Extension[], markdown: string | null = null): (settings: Settings) => PlayCode {
  const regs = registry(extensions);
  const logic = new Map((Object.keys(LOGIC_PLAYS) as LogicPlay[]).map((play) => [play, (recipe.logic[play] ?? []).map((s) => implement(s, regs))]));
  const about: RecipeAbout = { names: [...regs.values()].map(({ kind, name }) => ({ kind, name })), markdown };
  const templates = Object.fromEntries(Object.entries(recipe.prompts).map(([id, p]) => [id, p.paragraphs]));
  return (s) => {
    const missing = (fn: string) => () => { throw new Error(`${fn} is not implemented by this customization`); };
    const prompt = (id: PromptPlay): Fn => (recipe.prompts[id] ? (...args) => render(templates, id, scopeOf(recipe.prompts[id].args, args, s)) : missing(id));
    const one = (play: LogicPlay): Fn => { const fn = logic.get(play)![0]; return fn ? (...args) => fn(...args, s) : missing(play); };
    const checks = logic.get("drafts.check")!;
    return {
      stage: one("stage"), keeper: one("keeper"), prep: one("prep"), fanOut: one("fanOut"), pointOfView: one("pointOfView"),
      drafts: {
        prompt: prompt("drafts.prompt"), reviewPrompt: prompt("drafts.reviewPrompt"),
        check: (channel, subject, body) => checks.flatMap((fn) => fn({ channel, subject, body }, s) as ReturnType<PlayCode["drafts"]["check"]>),
      },
      research: { planPrompt: prompt("research.planPrompt"), briefPrompt: prompt("research.briefPrompt") },
      people: { capability: { prompt: prompt("people.capability.prompt"), clean: one("people.capability.clean") }, productContext: one("people.productContext") },
      about: () => about,
    } as PlayCode;
  };
}

/** What a bundle's `run(settings, calls)` does: the recipe's calls against its play code on those settings. */
export const runRecipe = (recipe: Runnable, extensions: readonly Extension[], settings: Settings, calls: readonly PlayCall[], markdown: string | null): CallResult[] =>
  runCalls(playCode(recipe, extensions, markdown)(settings), calls);

/** The runtime part of a compiled recipe: only what its play code reads, so a bundle carries no more. */
export const runnable = (r: CompiledRecipe): Runnable => ({ prompts: r.prompts, logic: r.logic });

/** A first-party recipe as the registry holds it: its markdown and its TypeScript, run in-process. */
export function recipeOf(r: CompiledRecipe, extensions: readonly Extension[]): RecipeDefinition {
  const code = r.data ? playCode(runnable(r), extensions) : null;
  return Object.freeze({
    id: r.meta.id, version: r.meta.version, title: r.meta.title, description: r.meta.description, author: r.meta.author, permissions: r.meta.permissions,
    settings: r.defaults, settingsSchema: r.settingsSchema, dealPage: r.dealPage, theme: r.theme ?? null, accountPage: r.accountPage, contactPage: r.contactPage, models: r.models, templates: r.templates, fields: r.fields, data: r.data, code, evals: r.evals,
  });
}

/** The literal Canon's built-ins bundle carries where a markdown-only recipe goes (scripts/build-recipes.ts). */
export const RECIPE_PLACEHOLDER = "__CANON_RECIPE__";

/**
 * A markdown-only package's bundle: Canon's built-ins bundle with the recipe in place of its placeholder. No build
 * step runs, so Convex makes it at install time; the same recipe.md on the same built-ins gives the same bundle.
 */
export function markdownBundle(builtins: string, r: CompiledRecipe, markdown: string): string {
  const literal = JSON.stringify(RECIPE_PLACEHOLDER);
  const at = builtins.indexOf(literal);
  if (at < 0 || builtins.indexOf(literal, at + 1) >= 0) throw new Error("Canon's built-ins bundle must hold its customization placeholder exactly once");
  return builtins.slice(0, at) + JSON.stringify({ recipe: runnable(r), markdown }) + builtins.slice(at + literal.length);
}

/** Which plays a recipe writes as markdown, runs on Canon's built-ins, or runs as code, as the install screen lists them. */
export type Part = { play: string; from: "prompt" | "builtin" | "code"; name: string };
export function partsOf(r: Pick<CompiledRecipe, "prompts" | "logic">): Part[] {
  return [
    ...PROMPT_PLAYS.filter((p) => r.prompts[p]).map((play): Part => ({ play, from: "prompt", name: play })),
    ...(Object.keys(LOGIC_PLAYS) as LogicPlay[]).flatMap((play) => (r.logic[play] ?? []).map((s): Part => ({ play, from: s.name.startsWith("canon.") ? "builtin" : "code", name: `${s.kind} ${s.name}` }))),
  ];
}
