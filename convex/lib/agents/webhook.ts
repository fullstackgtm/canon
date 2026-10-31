/**
 * Event agents' webhook trigger and turn budget (docs/org-agents.md, phases
 * 2-3). Pure and runtime-neutral (Web Crypto only): the default-runtime HTTP
 * route verifies with it, the Node turn action meters with it, and tests call
 * it directly.
 *
 * Signing: the sender sends `X-Canon-Timestamp: <unix seconds>` and
 * `X-Canon-Signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>`.
 * A request without both, with a timestamp more than TOLERANCE_S away, or with
 * another signature is refused before anything is recorded.
 */
import { hmacSha256Hex, sha256Hex } from "../publicCrypto.ts";
import { normalizeDomain, type RecordClient } from "../recordClient.ts";
import type { AccountRow } from "../recordContract.ts";

export const WEBHOOK_PATH_PREFIX = "/agents/webhook/";
export const TIMESTAMP_HEADER = "x-canon-timestamp";
export const SIGNATURE_HEADER = "x-canon-signature";
export const TOLERANCE_S = 300;
export const MAX_BODY_BYTES = 256_000;
/** Characters of an event's body kept on its turn, for the turn log. */
export const PAYLOAD_KEPT = 2000;

export async function signWebhook(secret: string, timestamp: number | string, body: string): Promise<string> {
  return `v1=${await hmacSha256Hex(`${timestamp}.${body}`, secret)}`;
}

export type Verdict = { ok: true } | { ok: false; reason: "unsigned" | "stale" | "bad_signature" };

export async function verifyWebhook(a: {
  secret: string; body: string; timestamp: string | null; signature: string | null; nowMs: number;
}): Promise<Verdict> {
  if (!a.timestamp || !a.signature) return { ok: false, reason: "unsigned" };
  if (!/^\d{1,12}$/.test(a.timestamp)) return { ok: false, reason: "unsigned" };
  if (Math.abs(a.nowMs / 1000 - Number(a.timestamp)) > TOLERANCE_S) return { ok: false, reason: "stale" };
  const expected = await signWebhook(a.secret, a.timestamp, a.body);
  // Hash both sides so the comparison takes the same time however much matches.
  const [x, y] = await Promise.all([sha256Hex(expected), sha256Hex(a.signature.trim())]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0 ? { ok: true } : { ok: false, reason: "bad_signature" };
}

/**
 * The event's identity for idempotency: the sender's event id in the signed
 * body (`event_id` / `eventId` / `id`), else a hash of the exact body. Never a
 * header: the signature doesn't cover headers, so a replay could change one.
 * The same event delivered twice yields one turn.
 */
export async function eventKeyOf(payload: unknown, body: string): Promise<string> {
  const p = isObject(payload) ? payload : {};
  const id = [p.event_id, p.eventId, p.id].find((x) => typeof x === "string" ? x.trim() : typeof x === "number");
  if (id !== undefined && id !== "") return `id:${String(id).trim().slice(0, 200)}`;
  return `sha256:${await sha256Hex(body)}`;
}

export type Subject = { domain?: string; email?: string };

const FREEMAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "hotmail.com", "outlook.com", "live.com", "msn.com", "icloud.com",
  "me.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "mail.com", "yandex.com", "qq.com",
]);
const DOMAIN_KEYS = ["domain", "company_domain", "companyDomain", "website", "url"];
const NESTED = ["company", "account", "organization", "contact", "person", "user", "lead", "properties", "data"];

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

export function bareDomain(raw: string): string | null {
  const d = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#:].*$/, "").replace(/\.$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) ? d : null;
}

/**
 * Who the event is about: a company domain and an email, from the top level
 * or one level down (`company.domain`, `contact.email`, ...). A personal email
 * address names no company.
 */
export function subjectOf(payload: unknown): Subject {
  const out: Subject = {};
  const levels = isObject(payload) ? [payload, ...NESTED.map((k) => payload[k]).filter(isObject)] : [];
  for (const o of levels) {
    for (const k of DOMAIN_KEYS) {
      const d = typeof o[k] === "string" ? bareDomain(o[k] as string) : null;
      if (d && !out.domain) out.domain = d;
    }
    const e = typeof o.email === "string" ? o.email.trim().toLowerCase() : "";
    if (!out.email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) out.email = e.slice(0, 320);
  }
  if (!out.domain && out.email) {
    const d = bareDomain(out.email.split("@")[1]);
    if (d && !FREEMAIL.has(d)) out.domain = d;
  }
  return out;
}

// ───────────────────────────── Budget ─────────────────────────────

/**
 * An event agent's budget. Per turn: read rounds per question, estimated
 * tokens and wall time. Per agent: turns admitted in a rolling 24 hours.
 */
export type AgentBudget = { turnsPerDay: number; maxRounds: number; maxTokens: number; maxSeconds: number };
export const DEFAULT_BUDGET: AgentBudget = { turnsPerDay: 20, maxRounds: 2, maxTokens: 150_000, maxSeconds: 300 };
export const MAX_TURNS_PER_DAY = 500;
/** One turn runs in one action; this keeps it well inside Convex's 10-minute limit. */
export const MAX_TURN_SECONDS = 480;
export const DAY_MS = 24 * 60 * 60_000;

/** The plan doesn't report usage, so a call is charged its prompt (about 4 characters a token) plus room for the reply. */
export const estimateTokens = (prompt: string) => Math.ceil(prompt.length / 4) + 500;

export class BudgetExhausted extends Error {
  readonly limit: "tokens" | "time";
  constructor(limit: "tokens" | "time") {
    super(limit === "tokens" ? "Token budget for this turn reached" : "Time budget for this turn reached");
    this.limit = limit;
  }
}

/** Charge each model call before it is made: the call that would cross the budget doesn't happen. */
export function turnMeter(budget: Pick<AgentBudget, "maxTokens" | "maxSeconds">, startedAt: number, now = () => Date.now()) {
  const spent = { tokens: 0, modelCalls: 0 };
  return {
    spent,
    charge(prompt: string) {
      if (now() - startedAt > budget.maxSeconds * 1000) throw new BudgetExhausted("time");
      const cost = estimateTokens(prompt);
      if (spent.tokens + cost > budget.maxTokens) throw new BudgetExhausted("tokens");
      spent.tokens += cost;
      spent.modelCalls++;
    },
  };
}

// ───────────────────────────── Admission ─────────────────────────────

export const SKIP_REASONS = {
  paused: "The agent is paused or archived.",
  daily_cap: "The agent reached its turns-per-day budget.",
  no_fields: "The agent has no AI fields to answer.",
  no_subject: "The event names no company: send a domain, a website or a work email.",
  owner_not_connected: "The agent's owner has not connected ChatGPT (Integrations → ChatGPT). Agents never run on Canon's key.",
  no_account: "No account in this workspace has that domain.",
} as const;
export type SkipReason = keyof typeof SKIP_REASONS;

/** Whether an event becomes a turn that runs, or one recorded as skipped. Checked in the mutation that records it. */
export function admission(a: {
  standingMessage: string | null; fieldCount: number; admittedToday: number; turnsPerDay: number;
  subject: Subject; ownerConnected: boolean;
}): { run: true } | { run: false; reason: SkipReason; message: string } {
  const skip = (reason: SkipReason, message: string = SKIP_REASONS[reason]) => ({ run: false as const, reason, message });
  if (a.standingMessage) return skip("paused", a.standingMessage);
  if (a.admittedToday >= a.turnsPerDay) return skip("daily_cap", `The agent ran ${a.admittedToday} turns in the last 24 hours, its budget.`);
  if (a.fieldCount === 0) return skip("no_fields");
  if (!a.subject.domain) return skip("no_subject", a.subject.email ? `${a.subject.email} is a personal address; it names no company.` : SKIP_REASONS.no_subject);
  if (!a.ownerConnected) return skip("owner_not_connected");
  return { run: true };
}

/** Pages followed at most: 200 rows each, far past any realistic number of accounts that contain one domain as text. */
const FIND_PAGES = 10;

/** The workspace's account with exactly this domain, or null. Only `ws`'s records are searched. */
export async function findAccount(client: Pick<RecordClient, "list">, ws: string, domain: string): Promise<AccountRow | null> {
  // The list search matches the domain as text, so the exact account can sit behind other matches: follow the pages.
  let cursor: string | undefined;
  for (let i = 0; i < FIND_PAGES; i++) {
    const page = await client.list(ws, { filter: { q: domain }, limit: 200, ...(cursor ? { cursor } : {}) });
    const found = page.rows.find((r) => r.domain && normalizeDomain(r.domain) === domain);
    if (found) return found;
    if (!page.nextCursor) return null;
    cursor = page.nextCursor;
  }
  return null;
}
