import { getDomain } from "tldts";

export type CandidateKeys = { nameAddress?: string; domain?: string; linkedin?: string; placeId?: string; registryId?: string };
export type CandidateSource = { kind: string; url: string; quote: string };
export type CompanyCandidate = {
  name: string; domain?: string; address?: string; linkedinUrl?: string;
  keys?: CandidateKeys; sources: CandidateSource[];
};

const words = (s: string) => s.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
export function normalizeCompanyName(name: string): string {
  return words(name).replace(/(?:\s+(?:incorporated|inc|llc|corporation|corp|company|co|limited|ltd))+$/, "");
}
const ADDRESS_WORDS: Record<string, string> = {
  street: "st", road: "rd", avenue: "ave", boulevard: "blvd", drive: "dr", lane: "ln", court: "ct", highway: "hwy",
  suite: "ste", apartment: "apt", north: "n", south: "s", east: "e", west: "w", united: "united", states: "states",
};
export const normalizeAddress = (address: string): string => words(address).split(" ").map((w) => ADDRESS_WORDS[w] ?? w).join(" ");
export function rootDomain(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return undefined;
    return getDomain(url.hostname, { allowPrivateDomains: true }) ?? undefined;
  } catch { return undefined; }
}
export function canonicalLinkedin(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    const id = u.pathname.match(/^\/company\/([a-z0-9_-]+)(?:\/|$)/i)?.[1];
    return /^(?:(?:www|[a-z]{2,3})\.)?linkedin\.com$/i.test(u.hostname) && id ? `https://www.linkedin.com/company/${id.toLowerCase()}` : undefined;
  } catch { return undefined; }
}
export function candidateKeys(c: CompanyCandidate): CandidateKeys {
  const name = normalizeCompanyName(c.name), address = normalizeAddress(c.address ?? "");
  const keys: CandidateKeys = {
    nameAddress: name && address ? `${name}|${address}` : undefined,
    domain: rootDomain(c.domain ?? c.keys?.domain), linkedin: canonicalLinkedin(c.linkedinUrl ?? c.keys?.linkedin),
    placeId: c.keys?.placeId?.trim() || undefined, registryId: c.keys?.registryId?.trim().toLowerCase() || undefined,
  };
  return Object.fromEntries(Object.entries(keys).filter(([, v]) => v));
}
export function unionSources(rows: readonly CandidateSource[]): CandidateSource[] {
  return [...new Map(rows.map((s) => [JSON.stringify([s.kind, s.url, s.quote]), s])).values()];
}

export type CandidateGroup = { indices: number[]; company: CompanyCandidate & { keys: CandidateKeys }; workspaceDuplicate: boolean };

/** Connected components retain aliases, including bridges between previously separate companies. */
export function dedupeCandidates(rows: readonly CompanyCandidate[], workspace: readonly { domain?: string; linkedinUrl?: string }[] = []): CandidateGroup[] {
  const parent = rows.map((_, i) => i), keys = rows.map(candidateKeys), seen = new Map<string, number>();
  const find = (i: number): number => parent[i] === i ? i : (parent[i] = find(parent[i]));
  keys.forEach((key, i) => {
    for (const [field, value] of Object.entries(key)) {
      const k = `${field}:${value}`, prior = seen.get(k);
      if (prior !== undefined) parent[find(i)] = find(prior);
      else seen.set(k, i);
    }
  });
  const existing = new Set(workspace.flatMap((c) => [rootDomain(c.domain), canonicalLinkedin(c.linkedinUrl)].filter(Boolean)));
  const groups = new Map<number, number[]>();
  rows.forEach((_, i) => { const root = find(i); groups.set(root, [...(groups.get(root) ?? []), i]); });
  return [...groups.values()].map((indices) => {
    const members = indices.map((i) => rows[i]);
    const merged = Object.assign({}, ...indices.map((i) => keys[i])) as CandidateKeys;
    return { indices, workspaceDuplicate: indices.some((i) => Boolean(existing.has(keys[i].domain) || existing.has(keys[i].linkedin))), company: {
      name: members[0].name, keys: merged, sources: unionSources(members.flatMap((c) => c.sources)),
      ...(merged.domain ? { domain: merged.domain } : {}), ...(merged.linkedin ? { linkedinUrl: merged.linkedin } : {}),
      ...(members.find((c) => c.address)?.address ? { address: members.find((c) => c.address)!.address } : {}),
    } };
  });
}
