/**
 * Finding an account's public job board (Greenhouse, Lever or Ashby) from its
 * domain, for the scheduled signal check (convex/signalActions.ts). The boards
 * are keyed by a company token that is usually the domain's name ("acme.com" ->
 * "acme"), so discovery tries that token on each provider and keeps the first
 * board with open roles that belongs to the account (boardBelongsTo). No key, no cost. Runs with plain fetch: no Node imports.
 */
import { fetchAtsJobs, type AtsBoardSource, type AtsJob } from "../../../engine/src/connectors/atsBoards.ts";

/** Accounts one signal check covers, best fit first. */
export const MAX_ACCOUNTS = 300;

export const BOARD_SOURCES: AtsBoardSource[] = ["greenhouse", "lever", "ashby"];

/** Board tokens worth trying for a domain, best first: "get-acme.co.uk" -> "get-acme", "getacme". */
export function boardTokens(domain: string): string[] {
  const labels = domain.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/:?#].*$/, "").split(".").filter(Boolean);
  if (labels.length < 2) return [];
  // "co.uk", "com.au": a two-letter country code behind a short generic label is part of the suffix.
  const suffix = labels.length >= 3 && labels[labels.length - 1].length === 2 && labels[labels.length - 2].length <= 3 ? 2 : 1;
  const name = labels[labels.length - 1 - suffix];
  if (!name || !/^[a-z0-9-]+$/.test(name)) return [];
  return [...new Set([name, name.replace(/-/g, "")])].filter(Boolean);
}

const words = (text: string) => ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
};

/**
 * Whether an open board belongs to the account, not another company that uses
 * the same token ("mercury" is more than one company). Proof is either the
 * account's domain (a posting that lives on it or names it) or its name in at
 * least half of the roles' text. A board with no roles proves nothing, so it
 * is not trusted.
 */
export function boardBelongsTo(jobs: AtsJob[], account: { domain: string; name?: string }): boolean {
  if (!jobs.length) return false;
  const domain = account.domain.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/:?#].*$/, "");
  if (!domain) return false;
  const domainRe = new RegExp(`(^|[^a-z0-9-])${domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9.-]|\\.(?![a-z0-9]))`, "i");
  const text = (j: AtsJob) => `${j.title} ${j.description ?? j.jdSnippet}`;
  for (const j of jobs) {
    const host = hostOf(j.url);
    if (host === domain || host.endsWith(`.${domain}`) || domainRe.test(text(j))) return true;
  }
  const name = account.name ? words(account.name).trim() : "";
  if (name.length < 4) return false;
  const named = jobs.filter((j) => words(text(j)).includes(` ${name} `)).length;
  return named * 2 >= jobs.length;
}

export type BoardHit = { source: AtsBoardSource; token: string; jobs: AtsJob[] };

/**
 * Probe the providers for a domain's board. `hit` is null for a miss. `transient`
 * is set when a probe failed in a way that says nothing about whether a board
 * exists (network error, 429, 5xx), so the caller does not cache that miss.
 */
export async function discoverBoard(domain: string, name: string | undefined, fetchImpl: typeof fetch): Promise<{ hit: BoardHit | null; transient: boolean }> {
  let transient = false;
  const watched: typeof fetch = async (input, init) => {
    try {
      const res = await fetchImpl(input, init);
      if (res.status === 429 || res.status >= 500) transient = true;
      return res;
    } catch (error) {
      transient = true;
      throw error;
    }
  };
  for (const token of boardTokens(domain)) {
    for (const source of BOARD_SOURCES) {
      const jobs = await fetchAtsJobs({ source, boardToken: token, accountDomain: domain, fetchImpl: watched });
      // A board that exists but is another company's is a miss for this account.
      if (jobs.length && boardBelongsTo(jobs, { domain, name })) return { hit: { source, token, jobs }, transient };
    }
  }
  return { hit: null, transient };
}
