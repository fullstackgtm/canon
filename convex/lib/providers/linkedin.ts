/**
 * LinkedIn through the provider registry (registry.ts): the only place a Unipile client for LinkedIn is made. Unipile
 * runs on the deployment's key; each member links their own LinkedIn account to it. A workspace key for LinkedIn is not
 * offered yet, so resolution reads the deployment alone.
 */
import { ConvexError } from "convex/values";
import { createUnipileClient, type UnipileClient } from "../linkedin/unipile";
import type { ProviderCapability } from "../../../modules/kernel/providers.ts";
import { resolveCapability } from "./registry";

/** Unipile's DSN is a host and port from its dashboard, e.g. "api8.unipile.com:13851". */
export const DSN_SHAPE = /^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{2,5})?\/?$/i;

/** Canon's Unipile key and host, or null when this deployment has none. Gmail and Outlook use the same key. */
export function unipileEnv(): { apiKey: string; dsn: string } | null {
  const ready = resolveCapability("linkedin.send", { workspace: new Set(), env: process.env }).chain.length > 0;
  return ready ? { apiKey: process.env.UNIPILE_API_KEY!, dsn: process.env.UNIPILE_DSN! } : null;
}

/** A Unipile client for a LinkedIn capability, or null when no provider serves it here (`reason` says why). */
export function linkedinClient(capability: Extract<ProviderCapability, `linkedin.${string}`>): { client: UnipileClient; apiKey: string } | { client: null; reason: string } {
  const resolution = resolveCapability(capability, { workspace: new Set(), env: process.env });
  const env = unipileEnv();
  if (!resolution.chain.length || !env) return { client: null, reason: resolution.reason ?? "LinkedIn isn't set up on this deployment." };
  return { client: createUnipileClient(env), apiKey: env.apiKey };
}

/** linkedinClient, throwing the reason for a person's request; a malformed DSN is the deployment's to fix. */
export function linkedinClientOrThrow(capability: Extract<ProviderCapability, `linkedin.${string}`>): { client: UnipileClient; apiKey: string } {
  const env = unipileEnv();
  if (env && !DSN_SHAPE.test(env.dsn)) throw new ConvexError("UNIPILE_DSN must be the host and port from Unipile's dashboard, like api8.unipile.com:13851.");
  const r = linkedinClient(capability);
  if (!r.client) throw new ConvexError(r.reason);
  return r;
}
