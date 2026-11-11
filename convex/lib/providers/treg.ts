/**
 * Canon's hosted data on treg through the provider registry (registry.ts): the deployment's treg key for people
 * search, company lookups and enrichment, and the one way their adapters (lib/quickenrich.ts, lib/leadsforge.ts,
 * lib/companyenrich.ts, lib/crustdata.ts) are called. Each call reads its key from the registry's resolution of its
 * capability when it runs, and takes every other option as before. tests/providerCensus.test.ts fails on a caller
 * that goes round this.
 */
import { companyNameFor, domainForName } from "../companyenrich";
import { identifyCompanies, identifyCompanyDetails } from "../crustdata";
import { leadsforgeTam, searchLeads } from "../leadsforge";
import { quickEnrichPage, quickEnrichTam } from "../quickenrich";
import { tregCall } from "../treg";
import type { ProviderCapability } from "../../../modules/kernel/providers.ts";
import { ProviderUnavailable, resolveCapability } from "./registry";

/** The capabilities Canon serves on its treg key. */
export type TregCapability = Extract<ProviderCapability, "phone.find" | "person.enrich" | "company.enrich" | "people.search">;

const resolve = (capability: TregCapability) => resolveCapability(capability, { workspace: new Set(), env: process.env });

/** The deployment's treg key when the registry resolves treg for `capability` here, else null (nothing is set up). */
export function tregKey(capability: TregCapability): string | null {
  return resolve(capability).chain.some((c) => c.provider === "treg") ? process.env.TREG_TOKEN! : null;
}

/** `tregKey`, throwing ProviderUnavailable (its message names the key) when there is none. */
export function requireTregKey(capability: TregCapability): string {
  const key = tregKey(capability);
  if (!key) throw new ProviderUnavailable(resolve(capability));
  return key;
}

/** An adapter call on the deployment's key for `capability`: the same options as the adapter, without `token`. */
const keyed = <O extends { token: string }, R>(capability: TregCapability, adapter: (opts: O) => R) =>
  (opts: Omit<O, "token">): R => adapter({ ...opts, token: requireTregKey(capability) } as O);

/** One treg call for `capability`, as tregCall takes it, without `token`. */
export const tregFor = (capability: TregCapability, opts: Omit<Parameters<typeof tregCall>[0], "token">) =>
  tregCall({ ...opts, token: requireTregKey(capability) });

/** A page of QuickEnrich's people search (lib/quickenrich.ts quickEnrichPage). */
export const peoplePage = keyed("people.search", quickEnrichPage);
/** The pre-signup TAM from QuickEnrich (quickEnrichTam). */
export const peopleTam = keyed("people.search", quickEnrichTam);
/** One Leadsforge search (lib/leadsforge.ts searchLeads). */
export const leadsPage = keyed("people.search", searchLeads);
/** The pre-signup TAM from Leadsforge (leadsforgeTam). */
export const leadsTam = keyed("people.search", leadsforgeTam);
/** A company's real name for its domain, from CompanyEnrich autocomplete (lib/companyenrich.ts companyNameFor). */
export const companyName = keyed("company.enrich", companyNameFor);
/** The domain of a company by its name, from CompanyEnrich autocomplete (domainForName). */
export const companyDomain = keyed("company.enrich", domainForName);
/** Domain to real name, from Crustdata identify (lib/crustdata.ts identifyCompanies). */
export const identifyNames = keyed("company.enrich", identifyCompanies);
/** Domain to firmographics, from Crustdata identify (identifyCompanyDetails). */
export const identifyDetails = keyed("company.enrich", identifyCompanyDetails);
