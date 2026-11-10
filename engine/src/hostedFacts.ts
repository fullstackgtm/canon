/**
 * CanonCRM agent write gate client: submit a batch of proposed facts (about
 * deals, accounts or contacts) to
 * the paired hosted app, and read a batch's review status. Proposed facts
 * never change a canonical value until a person (or an org's verified
 * auto-accept rule) accepts them.
 */
import { broker } from "./hostedPatchPlan.ts";

const ENDPOINT = "/api/cli/canon/proposals";
const TIMEOUT_MS = 15_000;

export const AGENT_SOURCE_KINDS = ["agent_run", "enrichment", "call", "pipeline"] as const;
export type AgentSourceKind = (typeof AGENT_SOURCE_KINDS)[number];

export const ENTITY_TYPES = ["opportunity", "account", "contact"] as const;

export type ProposedFact = {
  /** Default opportunity (a deal). */
  entityType?: (typeof ENTITY_TYPES)[number];
  dealId?: string;
  /** Synced CRM account / contact row ids. */
  accountId?: string;
  contactId?: string;
  crmProvider?: "salesforce" | "hubspot";
  crmId?: string;
  /** An account or contact already in Canon. */
  entityId?: string;
  recordId?: string;
  domain?: string;
  email?: string;
  attribute: string;
  value: string | number | boolean | null;
  evidence?: string;
  confidence?: number;
  validFrom?: number;
};

export type FactBatch = { agentId: string; sourceKind: AgentSourceKind; title: string; reason?: string; facts: ProposedFact[] };

export type SubmitResult = {
  patchPlanId: string;
  proposed: number;
  unchanged: number;
  verifying: number;
  rejected: Array<{ index: number; attribute: string; reason: string }>;
};

type Options = { fetchImpl?: typeof fetch; timeoutMs?: number };
type Outcome<T> = { status: "ok"; result: T } | { status: "unpaired" } | { status: "error"; reason: string };

/** Validate a batch locally so obvious mistakes fail before a network call. */
export function validateFactBatch(raw: unknown): { ok: true; batch: FactBatch } | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "batch must be a JSON object" };
  const b = raw as Record<string, unknown>;
  if (typeof b.agentId !== "string" || !b.agentId) return { ok: false, reason: "agentId is required" };
  if (typeof b.title !== "string" || !b.title) return { ok: false, reason: "title is required" };
  if (!AGENT_SOURCE_KINDS.includes(b.sourceKind as AgentSourceKind)) return { ok: false, reason: `sourceKind must be one of ${AGENT_SOURCE_KINDS.join(", ")}` };
  if (!Array.isArray(b.facts) || !b.facts.length) return { ok: false, reason: "facts must be a non-empty array" };
  for (const [i, f] of b.facts.entries()) {
    const fact = f as Record<string, unknown>;
    if (!fact || typeof fact !== "object") return { ok: false, reason: `facts[${i}] must be an object` };
    if (typeof fact.attribute !== "string") return { ok: false, reason: `facts[${i}].attribute is required` };
    if (!("value" in fact) || (fact.value !== null && !["string", "number", "boolean"].includes(typeof fact.value))) return { ok: false, reason: `facts[${i}].value must be a scalar or null` };
    const type = fact.entityType ?? "opportunity";
    if (!ENTITY_TYPES.includes(type as ProposedFact["entityType"] & string)) return { ok: false, reason: `facts[${i}].entityType must be one of ${ENTITY_TYPES.join(", ")}` };
    const crm = Boolean(fact.crmProvider && fact.crmId);
    if (type === "opportunity" && !fact.dealId && !crm) return { ok: false, reason: `facts[${i}] needs dealId, or crmProvider and crmId` };
    if (type === "account" && !(crm || fact.accountId || fact.entityId || fact.recordId || fact.domain)) {
      return { ok: false, reason: `facts[${i}] needs accountId, crmProvider and crmId, entityId, recordId or domain` };
    }
    if (type === "contact" && !(crm || fact.contactId || fact.entityId || fact.recordId || fact.email)) {
      return { ok: false, reason: `facts[${i}] needs contactId, crmProvider and crmId, entityId, recordId or email` };
    }
  }
  return { ok: true, batch: b as unknown as FactBatch };
}

async function call<T>(init: (paired: { baseUrl: string; token: string }) => [string, RequestInit], options: Options): Promise<Outcome<T>> {
  const paired = broker();
  if (!paired) return { status: "unpaired" };
  const [url, req] = init(paired);
  try {
    const response = await (options.fetchImpl ?? fetch)(url, { ...req, signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS) });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      const reason = response.status === 401 || response.status === 403 ? "hosted authentication was rejected; pair the CLI again" : String(body.error ?? `HTTP ${response.status}`);
      return { status: "error", reason };
    }
    return { status: "ok", result: body as T };
  } catch {
    return { status: "error", reason: "hosted request was unavailable" };
  }
}

export function submitFactBatch(batch: FactBatch, options: Options = {}): Promise<Outcome<SubmitResult>> {
  return call<SubmitResult>((p) => [`${p.baseUrl}${ENDPOINT}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${p.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(batch),
  }], options);
}

export function readFactBatch(patchPlanId: string, options: Options = {}): Promise<Outcome<unknown>> {
  return call((p) => [`${p.baseUrl}${ENDPOINT}?patchPlanId=${encodeURIComponent(patchPlanId)}`, {
    headers: { Authorization: `Bearer ${p.token}`, Accept: "application/json" },
  }], options);
}
