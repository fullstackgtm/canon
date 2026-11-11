/**
 * Preview since 2026-11-10. A data or sending provider as Canon's provider registry knows it: what it does, which keys
 * it needs (names only), what a call costs the workspace, how often it may run and who must agree before it runs. A
 * self-hosted Canon resolves each capability to one of these per workspace: the workspace's own key first, then the
 * deployment's, else none, with a reason. The shape may still change before it is stable.
 *
 * Pure: no imports and no network code. Canon's registry (convex/lib/providers/registry.ts) declares its providers with
 * it and checks them with `providerProblems`.
 */

/** What a provider can do for a workspace. */
export const PROVIDER_CAPABILITIES = {
  "email.find": { label: "Find work email" },
  "email.verify": { label: "Verify email" },
  "phone.find": { label: "Find phone" },
  "person.enrich": { label: "Enrich person" },
  "company.enrich": { label: "Enrich company" },
  "people.search": { label: "Search people" },
  "web.search": { label: "Search the web" },
  "linkedin.send": { label: "Send LinkedIn invites and messages" },
  "linkedin.read": { label: "Read LinkedIn profiles and messages" },
  "email.send": { label: "Send email" },
  "email.read": { label: "Read email" },
  "sequence.enroll": { label: "Add people to a sequencer campaign" },
  "phone.call": { label: "Call" },
} as const satisfies Record<string, { label: string }>;
export type ProviderCapability = keyof typeof PROVIDER_CAPABILITIES;

/**
 * A key a provider needs, by name. `workspace`: a workspace admin brings it (stored sealed, per workspace).
 * `deployment`: the deployment's environment holds it, so every workspace on the deployment shares it.
 */
export type ProviderKey = { name: string; source: "workspace" | "deployment"; label?: string };

/**
 * What one call costs the workspace. `free`: nothing. `own_account`: the provider bills the workspace's own account
 * with it, and Canon charges nothing. Credits are Canon's, charged per call made or only per call that found something.
 */
export type ProviderCost = "free" | "own_account" | { credits: number; per: "call" | "hit" };

/** At most `max` calls (or, with `counts: "hits"`, calls that found something) per workspace in each window. */
export type ProviderLimit = { max: number; per: "minute" | "day" | "month"; counts?: "calls" | "hits" };

/** Who agrees before a call runs: an admin for the workspace, or each member for their own account. */
export type ProviderConsent = { by: "admin" | "member"; terms: string };

/**
 * What one capability of a provider costs and how often it may run, where that differs from the provider's own
 * `cost` and `limits`. `note` says in a sentence what the cost depends on.
 */
export type ProviderTerms = { cost?: ProviderCost; limits?: readonly ProviderLimit[]; note?: string };

export type ProviderDecl = {
  /** Lowercase, as `deepline`. */
  id: string;
  label: string;
  capabilities: readonly ProviderCapability[];
  keys: readonly ProviderKey[];
  cost: ProviderCost;
  limits?: readonly ProviderLimit[];
  consent?: readonly ProviderConsent[];
  /** Per capability, where its cost or limits differ from the provider's. */
  terms?: Partial<Record<ProviderCapability, ProviderTerms>>;
};

const ID = /^[a-z][a-z0-9_]{0,31}$/;
const KEY = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Every problem with a declaration, each with its path; empty when it is valid. */
export function providerProblems(decl: ProviderDecl): string[] {
  const out: string[] = [];
  if (!ID.test(decl.id)) out.push("id must be lowercase letters, digits and _, starting with a letter");
  if (!decl.label.trim()) out.push("label is empty");
  if (!decl.capabilities.length) out.push("capabilities is empty");
  decl.capabilities.forEach((c, i) => { if (!Object.hasOwn(PROVIDER_CAPABILITIES, c)) out.push(`capabilities[${i}] names no capability`); });
  if (new Set(decl.capabilities).size !== decl.capabilities.length) out.push("capabilities repeats one");
  if (!decl.keys.length) out.push("keys is empty: a provider that needs no key is not a provider");
  decl.keys.forEach((k, i) => { if (!KEY.test(k.name)) out.push(`keys[${i}].name must be an uppercase name, as API_KEY`); });
  if (new Set(decl.keys.map((k) => k.name)).size !== decl.keys.length) out.push("keys repeats a name");
  const costProblems = (cost: ProviderCost | undefined, at: string) => {
    if (typeof cost === "object" && !(Number.isFinite(cost.credits) && cost.credits > 0)) out.push(`${at}cost.credits must be above 0; a call that costs nothing is free`);
  };
  const limitProblems = (limits: readonly ProviderLimit[] | undefined, at: string) =>
    limits?.forEach((l, i) => { if (!(Number.isSafeInteger(l.max) && l.max > 0)) out.push(`${at}limits[${i}].max must be a whole number above 0`); });
  costProblems(decl.cost, "");
  limitProblems(decl.limits, "");
  for (const [c, t] of Object.entries(decl.terms ?? {})) {
    if (!decl.capabilities.includes(c as ProviderCapability)) out.push(`terms.${c} names a capability the provider doesn't declare`);
    costProblems(t?.cost, `terms.${c}.`);
    limitProblems(t?.limits, `terms.${c}.`);
    if (t?.note !== undefined && !t.note.trim()) out.push(`terms.${c}.note is empty`);
  }
  decl.consent?.forEach((c, i) => { if (!c.terms.trim()) out.push(`consent[${i}].terms is empty`); });
  return out;
}
