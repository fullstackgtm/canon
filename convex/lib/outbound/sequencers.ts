/**
 * The sequencers an audience can be pushed to, keyed by id: everything that
 * differs between them (label, campaign ids, what connecting asks for, the
 * leads a provider refuses, the client) lives here, so the actions, the push
 * and the screens never branch on a provider.
 *
 * A push's target is `<id>:<campaign id>`; audienceMembers dedupe on it, and
 * `instantly:` targets keep the shape they had before the registry.
 *
 * Pure: no database access, no Node-only imports. The dashboard reads it too.
 */
import type { OutboundContact } from "./audience.ts";
import type { SequencerClient } from "./client.ts";
import { createEmailBisonClient, hasFirstName, EMAILBISON_BATCH } from "./emailbison.ts";
import { createInstantlyClient, INSTANTLY_BATCH } from "./instantly.ts";
import { createSmartleadClient, SMARTLEAD_BATCH } from "./smartlead.ts";

export const SEQUENCER_IDS = ["instantly", "emailbison", "smartlead"] as const;
export type SequencerId = (typeof SEQUENCER_IDS)[number];

export type Connection = { apiKey: string; instanceUrl?: string; fetchImpl?: typeof fetch };

export type SequencerDef = {
  batchSize: number;
  label: string;
  /** What the key is called in the provider's settings. */
  keyLabel: string;
  /** Set when each customer has their own host, which connecting asks for. */
  instanceUrl?: { label: string; placeholder: string };
  campaignId: RegExp;
  /** Leads the provider refuses: skipped before the push and counted in the preview. */
  requires?: { accepts: (c: OutboundContact) => boolean; reason: string };
  create(conn: Connection): SequencerClient;
};

const INT_ID = /^\d{1,12}$/;

export const SEQUENCERS: Record<SequencerId, SequencerDef> = {
  instantly: {
    batchSize: INSTANTLY_BATCH,
    label: "Instantly",
    keyLabel: "API key",
    campaignId: /^[\w-]{1,64}$/,
    create: ({ apiKey, fetchImpl }) => createInstantlyClient({ apiKey, fetchImpl }),
  },
  emailbison: {
    batchSize: EMAILBISON_BATCH,
    label: "EmailBison",
    keyLabel: "API token",
    instanceUrl: { label: "EmailBison URL", placeholder: "https://send.yourdomain.com" },
    campaignId: INT_ID,
    requires: { accepts: hasFirstName, reason: "no first name" },
    create: ({ apiKey, instanceUrl, fetchImpl }) => {
      if (!instanceUrl) throw new Error("EmailBison needs its instance URL");
      return createEmailBisonClient({ apiKey, baseUrl: instanceUrl, fetchImpl });
    },
  },
  smartlead: {
    batchSize: SMARTLEAD_BATCH,
    label: "Smartlead",
    keyLabel: "API key",
    campaignId: INT_ID,
    create: ({ apiKey, fetchImpl }) => createSmartleadClient({ apiKey, fetchImpl }),
  },
};

export const isSequencerId = (x: unknown): x is SequencerId => (SEQUENCER_IDS as readonly unknown[]).includes(x);

export const targetOf = (provider: SequencerId, campaignId: string) => `${provider}:${campaignId}`;

/** A history target as words: "Smartlead campaign 42". Null for one that is not a sequencer's (the CSV export). */
export function targetLabel(target: string): string | null {
  const at = target.indexOf(":");
  const provider = target.slice(0, at);
  return at > 0 && isSequencerId(provider) ? `${SEQUENCERS[provider].label} campaign ${target.slice(at + 1)}` : null;
}

/**
 * A customer's host as a bare https origin, or null. Only public https hosts: the key is sent there, so no
 * http, credentials, ports, IP literals or local names.
 */
export function normalizeInstanceUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  if (!host.includes(".") || host.endsWith(".local") || host.endsWith(".internal") || /^[\d.]+$/.test(host) || host.startsWith("[")) return null;
  return `https://${host}`;
}
