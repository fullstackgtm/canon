import { normalizeCompanyName, rootDomain, type CompanyCandidate } from "./dedupe.ts";

export type WebsiteFinderDeps = {
  paid: boolean;
  resolveName: (name: string) => Promise<string | null>;
  resolves: (domain: string) => Promise<boolean>;
  fetchPage: (url: string) => Promise<{ text: string; finalUrl: string } | null>;
  sameCompany: (company: CompanyCandidate, homepage: string, domain: string) => Promise<"yes" | "no" | "unsure">;
  maps: (query: string) => Promise<string[]>;
};
export type WebsiteResult = { domain: string; method: "source" | "resolver" | "dns" | "maps" } | { reason: string };
export function dnsGuesses(name: string): string[] {
  const words = normalizeCompanyName(name).split(" ").filter(Boolean), joined = words.join("");
  if (!joined || joined.length > 60) return [];
  return [...new Set(["com", "net", "us"].flatMap((tld) => [joined, `${joined}inc`, words.join("-")].map((stem) => `${stem}.${tld}`)))];
}
export async function findWebsite(company: CompanyCandidate, deps: WebsiteFinderDeps): Promise<WebsiteResult> {
  const tried = new Set<string>();
  let verdict = "No company website was found.";
  const check = async (raw: string, method: "source" | "resolver" | "dns" | "maps"): Promise<WebsiteResult | null> => {
    const domain = rootDomain(raw);
    if (!domain || tried.has(domain)) return null;
    tried.add(domain);
    try {
      if (method === "dns" && !(await deps.resolves(domain))) return null;
      const page = await deps.fetchPage(`https://${domain}`);
      if (!page || rootDomain(page.finalUrl) !== domain || page.text.length < 200 || /domain (?:is )?for sale|buy this domain|parkingcrew|sedoparking|access denied|verify you are human/i.test(page.text)) return null;
      const answer = await deps.sameCompany(company, page.text, domain);
      if (answer === "yes") return { domain, method };
      verdict = answer === "no" ? "The websites found belong to a different company." : "The website could not be confirmed as the same company.";
    } catch { verdict = "The website could not be read or confirmed."; }
    return null;
  };
  if (company.domain) { const hit = await check(company.domain, "source"); if (hit) return hit; }
  let resolved: string | null = null;
  try { resolved = await deps.resolveName(company.name); } catch { /* Continue with public DNS. */ }
  if (resolved) { const hit = await check(resolved, "resolver"); if (hit) return hit; }
  for (const guess of dnsGuesses(company.name)) { const hit = await check(guess, "dns"); if (hit) return hit; }
  if (deps.paid) {
    try { for (const domain of (await deps.maps(`${company.name} ${company.address ?? ""}`.trim())).slice(0, 5)) { const hit = await check(domain, "maps"); if (hit) return hit; } } catch { verdict = "Maps could not resolve a confirmed company website."; }
  }
  return { reason: verdict };
}
