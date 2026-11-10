import { websiteText } from "../../../modules/kernel/websiteSources.ts";
import { candidateKeys, rootDomain, type CompanyCandidate } from "./dedupe.ts";
import type { PlanSource } from "./investigation.ts";
import { catalogAllowsFetch } from "./sourceCatalog.ts";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;
export function pageLines(html: string): string[] {
  return html.replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/<style\b[\s\S]*?<\/style>/gi, "").replace(/<\/?(?:p|div|li|h[1-6]|section|article|tr|br)\b[^>]*>/gi, "\n").replace(/<[^>]*>/g, " ").split("\n").map(websiteText).filter(Boolean);
}
export function directoryRows(html: string, url: string, result: unknown): CompanyCandidate[] {
  const lines = pageLines(html), rows = object(result).companies;
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 100).flatMap((raw) => {
    const row = object(raw), name = string(row.name);
    const quote = name && lines.find((line) => line.includes(name) && line.length <= 1000);
    if (!name || name.length > 200 || !quote) return [];
    const domain = rootDomain(string(row.website));
    const company: CompanyCandidate = { name, ...(domain && html.toLowerCase().includes(domain) ? { domain } : {}), ...(string(row.address) && websiteText(html).includes(String(row.address)) ? { address: string(row.address) } : {}), sources: [{ kind: "directory", url, quote }] };
    return [{ ...company, keys: candidateKeys(company) }];
  });
}
export function nextDirectoryPage(html: string, base: string): string | undefined {
  const tag = [...html.matchAll(/<(?:a|link)\b[^>]*>/gi)].map((m) => m[0]).find((t) => /\brel\s*=\s*["']next["']/i.test(t));
  const href = tag?.match(/\bhref\s*=\s*["']([^"']+)/i)?.[1];
  if (!href) return undefined;
  try { const url = new URL(href.replaceAll("&amp;", "&"), base); return /^https?:$/.test(url.protocol) && url.origin === new URL(base).origin && catalogAllowsFetch(url.href) ? url.href : undefined; } catch { return undefined; }
}
export function employerRows(people: readonly { title?: string; company: { name?: string; domain: string } }[]): CompanyCandidate[] {
  return people.flatMap((p) => {
    const domain = rootDomain(p.company.domain);
    if (!domain || !p.company.name?.trim() || !p.title?.trim()) return [];
    const company = { name: p.company.name.trim(), domain, sources: [{ kind: "people_phrase", url: "https://treg.to/call/quickenrich.people.search", quote: p.title }] };
    return [{ ...company, keys: candidateKeys(company) }];
  });
}
export function mapsWebsites(body: unknown): string[] {
  const places = object(object(body).output).places;
  return Array.isArray(places) ? places.slice(0, 5).flatMap((row) => { const domain = rootDomain(string(object(row).website)); return domain ? [domain] : []; }) : [];
}
export function awardRows(body: unknown): { rows: CompanyCandidate[]; more: boolean } {
  const data = object(body), results = data.results;
  const rows = !Array.isArray(results) ? [] : results.slice(0, 100).flatMap((raw) => {
    const row = object(raw), name = string(row["Recipient Name"]), id = string(row.generated_internal_id);
    if (!name || !id) return [];
    const location = row["Recipient Location"];
    const address = typeof location === "string" ? location : ["address_line1", "address_line2", "address_line3", "city_name", "state_code", "zip5", "foreign_postal_code", "country_name"].map((key) => string(object(location)[key])).filter(Boolean).join(", ");
    const registryId = string(row["Recipient UEI"]);
    const company: CompanyCandidate = { name, ...(address ? { address } : {}), keys: registryId ? { registryId: `uei:${registryId}` } : {}, sources: [{ kind: "catalog", url: `https://www.usaspending.gov/award/${encodeURIComponent(id)}`, quote: name }] };
    return [{ ...company, keys: candidateKeys(company) }];
  });
  return { rows, more: object(data.page_metadata).hasNext === true };
}
export function governmentMarket(text: string): boolean {
  return /government|federal|public sector|defen[cs]e|contract(?:or|ing)|construction|civil engineering|facilities services|procurement|prevailing wage/i.test(text);
}
export function buildSourcePlan(directories: readonly { url: string; title: string; listedCount?: number }[], phrases: readonly string[], government: boolean, keyword: string): PlanSource[] {
  return [
    ...directories.filter((d) => catalogAllowsFetch(d.url)).slice(0, 20).map((d): PlanSource => ({ kind: "directory", ref: d.url, label: d.title, estimatedCompanies: Math.max(1, Math.min(500, Math.round(d.listedCount ?? 100))) })),
    ...[...new Set(phrases.map((p) => p.trim()).filter(Boolean))].slice(0, 3).map((phrase): PlanSource => ({ kind: "people_phrase", ref: phrase, label: `People with "${phrase}" in their title`, estimatedCompanies: 100 })),
    ...(government ? [{ kind: "catalog" as const, ref: keyword || "government contracting", label: "USAspending.gov contract recipients", estimatedCompanies: 100 }] : []),
  ];
}
