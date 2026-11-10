/**
 * Where recipe play code runs (docs/recipes.md, R3 and R5). Every action that runs a recipe's rules, checks, view
 * models or prompts goes through `runPlays`. With RECIPE_RUNTIME_URL set it calls the recipe runtime
 * (services/recipe-runtime), a Cloudflare isolate with no network. Without it, a first-party recipe's calls run
 * in-process, which is how the tests run; an installed package's code never runs in-process, so its calls refuse.
 * A runtime that fails or doesn't answer is an error, never a quiet fallback to in-process.
 *
 * Actions only: it may fetch. Queries and mutations read recipe data (settings, people fields) through lib/recipes.ts.
 */
import { integrationEnabled } from "./integrationsAvailable.ts";

import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { RECIPE_BUNDLES } from "../../recipes/_bundles.generated.ts";
import { runCalls, type CallResult, type PlayCall, type ResultsOf } from "../../recipes/run.ts";
import { firstPartyCode, isFirstParty, mismatch, type EvalResult, type RecipeEval, type RecipeRef, type Settings } from "../../recipes/index.ts";
import { MODULE_BODY_MAX, SIGNATURE_HEADER, TIMESTAMP_HEADER, bundleHash, sign, type ModuleBody, type ModuleResult } from "../../services/recipe-runtime/src/protocol.ts";
import { NO_PLAYS } from "./recipes.ts";

/** Per request. A deal page's batch answers in a few milliseconds; a cold isolate in well under a second. */
export const RUNTIME_TIMEOUT_MS = 5_000;

/** An installed package's bundle, loaded only when the runtime asks for the code. */
export type Bundle = { hash: string; code: () => Promise<string> };
/** What a batch runs against: a recipe on settings, and for an installed package its bundle. */
export type Target = { id: string; settings: Settings; installed: Bundle | null };

const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const fail = (message: string): never => { throw new ConvexError(`Customization runtime: ${message}`); };

const CODES_KEPT = 16;
const codes = new Map<string, string>();

/** A stored bundle's code, checked against its hash: the hash is what the admin installed. */
async function storedCode(ctx: ActionCtx, hash: string, storageId: string): Promise<string> {
  const known = codes.get(hash);
  if (known !== undefined) return known;
  const blob = await ctx.storage.get(storageId as Id<"_storage">);
  if (!blob) throw new ConvexError({ kind: "recipe_bundle_missing", hash, message: `Customization runtime: the bundle ${hash} is missing from storage` });
  const code = await blob.text();
  if ((await bundleHash(code)) !== hash) return fail(`the stored bundle doesn't match its hash ${hash}`);
  codes.set(hash, code);
  if (codes.size > CODES_KEPT) codes.delete(codes.keys().next().value!);
  return code;
}

export function isMissingBundle(error: unknown): boolean {
  return error instanceof ConvexError && typeof error.data === "object" && error.data !== null && "kind" in error.data && error.data.kind === "recipe_bundle_missing";
}

export function targetOf(ctx: ActionCtx, ref: RecipeRef): Target {
  const b = ref.bundle;
  return { id: ref.id, settings: ref.settings, installed: b ? { hash: b.hash, code: () => storedCode(ctx, b.hash, b.storageId) } : null };
}

/**
 * Run `calls` against the recipe `ref` names, on its settings, and return each call's result in order. `ctx` loads
 * an installed bundle from storage, and is required so a query or mutation can't call this. Throws a ConvexError
 * carrying NO_PLAYS for a recipe without plays, and a ConvexError naming the call for any call that fails.
 */
export async function runPlays<const C extends readonly PlayCall[]>(ctx: ActionCtx, ref: RecipeRef, calls: C): Promise<ResultsOf<C>> {
  if (!ref.plays) throw new ConvexError(NO_PLAYS);
  const results = await runSettled(targetOf(ctx, ref), calls);
  return results.map((r, i) => (r.ok ? r.value : fail(`${calls[i].fn} failed (${r.error.kind}): ${r.error.message}`))) as ResultsOf<C>;
}

/** Each call's result or its error, in order: a call that fails doesn't stop the others. */
export async function runSettled(target: Target, calls: readonly PlayCall[]): Promise<CallResult[]> {
  const url = integrationEnabled("recipeRuntime") ? process.env.RECIPE_RUNTIME_URL : undefined;
  let results: CallResult[];
  if (target.installed) {
    if (!url) return fail(`${target.id} is an installed customization, and an installed customization's code runs only in the customization runtime. This deployment has no RECIPE_RUNTIME_URL.`);
    results = await remote(url, target, target.installed, calls);
  } else {
    const bundle = isFirstParty(target.id) ? RECIPE_BUNDLES[target.id] : undefined;
    const code = firstPartyCode(target.id, target.settings);
    if (!bundle || !code) throw new ConvexError(NO_PLAYS);
    results = url ? await remote(url, target, { hash: bundle.hash, code: async () => bundle.code }, calls) : wire(runCalls(code, wire(calls)));
  }
  if (!Array.isArray(results) || results.length !== calls.length) fail(`expected ${calls.length} results, got ${Array.isArray(results) ? results.length : typeof results}`);
  return results;
}

/** `evals` on the target's settings, run where its play code runs. An eval whose call fails fails. */
export async function runEvals(target: Target, evals: readonly RecipeEval[]): Promise<EvalResult[]> {
  if (!evals.length) return [];
  const results = await runSettled(target, evals.map((e) => e.call));
  return evals.map((e, i) => {
    const r = results[i];
    const detail = r.ok ? mismatch(e.expect, r.value, target.settings) : `the call failed (${r.error.kind}): ${r.error.message}`;
    return { name: e.name, ok: detail === null, detail };
  });
}

/** POST `payload` (without the bundle) to `path`, signed, sending the bundle's code only when the runtime asks for it. */
async function post<T>(url: string, path: string, bundle: Bundle, payload: Record<string, unknown>, timeoutMs: number, what: string): Promise<T> {
  const secret = process.env.RECIPE_RUNTIME_SECRET;
  if (!secret) return fail("RECIPE_RUNTIME_URL is set but RECIPE_RUNTIME_SECRET isn't");
  const send = async (code?: string) => {
    const body = JSON.stringify({ bundle: { hash: bundle.hash, ...(code === undefined ? {} : { code }) }, ...payload });
    const timestamp = String(Date.now());
    return fetch(new URL(path, url), {
      method: "POST", body, signal: AbortSignal.timeout(timeoutMs),
      headers: { "content-type": "application/json", [TIMESTAMP_HEADER]: timestamp, [SIGNATURE_HEADER]: await sign(secret, timestamp, body) },
    });
  };
  try {
    let res = await send();
    if (res.status === 409) res = await send(await bundle.code());
    const out = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!res.ok || !out) return fail(`${what} answered ${res.status}${out?.error ? `: ${out.error}` : ""}`);
    return out;
  } catch (e) {
    if (e instanceof ConvexError) throw e;
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return fail(timedOut ? `no answer within ${timeoutMs / 1000} s` : `unreachable (${e instanceof Error ? e.message : String(e)})`);
  }
}

async function remote(url: string, target: Target, bundle: Bundle, calls: readonly PlayCall[]): Promise<CallResult[]> {
  const out = await post<{ results?: CallResult[] }>(url, "/run", bundle, { settings: target.settings, calls }, RUNTIME_TIMEOUT_MS, target.id);
  return out.results ?? fail(`${target.id} answered without results`);
}

/** Per module call: a cold isolate, the code's compute (1 s of CPU at most) and up to 4 MB each way. */
export const MODULE_TIMEOUT_MS = 15_000;

/**
 * Run one call of a module's server code (docs/modules.md, "Server code") in the recipe runtime, in the isolate for
 * `isolate` ("<orgId>:user:<userId>"), and return what the call returned. Module code runs only there: without a
 * runtime this refuses, and there is no in-process path.
 */
export async function runModuleCall(ctx: ActionCtx, bundle: { hash: string; storageId: string }, body: Omit<ModuleBody, "bundle">): Promise<ModuleResult> {
  const url = integrationEnabled("recipeRuntime") ? process.env.RECIPE_RUNTIME_URL : undefined;
  if (!url) return fail("a module's code runs only in the customization runtime, and this deployment has no RECIPE_RUNTIME_URL.");
  const size = JSON.stringify(body).length;
  if (size > MODULE_BODY_MAX) return fail(`the call's reads are ${(size / 1e6).toFixed(1)} MB, more than the ${MODULE_BODY_MAX / 1e6} MB a call takes. Narrow its read plan.`);
  const out = await post<{ result?: ModuleResult }>(url, "/module", { hash: bundle.hash, code: () => storedCode(ctx, bundle.hash, bundle.storageId) }, body, MODULE_TIMEOUT_MS, `the module call ${body.call}`);
  return out.result ?? fail(`the module call ${body.call} answered without a result`);
}
