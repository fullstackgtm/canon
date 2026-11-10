/**
 * Deepline adapter: the workspace's own Deepline account (bring your own key;
 * Deepline bills that account, Canon charges nothing). Find email runs
 * Deepline's prebuilt name-and-domain email waterfall first when a workspace
 * has connected it (records.findEmail).
 *
 * `fetchImpl` is required, so nothing reaches the network unless a caller hands
 * it one: tests pass a fake, and only the Convex action passes `fetch`. The key
 * goes only in the Authorization header; errors carry the HTTP status, never
 * the key or the response body.
 *
 * The play's output field names are not confirmed against a live key, so the
 * email is read only from a few known keys, never from anywhere in the output.
 *
 * Pure: no database access, no Node-only imports.
 */
import { splitFullName } from "./emailFinder.ts";

export const DEEPLINE_BASE_URL = "https://code.deepline.com";
export const DEEPLINE_EMAIL_PLAY = "prebuilt/name-and-domain-to-email-waterfall";
/** The endpoint a Deepline lookup is filed under in `providerCalls`. */
export const DEEPLINE_EMAIL_ENDPOINT = `deepline.plays.${DEEPLINE_EMAIL_PLAY}`;
/** Total time one lookup may take before it counts as a miss and Find email falls through to treg. */
export const DEEPLINE_LOOKUP_BUDGET_MS = 25_000;

export class DeeplineError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(
      status === 401 || status === 403
        ? `Deepline rejected the API key (HTTP ${status}). Check it in your Deepline account settings.`
        : status === 402
          ? "Your Deepline account is out of credits (HTTP 402)."
          : status === 429
            ? "Deepline is rate limiting this key (HTTP 429). Try again in a minute."
            : `Deepline request failed (HTTP ${status}).`,
    );
    this.name = "DeeplineError";
    this.status = status;
  }
}

/** What one waterfall run found. `status` is Deepline's verifier verdict when it sent one. */
export type DeeplineEmail = {
  email: string | null;
  status: "valid" | "catch-all" | "unknown" | "not_found" | "timeout";
  runId: string | null;
  costCredits?: number;
};

const PENDING = new Set(["queued", "running", "waiting"]);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj | null => (x && typeof x === "object" && !Array.isArray(x) ? (x as Obj) : null);
const str = (x: unknown): string | null => (typeof x === "string" && x.trim() ? x.trim() : null);

function runIdOf(body: Obj | null): string | null {
  return str(body?.workflowId) ?? str(obj(body?.run)?.id) ?? str(body?.runId) ?? str(body?.id);
}
function statusOf(body: Obj | null): string | null {
  return (str(body?.status) ?? str(obj(body?.run)?.status))?.toLowerCase() ?? null;
}

/** The play's output: `result`, or `package.outputs`, or the first row when it is a list. */
function outputOf(body: Obj | null): Obj | null {
  const raw = body?.result ?? obj(body?.package)?.outputs ?? obj(body?.run)?.result ?? body?.output;
  return obj(Array.isArray(raw) ? raw[0] : raw);
}

/** The email at a known key, with the verifier's verdict. An `invalid` email is no email. */
export function emailFromOutput(out: Obj | null): Pick<DeeplineEmail, "email" | "status"> {
  const scopes = [out, obj(out?.result), obj(out?.email)];
  for (const s of scopes) {
    const raw = str(s?.email) ?? str(s?.work_email) ?? str(s?.workEmail) ?? str(s?.address);
    if (!raw || !EMAIL.test(raw)) continue;
    const verdict = (str(s?.email_status) ?? str(s?.emailStatus) ?? str(s?.verification_status) ?? str(obj(s?.verification)?.status) ?? str(out?.email_status))?.toLowerCase();
    if (verdict === "invalid") return { email: null, status: "not_found" };
    const status = verdict === "valid" ? "valid" : verdict === "catch-all" || verdict === "catch_all" || verdict === "accept_all" ? "catch-all" : "unknown";
    return { email: raw.toLowerCase(), status };
  }
  return { email: null, status: "not_found" };
}

function creditsOf(body: Obj | null): number | undefined {
  const billing = obj(body?.billing);
  const n = billing?.credits ?? billing?.total_credits ?? billing?.totalCredits ?? billing?.cost;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

export type DeeplineClient = ReturnType<typeof createDeeplineClient>;

export function createDeeplineClient(opts: {
  apiKey: string;
  fetchImpl: typeof fetch;
  baseUrl?: string;
  budgetMs?: number;
  /** Injected so tests run the poll loop without waiting. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}) {
  const base = (opts.baseUrl ?? DEEPLINE_BASE_URL).replace(/\/$/, "");
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  async function call(path: string, init: { method: "GET" | "POST"; body?: unknown; deadline?: number }): Promise<Obj | null> {
    // The lookup's budget covers a stalled request and its body read too, not just the gaps between polls.
    const abort = init.deadline === undefined ? null : new AbortController();
    const timer = abort && setTimeout(() => abort.abort(Object.assign(new Error("Deepline lookup timed out"), { name: "TimeoutError" })), Math.max(1, init.deadline! - now()));
    try {
      const response = await opts.fetchImpl(`${base}${path}`, {
        method: init.method,
        headers: { Authorization: `Bearer ${opts.apiKey}`, Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}) },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
        ...(abort ? { signal: abort.signal } : {}),
      });
      if (!response.ok) throw new DeeplineError(response.status);
      return obj(await response.json().catch((err: unknown) => (abort?.signal.aborted ? Promise.reject(err) : null)));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return {
    /** A free authenticated read. Throws DeeplineError when Deepline refuses the key, so it doubles as the check. */
    async validate(): Promise<void> {
      await call("/api/v2/tools/search?q=email&limit=1", { method: "GET" });
    },
    /**
     * Run the email waterfall for one person and wait for it, within the budget.
     * A run still going at the deadline is a miss (`timeout`); the caller falls
     * through rather than holding the rep's click open.
     */
    async findWorkEmail(person: { fullName: string; domain: string }): Promise<DeeplineEmail> {
      const name = splitFullName(person.fullName);
      if (!name || !person.domain) return { email: null, status: "not_found", runId: null };
      const deadline = now() + (opts.budgetMs ?? DEEPLINE_LOOKUP_BUDGET_MS);
      let runId: string | null = null;
      let body: Obj | null;
      try {
        body = await call("/api/v2/plays/run", {
          method: "POST",
          body: { name: DEEPLINE_EMAIL_PLAY, input: { first_name: name.first, last_name: name.last, domain: person.domain }, waitForCompletionMs: 8_000 },
          deadline,
        });
        runId = runIdOf(body);
        let delay = 1_000;
        // Terminal is completed, failed or cancelled; a body with no status but an output is done too.
        while (PENDING.has(statusOf(body) ?? "") || (!statusOf(body) && !outputOf(body))) {
          if (!runId || now() + delay > deadline) return { email: null, status: "timeout", runId };
          await sleep(delay);
          delay = Math.min(delay * 2, 5_000);
          body = await call(`/api/v2/runs/${encodeURIComponent(runId)}?full=true`, { method: "GET", deadline });
        }
      } catch (err) {
        if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return { email: null, status: "timeout", runId };
        throw err;
      }
      const credits = creditsOf(body);
      const found = statusOf(body) === "failed" || statusOf(body) === "cancelled" ? { email: null, status: "not_found" as const } : emailFromOutput(outputOf(body));
      return { ...found, runId, ...(credits === undefined ? {} : { costCredits: credits }) };
    },
  };
}

/**
 * Find email's order with a workspace's Deepline connected: Deepline first,
 * and on a miss or any Deepline failure the rest of the chain, unchanged. A
 * Deepline failure is never the rep's problem while treg can still answer.
 */
export async function deeplineFirst<T>(
  deepline: (() => Promise<DeeplineEmail>) | null,
  onDeepline: (result: DeeplineEmail) => Promise<T | null>,
  rest: () => Promise<T>,
): Promise<T> {
  if (deepline) {
    let result: DeeplineEmail | null = null;
    try {
      result = await deepline();
    } catch (err) {
      console.warn(`Deepline email lookup failed: ${err instanceof Error ? err.message.slice(0, 160) : "unknown error"}`);
    }
    if (result) {
      const done = await onDeepline(result);
      if (done !== null) return done;
    }
  }
  return rest();
}
