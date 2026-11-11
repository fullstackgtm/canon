/**
 * Every place Canon calls a data or sending provider, by the client entry point it uses. A new call site fails here
 * until it is listed, and a call for a capability the provider registry serves (convex/lib/providers/registry.ts) fails
 * unless it runs inside the registry or in a provider adapter the registry calls. The other rows are the registry's
 * backlog: each moves under it as its capability is ported.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import type { ProviderCapability } from "../modules/kernel/providers.ts";
import { PROVIDERS } from "../convex/lib/providers/registry.ts";

const ROOT = join(import.meta.dirname, "..");

/** Each provider's client entry points, as a call reads in source; the definition itself is not a call site. */
const ENTRIES = {
  treg: /(?<!function )\btregCall\(/,
  deepline: /(?<!function )\bcreateDeeplineClient\(|\.findWorkEmail\(/,
  hostedEmail: /(?<!function )\b(findVerifiedWorkEmail|findWorkEmailViaTreg|findWorkEmailViaGetleads)\(/,
  hostedPhone: /(?<!function )\bfindPhoneViaTreg\(/,
  peopleSearch: /(?<!function )\b(quickEnrichPage|quickEnrichTam|searchLeads|leadsforgeTam)\(/,
  companyLookup: /(?<!function )\b(companyNameFor|domainForName|identifyCompanies|identifyCompanyDetails)\(/,
  unipile: /(?<!function )\bcreateUnipileClient\(/,
  telnyx: /(?<!function )\bcreateTelnyxClient\(/,
  sequencers: /\bSEQUENCERS\[/,
  explee: /(?<!function )\bcreateExpleeClient\(/,
  receipt: /\brecordProviderCall\b|insert\("providerCalls"/,
} as const;
type Entry = keyof typeof ENTRIES;

/** `connect`: checking a key or linking an account, not a call for a capability. `receipt`: filing a call's cost. */
type Use = ProviderCapability | "connect" | "receipt";

/** Adapters: a provider's own client code, which the registry calls and nothing else may. */
const ADAPTERS = new Set(["convex/lib/emailFinder.ts", "convex/lib/deepline.ts", "convex/lib/phoneFinder.ts", "convex/lib/companyenrich.ts", "convex/lib/crustdata.ts", "convex/lib/leadsforge.ts", "convex/lib/quickenrich.ts"]);

/** Calls for a served capability on a provider the registry doesn't declare yet, each ported later with its provider. */
const LATER: Record<string, readonly Use[]> = { "convex/expleeActions.ts": ["people.search"] };

const CENSUS: Record<string, Partial<Record<Entry, readonly Use[]>>> = {
  "convex/lib/providers/emailFind.ts": { deepline: ["email.find"], hostedEmail: ["email.find"] },
  "convex/lib/providers/phoneFind.ts": { hostedPhone: ["phone.find"] },
  "convex/lib/providers/treg.ts": { treg: ["phone.find", "person.enrich", "company.enrich", "people.search"] },
  "convex/lib/providers/meter.ts": { receipt: ["receipt"] },
  "convex/lib/providers/linkedin.ts": { unipile: ["linkedin.send", "linkedin.read"] },
  "convex/lib/emailFinder.ts": { treg: ["email.find", "email.verify"], hostedEmail: ["email.find"] },
  "convex/lib/phoneFinder.ts": { treg: ["phone.find"] },
  "convex/lib/companyenrich.ts": { treg: ["company.enrich"] },
  "convex/lib/crustdata.ts": { treg: ["company.enrich"] },
  "convex/lib/leadsforge.ts": { treg: ["people.search"], peopleSearch: ["people.search"] },
  "convex/lib/quickenrich.ts": { treg: ["people.search"], peopleSearch: ["people.search"] },
  "convex/deepline.ts": { deepline: ["connect"] },
  "convex/records.ts": { receipt: ["receipt"] },
  "convex/callSuggestionActions.ts": { treg: ["web.search"] },
  "convex/lib/social/search.ts": { treg: ["web.search"] },
  "convex/marketSourcesSearch.ts": { treg: ["web.search"] },
  "convex/researchAgentActions.ts": { treg: ["web.search"] },
  "convex/conversationActions.ts": { unipile: ["email.read"] },
  "convex/emailActions.ts": { unipile: ["email.send"] },
  "convex/lib/outbound/mailboxAdapter.ts": { unipile: ["email.send"] },
  "convex/moduleMeActions.ts": { unipile: ["email.send"] },
  "convex/dialerActions.ts": { telnyx: ["phone.call"] },
  "convex/audienceActions.ts": { sequencers: ["sequence.enroll"] },
  "convex/lib/outbound/push.ts": { sequencers: ["sequence.enroll"] },
  "convex/lib/outbound/sequencers.ts": { sequencers: ["connect"] },
  "convex/expleeActions.ts": { explee: ["connect", "people.search"] },
  "convex/moduleSocialActions.ts": { receipt: ["receipt"] },
  "convex/researchSessionActions.ts": { receipt: ["receipt"] },
  "convex/marketSources.ts": { receipt: ["receipt"] },
  "convex/tamInvestigations.ts": { receipt: ["receipt"] },
};

function sources(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((d) => {
    const path = `${dir}/${d.name}`;
    if (d.isDirectory()) return d.name === "_generated" ? [] : sources(path);
    return /\.tsx?$/.test(d.name) ? [path] : [];
  });
}

function callSites(): Map<string, Entry[]> {
  const found = new Map<string, Entry[]>();
  for (const file of sources("convex")) {
    const text = readFileSync(join(ROOT, file), "utf8");
    const entries = (Object.keys(ENTRIES) as Entry[]).filter((e) => ENTRIES[e].test(text));
    if (entries.length) found.set(relative(ROOT, join(ROOT, file)), entries);
  }
  return found;
}

test("every provider call site in convex/ is in the census, and every census row still is one", () => {
  const sites = callSites();
  const actual = [...sites].flatMap(([file, entries]) => entries.map((e) => `${file} ${e}`)).sort();
  const listed = Object.entries(CENSUS).flatMap(([file, rows]) => Object.keys(rows).map((e) => `${file} ${e}`)).sort();
  assert.deepEqual(actual.filter((s) => !listed.includes(s)), [], "a new provider call site: list it in CENSUS, or route it through the provider registry");
  assert.deepEqual(listed.filter((s) => !actual.includes(s)), [], "a census row no longer calls its provider: remove it");
});

test("a capability the registry serves runs only inside the registry or a provider adapter", () => {
  const served = new Set<Use>(Object.values(PROVIDERS).flatMap((p) => p.capabilities));
  const bypass = Object.entries(CENSUS).flatMap(([file, rows]) =>
    Object.values(rows).flat().filter((use) => served.has(use) && !file.startsWith("convex/lib/providers/") && !ADAPTERS.has(file) && !LATER[file]?.includes(use)).map((use) => `${file} ${use}`));
  assert.deepEqual(bypass, []);
  const hostedEmailCallers = Object.entries(CENSUS).filter(([, rows]) => rows.hostedEmail || rows.deepline?.includes("email.find")).map(([file]) => file);
  assert.deepEqual(hostedEmailCallers.filter((f) => !f.startsWith("convex/lib/providers/") && !ADAPTERS.has(f)), []);
  for (const [file, rows] of Object.entries(CENSUS)) {
    if (rows.receipt && !file.startsWith("convex/lib/providers/")) assert.ok(!readFileSync(join(ROOT, file), "utf8").includes('feature: "find_email"'), `${file} files an email lookup's receipt outside the registry's meter`);
  }
});
