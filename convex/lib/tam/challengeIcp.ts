import { SENIORITIES, type LeadsforgeFilters } from "../leadsforge.ts";
import { icpToQuickEnrich, type QuickEnrichQuery } from "../quickenrich.ts";
import type { Icp } from "../../../engine/src/icp.ts";
import type { FetchedPage, PageFetcher, ToolCaller } from "../research/agentLoop.ts";
import { MAX_READ_URLS, CRM_SOURCE, contextText, PROPOSE_SCHEMA, proposePrompt, CITE_SCHEMA, citePrompt, parseProposals, verifyClaims, addCited, type Proposal, type ChallengeContext } from "../../../modules/kernel/icpChallenge.ts";

/**
 * The Leadsforge search that populates a market: its industries, size and
 * countries, with the current ICP's buyer seniorities (who we sell to doesn't
 * change, only where we look). Countries the market doesn't name stay as the ICP's.
 */
export function proposalFilters(p: Pick<Proposal, "industries" | "employeeMin" | "employeeMax" | "countries">, icp: LeadsforgeFilters): LeadsforgeFilters {
  const f: LeadsforgeFilters = { companyIndustries: { include: p.industries } };
  const locations = p.countries.length ? p.countries : icp.companyLocations?.include ?? [];
  if (locations.length) f.companyLocations = { include: locations };
  if (p.employeeMin !== undefined || p.employeeMax !== undefined) {
    f.companyEmployeeNumberRange = { ...(p.employeeMin !== undefined ? { min: p.employeeMin } : {}), ...(p.employeeMax !== undefined ? { max: p.employeeMax } : {}) };
  } else if (icp.companyEmployeeNumberRange) f.companyEmployeeNumberRange = icp.companyEmployeeNumberRange;
  const seniorities = (icp.leadSeniorities?.include ?? []).filter((s) => (SENIORITIES as readonly string[]).includes(s));
  if (seniorities.length) f.leadSeniorities = { include: seniorities };
  return f;
}

/**
 * The same market as a QuickEnrich search (the free fill): the proposal's
 * industries, size and countries over the session ICP's buyer persona.
 */
export function proposalQuickEnrich(p: Pick<Proposal, "industries" | "employeeMin" | "employeeMax" | "countries">, icp: Icp | undefined): QuickEnrichQuery {
  const sized = p.employeeMin !== undefined || p.employeeMax !== undefined;
  const band = p.employeeMax !== undefined ? `${p.employeeMin ?? 1}-${p.employeeMax}` : `${p.employeeMin ?? 1}+`;
  return icpToQuickEnrich({
    name: icp?.name ?? "market",
    persona: icp?.persona ?? {},
    firmographics: {
      industries: p.industries,
      geos: p.countries.length ? p.countries : icp?.firmographics.geos ?? [],
      employeeBands: sized ? [band] : icp?.firmographics.employeeBands ?? [],
    },
  } as Icp);
}

/**
 * The whole challenge with the model and the page fetcher injected: read the
 * company's site, propose markets, read the pages the model asked for, let it
 * cite them, and keep only quotes that are verbatim in what was read.
 */
export async function challengeIcp(
  c: ChallengeContext,
  icp: LeadsforgeFilters,
  deps: { call: ToolCaller; fetchPage: PageFetcher },
): Promise<Proposal[]> {
  const home = c.vendorDomain ? await deps.fetchPage(`https://${c.vendorDomain}/`).catch(() => null) : null;
  const crm: FetchedPage = { url: CRM_SOURCE, text: contextText(c), links: [] };
  const known = [crm, ...(home?.text ? [home] : [])];
  const raw = await deps.call(proposePrompt(c, home?.text ? [home] : []), "challenge_icp", PROPOSE_SCHEMA);
  let proposals = parseProposals(raw, { icp, decided: c.decided }).map((p) => ({ ...p, claims: verifyClaims(p.claims, known) }));
  const urls = [...new Set(proposals.flatMap((p) => p.readUrls))].slice(0, MAX_READ_URLS);
  const read = (await Promise.all(urls.map((u) => deps.fetchPage(u).catch(() => null)))).filter((p): p is FetchedPage => !!p?.text);
  if (read.length && proposals.length) {
    const cited = await deps.call(citePrompt(proposals, read), "cite_pages", CITE_SCHEMA);
    proposals = addCited(proposals, cited, read);
  }
  return proposals;
}
