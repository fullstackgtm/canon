/**
 * The recipe runtime (docs/recipes.md, R3): runs a recipe's play code in a Dynamic Worker isolate with no network,
 * no env and a CPU limit. Convex calls it from actions (convex/lib/recipeRuntime.ts) and keeps all state: recipe
 * code only returns data. The wire is in protocol.ts.
 */
import { ISOLATE_SCOPE, MODULE_BODY_MAX, MODULE_CPU_MS, SIGNATURE_HEADER, TIMESTAMP_HEADER, bundleHash, verify, type ModuleBody, type ModuleResult, type RunBody } from "./protocol.ts";

import { extract, EXTRACT_BODY_MAX, type ExtractionAI } from "./extraction.ts";

type Entrypoint = { run(settings: unknown, calls: unknown[]): Promise<unknown[]>; call?(name: string, ctx: unknown, reads: unknown): Promise<ModuleResult> };
type WorkerCode = { compatibilityDate: string; mainModule: string; modules: Record<string, string>; globalOutbound: null; env: Record<string, never>; limits?: { cpuMs?: number } };
export type Loader = { get(id: string, code: () => WorkerCode | Promise<WorkerCode>): { getEntrypoint(name?: string | null, options?: { limits?: { cpuMs?: number } }): Entrypoint } };
export type Env = { LOADER: Loader; AI?: ExtractionAI; RECIPE_RUNTIME_SECRET?: string };

/** A deal page's batch takes well under 10 ms of CPU; this stops a loop without cutting off a real batch. */
const CPU_MS = 200;
const BODY_MAX = 2_000_000;
const CODES_KEPT = 16;
const COMPATIBILITY_DATE = "2026-09-01";

/** The isolate's main module: an RPC entrypoint over the bundle's `run`. Trusted; the bundle is the recipe. */
const MAIN = `import { WorkerEntrypoint } from "cloudflare:workers";
import { run } from "./recipe.js";
export default class extends WorkerEntrypoint {
  run(settings, calls) { return run(settings, calls); }
}
`;

/**
 * A module isolate's first module, run before the module's own code: Date reads the call's `ctx.now`, and the
 * sources of randomness throw, so a call is a function of its context and reads.
 */
const FREEZE = `const clock = { now: 0 };
const RealDate = Date;
class FrozenDate extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(clock.now); }
  static now() { return clock.now; }
}
globalThis.Date = FrozenDate;
const refuse = (what) => () => { throw new Error(what + " isn't available to module code: a call is pure, and ctx.now is its clock"); };
const stub = (o, k, f) => { try { Object.defineProperty(o, k, { value: f, configurable: true, writable: true }); } catch {} };
stub(Math, "random", refuse("Math.random"));
if (globalThis.crypto) { stub(globalThis.crypto, "getRandomValues", refuse("crypto.getRandomValues")); stub(globalThis.crypto, "randomUUID", refuse("crypto.randomUUID")); }
if (globalThis.performance) stub(globalThis.performance, "now", () => 0);
export const setNow = (t) => { clock.now = t; };
`;

/** A module isolate's main module: the clock first, then the module's code, called by name. */
const MODULE_MAIN = `import { setNow } from "./freeze.js";
import * as mod from "./module.js";
import { WorkerEntrypoint } from "cloudflare:workers";
const fail = (kind, message) => ({ ok: false, error: { kind, message: String(message).slice(0, 500) } });
export default class extends WorkerEntrypoint {
  async call(name, ctx, reads) {
    const calls = mod.calls && typeof mod.calls === "object" ? mod.calls : {};
    const fn = Object.hasOwn(calls, name) ? calls[name] : undefined;
    if (typeof fn !== "function") return fail("unknown_call", "the module's code has no call " + name);
    setNow(ctx.now);
    try { return { ok: true, value: JSON.parse(JSON.stringify((await fn(Object.freeze(ctx), reads)) ?? {})) }; }
    catch (e) { return fail("threw", e instanceof Error ? e.message : e); }
  }
}
`;

/**
 * Bundles this Worker has been sent, by hash, so the loader can start an isolate again after evicting one without
 * Convex resending the code. A miss here answers 409 and Convex resends.
 */
const codes = new Map<string, string>();
function remember(hash: string, code: string) {
  codes.delete(hash);
  codes.set(hash, code);
  while (codes.size > CODES_KEPT) codes.delete(codes.keys().next().value!);
}

const json = (status: number, body: unknown) => Response.json(body, { status });

function parse(text: string): RunBody | null {
  try {
    const b = JSON.parse(text) as RunBody;
    const ok = b && typeof b.bundle?.hash === "string" && /^[0-9a-f]{32}$/.test(b.bundle.hash) && (b.bundle.code === undefined || typeof b.bundle.code === "string")
      && b.settings && typeof b.settings === "object" && !Array.isArray(b.settings) && Array.isArray(b.calls);
    return ok ? b : null;
  } catch {
    return null;
  }
}

function parseModule(text: string): ModuleBody | null {
  try {
    const b = JSON.parse(text) as ModuleBody;
    const ok = b && typeof b.bundle?.hash === "string" && /^[0-9a-f]{32}$/.test(b.bundle.hash) && (b.bundle.code === undefined || typeof b.bundle.code === "string")
      && typeof b.isolate === "string" && ISOLATE_SCOPE.test(b.isolate) && typeof b.call === "string" && b.call.length <= 60
      && b.ctx && typeof b.ctx.now === "number" && typeof b.ctx.caller?.userId === "string" && b.ctx.args && typeof b.ctx.args === "object"
      && b.reads && typeof b.reads === "object" && !Array.isArray(b.reads);
    return ok ? b : null;
  } catch {
    return null;
  }
}

/** The bundle's code: from the request, checked against its hash, or remembered from an earlier one. A Response refuses. */
async function codeFor(bundle: { hash: string; code?: string }): Promise<string | Response> {
  if (bundle.code !== undefined) {
    if ((await bundleHash(bundle.code)) !== bundle.hash) return json(400, { error: "code doesn't match its hash" });
    remember(bundle.hash, bundle.code);
  }
  return codes.get(bundle.hash) ?? json(409, { need: "code" });
}

/** A module call: the module's code in an isolate of its own for the bundle, the workspace and the principal. */
async function runModule(text: string, env: Env): Promise<Response> {
  const body = parseModule(text);
  if (!body) return json(400, { error: "body must be { bundle: { hash, code? }, isolate, call, ctx: { now, caller, args }, reads }" });
  const code = await codeFor(body.bundle);
  if (code instanceof Response) return code;
  const worker = env.LOADER.get(`${body.bundle.hash}:${body.isolate}`, () => ({
    compatibilityDate: COMPATIBILITY_DATE, mainModule: "main.js", modules: { "main.js": MODULE_MAIN, "freeze.js": FREEZE, "module.js": code },
    globalOutbound: null, env: {}, limits: { cpuMs: MODULE_CPU_MS },
  }));
  try {
    const result = await worker.getEntrypoint(null, { limits: { cpuMs: MODULE_CPU_MS } }).call!(body.call, body.ctx, body.reads);
    const out = JSON.stringify({ result });
    if (out.length > MODULE_BODY_MAX) return json(413, { error: `the call returned ${out.length} bytes, more than ${MODULE_BODY_MAX}` });
    return new Response(out, { status: 200, headers: { "content-type": "application/json" } });
  } catch (e) {
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    console.error(`module ${body.bundle.hash} ${body.call}: ${message}`);
    return json(500, { error: `the module isolate failed: ${message}` });
  }
}

export async function handle(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname !== "/run" && url.pathname !== "/module" && url.pathname !== "/extract") return json(404, { error: "not found" });
  if (req.method !== "POST") return json(405, { error: "POST only" });
  if (!env.RECIPE_RUNTIME_SECRET) return json(500, { error: "RECIPE_RUNTIME_SECRET is not set" });
  const text = await req.text();
  if (text.length > (url.pathname === "/extract" ? EXTRACT_BODY_MAX : url.pathname === "/module" ? MODULE_BODY_MAX : BODY_MAX)) return json(413, { error: "body too large" });
  if (!(await verify(env.RECIPE_RUNTIME_SECRET, req.headers.get(TIMESTAMP_HEADER), req.headers.get(SIGNATURE_HEADER), text, Date.now()))) {
    return json(401, { error: "bad or stale signature" });
  }
  if (url.pathname === "/extract") return extract(text, env.AI);
  if (url.pathname === "/module") return runModule(text, env);
  const body = parse(text);
  if (!body) return json(400, { error: "body must be { bundle: { hash, code? }, settings, calls: [] }" });
  const known = await codeFor(body.bundle);
  if (known instanceof Response) return known;
  const hash = body.bundle.hash;
  const worker = env.LOADER.get(hash, () => ({
    compatibilityDate: COMPATIBILITY_DATE, mainModule: "main.js", modules: { "main.js": MAIN, "recipe.js": known },
    globalOutbound: null, env: {}, limits: { cpuMs: CPU_MS },
  }));
  try {
    const results = await worker.getEntrypoint(null, { limits: { cpuMs: CPU_MS } }).run(body.settings, body.calls);
    return json(200, { results });
  } catch (e) {
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    console.error(`recipe ${hash}: ${message}`);
    return json(500, { error: `the recipe isolate failed: ${message}` });
  }
}

export default { fetch: handle };
