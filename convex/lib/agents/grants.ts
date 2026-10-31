/**
 * Standing write grants (docs/org-agents.md "Autonomy"): an admin's approval,
 * made in advance, for one narrow kind of write by one agent. Pure: the Convex
 * shell (convex/agentGrants.ts) loads rows and the signing key and asks these
 * functions.
 *
 * The first and only operation is `set_field`: set one AI field
 * (`custom.<slug>`) on accounts or contacts, optionally only to listed values,
 * optionally at most N facts a day, always with an expiry. A grant is signed
 * with HMAC-SHA256 over its exact terms; a grant whose signature doesn't
 * verify (tampered, or no key on this deployment), that has expired or that
 * was revoked approves nothing.
 *
 * A proposal batch (patch plan) is approved under a grant only when every fact
 * in it fits that one grant. Anything else stays pending for a person, whole.
 * The approval's digest binds the plan's hash to the grant's signature.
 */

export const GRANT_OPERATION = "set_field" as const;
export const GRANT_MAX_DAYS = 90;
export const GRANT_MAX_VALUES = 50;
export const GRANT_MAX_PER_DAY = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

export type GrantEntityType = "account" | "contact";

/** Everything the signature covers. Changing any of these invalidates the grant. */
export type GrantTerms = {
  grantId: string;
  orgId: string;
  agentId: string;
  operation: typeof GRANT_OPERATION;
  entityType: GrantEntityType;
  attribute: string;
  allowedValues?: string[];
  maxPerDay?: number;
  expiresAt: number;
  createdBy: string;
  createdAt: number;
};

export type StoredGrant = GrantTerms & { signature: string; revokedAt?: number };

/** One proposed fact as the grant check sees it. */
export type GrantFact = {
  id: string;
  status: string;
  entityId: string;
  entityType: string;
  attribute: string;
  value: string | number | boolean | null;
  evidence?: string;
  actor: { kind: string; id: string };
};

export function canonicalTerms(t: GrantTerms): string {
  return JSON.stringify([
    "canon.agent_grant.v1", t.grantId, t.orgId, t.agentId, t.operation, t.entityType, t.attribute,
    t.allowedValues ? [...t.allowedValues].sort() : null, t.maxPerDay ?? null, t.expiresAt, t.createdBy, t.createdAt,
  ]);
}

const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

export async function hmacHex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(message)));
}

export const signGrant = (t: GrantTerms, key: string) => hmacHex(key, canonicalTerms(t));

function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type GrantState = "live" | "expired" | "revoked" | "invalid";

/** Whether a grant may approve anything now. No key means nothing verifies: every grant is invalid. */
export async function grantState(g: StoredGrant, key: string | null, now: number): Promise<GrantState> {
  if (g.revokedAt !== undefined) return "revoked";
  if (!key || g.operation !== GRANT_OPERATION || !sameHex(await signGrant(g, key), g.signature)) return "invalid";
  return g.expiresAt > now ? "live" : "expired";
}

export const grantStateLabel: Record<GrantState, string> = {
  live: "Live",
  expired: "Expired",
  revoked: "Revoked",
  invalid: "Inert: its signature doesn't verify",
};

/** Does this one fact fit the grant's terms? (The grant's liveness is checked separately.) */
export function factFits(g: GrantTerms, agentId: string, f: GrantFact): boolean {
  return f.status === "proposed"
    && f.actor.kind === "agent" && f.actor.id === agentId && g.agentId === agentId
    && f.entityType === g.entityType && f.attribute === g.attribute
    // Setting a value only: clearing a field is not grantable.
    && f.value !== null && String(f.value).trim() !== ""
    // The verbatim evidence gate stays: no quote, no grant.
    && Boolean(f.evidence?.trim())
    && (!g.allowedValues || g.allowedValues.includes(String(f.value)));
}

export type PlanFit = { ok: true } | { ok: false; reason: string };

/**
 * Whether a whole plan fits inside one live grant: every operation is a fact
 * that fits, and the day's cap leaves room for all of them. Never partial.
 */
export function planFits(g: GrantTerms, state: GrantState, agentId: string, facts: readonly GrantFact[], operationCount: number, usedToday: number): PlanFit {
  if (state !== "live") return { ok: false, reason: `grant ${state}` };
  if (!facts.length || facts.length !== operationCount) return { ok: false, reason: "plan holds operations that are not facts" };
  if (!facts.every((f) => factFits(g, agentId, f))) return { ok: false, reason: "a fact is outside the grant" };
  if (g.maxPerDay !== undefined && usedToday + facts.length > g.maxPerDay) return { ok: false, reason: "daily cap reached" };
  return { ok: true };
}

/** A grant that a not-yet-submitted fact would fit, or null: used to group a turn's answers before they are proposed. */
export function grantFor<G extends GrantTerms>(live: readonly G[], f: { entityType: string; attribute: string; value: unknown }): G | null {
  return live.find((g) => g.entityType === f.entityType && g.attribute === f.attribute
    && f.value !== null && String(f.value).trim() !== "" && (!g.allowedValues || g.allowedValues.includes(String(f.value)))) ?? null;
}

/** SHA-256 over the plan's exact content: which facts, about what, with which value and evidence. */
export async function planHash(patchPlanId: string, facts: readonly GrantFact[]): Promise<string> {
  const rows = [...facts].sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((f) => [f.id, f.entityId, f.entityType, f.attribute, f.value, f.evidence ?? null, f.actor.kind, f.actor.id]);
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["canon.grant_plan.v1", patchPlanId, rows]))));
}

/** The approval's digest: binds the plan hash to the grant's signature. */
export const approvalDigest = (key: string, grantId: string, grantSignature: string, hash: string) =>
  hmacHex(key, JSON.stringify(["canon.grant_approval.v1", grantId, grantSignature, hash]));

export const usageSince = (now: number) => now - DAY_MS;

export type GrantRequest = {
  viewerRole: string;
  agent: { orgId: string; agentId: string; fieldSlugs: readonly string[] } | null;
  field: { slug: string; entityType: string; choices: readonly string[] } | null;
  allowedValues?: readonly string[];
  maxPerDay?: number;
  days: number;
};

/**
 * The checks on creating a grant, before it is signed. Only an admin may
 * grant: it is a signed-in person's mutation, kept off the agent tool
 * surface (gtm API, CLI, MCP).
 */
export function grantRequestRefusal(r: GrantRequest): string | null {
  if (r.viewerRole !== "admin") return "Only admins can grant an agent standing approval.";
  if (!r.agent) return "Agent not found";
  if (!r.field || !r.agent.fieldSlugs.includes(r.field.slug)) return "A grant names one of the agent's AI fields.";
  if (r.field.entityType !== "account" && r.field.entityType !== "contact") return "Only account and contact fields can be granted.";
  if (!(Number.isInteger(r.days) && r.days >= 1 && r.days <= GRANT_MAX_DAYS)) return `A grant expires after 1 to ${GRANT_MAX_DAYS} days.`;
  if (r.maxPerDay !== undefined && !(Number.isInteger(r.maxPerDay) && r.maxPerDay >= 1 && r.maxPerDay <= GRANT_MAX_PER_DAY)) {
    return `The daily cap is 1 to ${GRANT_MAX_PER_DAY} values.`;
  }
  if (r.allowedValues) {
    if (!r.allowedValues.length || r.allowedValues.length > GRANT_MAX_VALUES) return `List 1 to ${GRANT_MAX_VALUES} allowed values, or none.`;
    if (r.allowedValues.some((v) => !v.trim() || v.length > 200)) return "An allowed value is 1 to 200 characters.";
    if (r.field.choices.length && r.allowedValues.some((v) => !r.field!.choices.includes(v))) return "Allowed values must be the field's own choices.";
  }
  return null;
}
