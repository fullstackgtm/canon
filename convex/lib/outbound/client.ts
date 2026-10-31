/**
 * What every sequencer adapter (Instantly, EmailBison, Smartlead) exposes, and
 * the one HTTP helper they share. The fetch is injected, so tests run each
 * against a fake HTTP layer.
 *
 * Errors carry the provider's name and the HTTP status, never the key, the URL
 * (Smartlead's key is a query parameter) or the response body.
 *
 * Pure: no database access, no Node-only imports.
 */
import type { OutboundContact } from "./audience.ts";

export type SequencerCampaign = { id: string; name: string; status?: string };

export type AddLeadsResult = {
  /** Lowercase emails the provider confirmed it added. Empty when its answer did not say. */
  created: string[];
  uploaded: number;
};

/** `onBatch` runs after each accepted batch, so a failure part way keeps what already went. */
export type BeforeBatch = (batch: readonly OutboundContact[]) => Promise<readonly OutboundContact[]>;
export type OnBatch = (batch: readonly OutboundContact[], result: AddLeadsResult) => Promise<void>;

export type SequencerClient = {
  /** Checks the key with one cheap read. Throws SequencerError when the provider refuses it. */
  validate(): Promise<void>;
  listCampaigns(): Promise<SequencerCampaign[]>;
  addLeads(campaignId: string, contacts: readonly OutboundContact[], onBatch?: OnBatch, beforeBatch?: BeforeBatch): Promise<AddLeadsResult>;
};

export class SequencerError extends Error {
  readonly status: number;
  /** Seconds the provider asked to wait (429 Retry-After), when it said. */
  readonly retryAfter?: number;
  /** `status` 0: the request never got a readable answer. */
  constructor(label: string, status: number, retryAfter?: number) {
    super(
      status === 401 || status === 403
        ? `${label} rejected the API key (HTTP ${status}). Check the key and its scopes.`
        : status === 429
          ? `${label} is rate limiting this key (HTTP 429). Try again in ${retryAfter ? `${retryAfter} seconds` : "a minute"}.`
          : status === 0
            ? `${label} did not answer readably. Try again.`
            : `${label} request failed (HTTP ${status}).`,
    );
    this.name = "SequencerError";
    this.status = status;
    if (retryAfter) this.retryAfter = retryAfter;
  }
}

/** One JSON call. Whatever goes wrong, the error is a SequencerError built from the status alone. */
export async function requestJson<T>(label: string, fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch {
    // The runtime's own message can quote the URL, and Smartlead's carries the key.
    throw new SequencerError(label, 0);
  }
  if (!response.ok) {
    const wait = Number(response.headers.get("Retry-After"));
    throw new SequencerError(label, response.status, Number.isFinite(wait) && wait > 0 ? wait : undefined);
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new SequencerError(label, 0);
  }
}

export const str = (x: unknown): string | undefined => (typeof x === "string" && x ? x : undefined);
/** Ids arrive as strings (Instantly) or integers (EmailBison, Smartlead); Canon keeps them as strings. */
export const idOf = (x: unknown): string | undefined => (typeof x === "number" && Number.isSafeInteger(x) ? String(x) : str(x));
export const num = (x: unknown) => (typeof x === "number" ? x : 0);
