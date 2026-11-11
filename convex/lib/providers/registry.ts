/**
 * Canon's provider registry: the data and sending providers it can call, declared with the module kit's provider
 * contract (modules/kernel/providers.ts), and which one serves a capability in a workspace. Resolution order is the
 * workspace's own key first (bring your own key), then the deployment's key, else nothing, with a reason that names
 * the keys that would turn it on. Names only: no value of a key ever passes through here.
 *
 * Email finding (emailFind.ts), phone finding (phoneFind.ts), research enrichment (enrich.ts), Canon's other treg
 * people searches and company lookups (treg.ts) and LinkedIn (linkedin.ts) run through it. tests/providerCensus.test.ts
 * lists every other provider call site and fails on a new one, or on a call for a capability here that skips it.
 *
 * Pure: no database access, no network, no Node-only imports.
 */
import { PROVIDER_CAPABILITIES, type ProviderCapability, type ProviderConsent, type ProviderDecl, type ProviderKey, type ProviderLimit } from "../../../modules/kernel/providers.ts";
import { INTEGRATIONS_AVAILABLE, type IntegrationEnv } from "../integrationsAvailable.ts";

/** Work-email lookups a workspace may run per UTC day (one paid treg/Hunter lookup each, billed only on a hit). */
export const EMAIL_LOOKUPS_PER_DAY = 100;
/**
 * Paid (Hunter) email hits a workspace gets per UTC month on the flat plan. Each costs Canon up to $0.25, so this
 * bounds the one per-use cost that would otherwise scale without limit (docs/pricing.md). The free getleadsio path is
 * not counted.
 */
export const PAID_EMAIL_HITS_PER_MONTH = 100;
/** Phone lookups a workspace may run per UTC day. */
export const PHONE_LOOKUPS_PER_DAY = 50;
/** Paid phone hits a workspace gets per UTC month (each up to PHONE_LOOKUP_MAX_COST_USD; misses are free). */
export const PAID_PHONE_HITS_PER_MONTH = 50;

const deploymentKeys = (feature: keyof typeof INTEGRATIONS_AVAILABLE): ProviderKey[] =>
  INTEGRATIONS_AVAILABLE[feature].keys.map((name) => ({ name, source: "deployment" }));

export const PROVIDERS = {
  deepline: {
    id: "deepline",
    label: "Deepline",
    capabilities: ["email.find"],
    keys: [{ name: "DEEPLINE_API_KEY", source: "workspace", label: "Deepline API key" }],
    cost: "own_account",
    consent: [{ by: "admin", terms: "An admin connects the workspace's own Deepline account, which Deepline bills for each lookup." }],
  },
  treg: {
    id: "treg",
    label: "Canon data (treg)",
    capabilities: ["email.find", "phone.find", "person.enrich", "company.enrich", "people.search"],
    keys: deploymentKeys("treg"),
    cost: "free",
    terms: {
      "email.find": { limits: [{ max: EMAIL_LOOKUPS_PER_DAY, per: "day", counts: "calls" }, { max: PAID_EMAIL_HITS_PER_MONTH, per: "month", counts: "hits" }] },
      "phone.find": { limits: [{ max: PHONE_LOOKUPS_PER_DAY, per: "day", counts: "calls" }, { max: PAID_PHONE_HITS_PER_MONTH, per: "month", counts: "hits" }] },
      "person.enrich": { cost: { credits: 8, per: "hit" }, note: "A profile found costs 1 to 3 credits, by what it cost Canon; a job change check costs 8." },
      "company.enrich": { cost: { credits: 1, per: "hit" }, note: "A company profile Research finds costs 1 credit; a company's name or domain is looked up free." },
      "people.search": { note: "Free, except a paid source, which costs credits for each person it keeps at its catalog price." },
    },
  },
  unipile: {
    id: "unipile",
    label: "Unipile",
    capabilities: ["linkedin.send", "linkedin.read"],
    keys: deploymentKeys("unipile"),
    cost: "free",
    consent: [{ by: "member", terms: "Each member links their own LinkedIn account and paces its invites and messages under LinkedIn's limits." }],
  },
} as const satisfies Record<string, ProviderDecl>;

export type ProviderId = keyof typeof PROVIDERS;
export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

/** Where a resolved provider's key comes from. */
export type KeySource = ProviderKey["source"];
export type ResolvedProvider = { provider: ProviderId; source: KeySource };

/**
 * A capability in one workspace: the providers that can serve it, in the order they run (a later one answers when an
 * earlier one misses or fails), and why none can when `chain` is empty.
 */
export type Resolution = { capability: ProviderCapability; chain: ResolvedProvider[]; reason: string | null };

/** What resolution reads: the providers whose workspace key is set, and the deployment's environment. */
export type ResolutionInputs = { workspace: ReadonlySet<string>; env: IntegrationEnv };

const sourceOf = (decl: ProviderDecl): KeySource => (decl.keys.some((k) => k.source === "workspace") ? "workspace" : "deployment");

function ready(decl: ProviderDecl, inputs: ResolutionInputs): boolean {
  return decl.keys.every((k) => (k.source === "workspace" ? inputs.workspace.has(decl.id) : Boolean(inputs.env[k.name]?.trim())));
}

const serving = (capability: ProviderCapability): ProviderDecl[] =>
  PROVIDER_IDS.map((id) => PROVIDERS[id] as ProviderDecl).filter((d) => d.capabilities.includes(capability));

/**
 * Which providers serve `capability` here: those with the workspace's own key, then those with the deployment's, each
 * in registry order. `sources` narrows it to one kind, for a caller that cannot use the other yet.
 */
export function resolveCapability(capability: ProviderCapability, inputs: ResolutionInputs, opts: { sources?: readonly KeySource[] } = {}): Resolution {
  const allowed = (s: KeySource) => !opts.sources || opts.sources.includes(s);
  const candidates = serving(capability).filter((d) => allowed(sourceOf(d)));
  const chain = (["workspace", "deployment"] as const).flatMap((source) =>
    candidates.filter((d) => sourceOf(d) === source && ready(d, inputs)).map((d) => ({ provider: d.id as ProviderId, source })));
  return { capability, chain, reason: chain.length ? null : unavailableReason(capability, candidates) };
}

function unavailableReason(capability: ProviderCapability, candidates: ProviderDecl[]): string {
  const label = PROVIDER_CAPABILITIES[capability].label;
  const byok = candidates.filter((d) => sourceOf(d) === "workspace").map((d) => d.label);
  const hosted = candidates.filter((d) => sourceOf(d) === "deployment").flatMap((d) => d.keys.map((k) => k.name));
  const ways = [
    ...(byok.length ? [`an admin connects ${byok.join(" or ")} with the workspace's own key`] : []),
    ...(hosted.length ? [`the deployment sets ${hosted.join(" and ")}`] : []),
  ];
  return ways.length ? `${label} is not set up here. It works once ${ways.join(", or ")}.` : `${label} has no provider in this version of Canon.`;
}

/**
 * Run `step` down a resolved chain until one answers. `step` returns null to pass to the next provider (a miss). A
 * provider that throws passes too while a later one can still answer; the last one's error is the caller's. The last
 * provider is called with `last` set and returns its miss instead of null.
 */
export async function runChain<T>(
  resolution: Resolution,
  step: (r: ResolvedProvider, last: boolean) => Promise<T | null>,
  onPass: (r: ResolvedProvider, error: unknown) => void = () => {},
): Promise<T> {
  if (!resolution.chain.length) throw new ProviderUnavailable(resolution);
  for (const [i, r] of resolution.chain.entries()) {
    const last = i === resolution.chain.length - 1;
    if (last) {
      const answer = await step(r, true);
      if (answer === null) throw new Error(`${r.provider} returned no answer as the last provider for ${resolution.capability}`);
      return answer;
    }
    try {
      const answer = await step(r, false);
      if (answer !== null) return answer;
    } catch (error) {
      onPass(r, error);
    }
  }
  throw new Error("unreachable");
}

/** No provider can serve the capability here; `message` is the reason, safe to show the person who asked. */
export class ProviderUnavailable extends Error {
  readonly capability: ProviderCapability;
  constructor(resolution: Resolution) {
    super(resolution.reason ?? `${resolution.capability} is unavailable`);
    this.name = "ProviderUnavailable";
    this.capability = resolution.capability;
  }
}

/** The record actions a capability serves: the app shows each only where a provider can serve it. */
export const ACTION_CAPABILITIES: Readonly<Record<string, ProviderCapability>> = {
  "kernel.findEmail": "email.find",
  "kernel.queueLinkedin": "linkedin.send",
};

/** The capabilities the registry serves, in contract order. */
export const SERVED_CAPABILITIES = (Object.keys(PROVIDER_CAPABILITIES) as ProviderCapability[]).filter((c) => serving(c).length);

/** One provider as Settings shows it under a capability: whether its keys are set and where each comes from. Names only. */
export type ProviderRow = {
  id: ProviderId; label: string; source: KeySource; ready: boolean; serving: boolean;
  keys: { name: string; label?: string; source: KeySource; set: boolean }[];
  cost: ProviderDecl["cost"]; limits: readonly ProviderLimit[]; note: string | null; consent: readonly ProviderConsent[];
};
export type CapabilityRow = { capability: ProviderCapability; label: string; ready: boolean; reason: string | null; providers: ProviderRow[] };

/** Every capability the registry serves, with the provider that serves it here and every one that could. */
export function providerSettings(inputs: ResolutionInputs): CapabilityRow[] {
  return SERVED_CAPABILITIES.map((capability) => {
    const resolution = resolveCapability(capability, inputs);
    const first = resolution.chain[0]?.provider;
    const providers = serving(capability).map((d): ProviderRow => ({
      id: d.id as ProviderId, label: d.label, source: sourceOf(d), ready: ready(d, inputs), serving: d.id === first,
      keys: d.keys.map((k) => ({ ...k, set: k.source === "workspace" ? inputs.workspace.has(d.id) : Boolean(inputs.env[k.name]?.trim()) })),
      cost: d.terms?.[capability]?.cost ?? d.cost, limits: d.terms?.[capability]?.limits ?? d.limits ?? [], note: d.terms?.[capability]?.note ?? null, consent: d.consent ?? [],
    }));
    providers.sort((a, b) => Number(b.source === "workspace") - Number(a.source === "workspace"));
    return { capability, label: PROVIDER_CAPABILITIES[capability].label, ready: resolution.chain.length > 0, reason: resolution.reason, providers };
  });
}
