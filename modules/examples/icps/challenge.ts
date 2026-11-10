import type { CallFunctions, Intent, ReadDoc } from "../../kernel/calls.ts";
import type { Icp } from "../../../engine/src/icp.ts";
import { employeeBandsToRange } from "../../../engine/src/icp.ts";
import { icpGeosToCountries } from "../../kernel/icpGeography.ts";
import { icpIndustriesToLeadsforge } from "../../../convex/lib/icpIndustries.ts";
import { textHash } from "../../kernel/ai.ts";
import { publicPageUrl, webPagesRequest } from "../../kernel/webPages.ts";
import { freePopulationRequest } from "../../kernel/freePopulation.ts";
import { CRM_SOURCE, MAX_READ_URLS, addCited, contextText, parseProposals, proposalSearch, verifyClaims, type ChallengeContext, type Proposal, type FetchedPage } from "./challengeDomain.ts";

const docs = (value: unknown) => value as ReadDoc[];
const expect = (collection: string, d: ReadDoc) => ({ collection, key: d.key, version: d.version });
const waiting = (value: unknown, state: string): ReadDoc => {
  const run = value as ReadDoc | null;
  if (!run || run.data.state !== state) throw new Error("This challenge is no longer waiting for this stage.");
  return run;
};
const move = (run: ReadDoc, name: string): Intent => ({ op: "transition", machine: "challenge", name, key: run.key });
const patch = (run: ReadDoc, data: Record<string, unknown>): Intent => ({ op: "patch", collection: "challenges", key: run.key, data, expect: [expect("challenges", run)] });
const context = (run: ReadDoc): ChallengeContext => JSON.parse(String(run.data.contextJson)) as ChallengeContext;
const pages = (value: unknown) => value as FetchedPage[];
const homeEvidence = (run: ReadDoc) => [{ url: CRM_SOURCE, text: String(run.data.crmText) }, ...pages(run.data.homePages ?? [])];
const proposal = (market: ReadDoc): Proposal => JSON.parse(String(market.data.proposalJson)) as Proposal;
const claimsText = (p: Proposal) => p.claims.map((c) => c.quote ? `${c.text}\nEvidence: "${c.quote}" (${c.sourceUrl})` : `Hypothesis: ${c.text}`).join("\n\n") || "No supported claims.";
const marketData = (p: Proposal) => ({ name: p.name, rationale: p.rationale, industries: p.industries, proposalJson: JSON.stringify(p), claimsText: claimsText(p), risksText: p.risks.join("\n"), sourcesText: [...new Set(p.claims.flatMap((c) => c.quote && c.sourceUrl ? [c.sourceUrl] : []))].join("\n") || "No verified sources" });
const safeUrls = (urls: string[]) => [...new Set(urls.flatMap((url) => { try { return [publicPageUrl(url)]; } catch { return []; } }))].slice(0, MAX_READ_URLS);

export const challengeCalls: CallFunctions = {
  startChallenge(ctx, reads) {
    const plan = (reads.plan as Array<{ available: boolean }>)[0];
    if (!plan?.available) throw new Error("Connect ChatGPT in Integrations before challenging your ICP. This workflow uses your plan only.");
    const runs = docs(reads.runs).sort((a, b) => Number(b.data.startedAt) - Number(a.data.startedAt));
    const markets = docs(reads.markets);
    const active = runs.filter((r) => !["done", "failed"].includes(String(r.data.state)));
    if (active.some((r) => Number(r.data.startedAt) > ctx.now - 600000)) throw new Error("A challenge is still running. Retry a stopped run after ten minutes.");
    const signup = (reads.signup as Array<{ domain: string; icp?: Icp; sells: string[] }>)[0];
    const recent = new Set(runs.slice(0, 10).map((r) => r.key));
    const shaped = (rows: unknown, won: boolean) => (rows as Array<Record<string, unknown>>).map((d) => {
      const company = d.company as Record<string, unknown> | null;
      return { name: typeof d.name === "string" ? d.name : "Unnamed opportunity", ...(won && typeof d.amount === "number" && typeof d.currency === "string" ? { amount: d.amount / 100, currency: d.currency } : {}), ...(typeof company?.name === "string" ? { account: company.name } : {}), ...(typeof company?.industry === "string" ? { industry: company.industry } : {}), ...(typeof company?.employees === "number" ? { employees: company.employees } : {}) };
    });
    const c: ChallengeContext = {
      ...(signup?.domain ? { vendorDomain: webPagesRequest({ domain: signup.domain }).domain! } : {}), ...(signup?.icp ? { icp: signup.icp } : {}), sells: signup?.sells ?? [],
      wonDeals: shaped(reads.won, true), lostDeals: shaped(reads.lost, false),
      bestAccounts: (reads.best as Array<Record<string, unknown>>).map((a) => ({ name: typeof a.name === "string" ? a.name : "Unnamed account", ...(typeof a.industry === "string" ? { industry: a.industry } : {}), ...(typeof a.employees === "number" ? { employees: a.employees } : {}), ...(typeof a.country === "string" ? { country: a.country } : {}) })),
      decided: markets.filter((m) => recent.has(String(m.data.run)) && m.data.state !== "open").map((m) => ({ name: String(m.data.name), industries: m.data.industries as string[], state: String(m.data.state), ...(m.data.dismissReason ? { reason: String(m.data.dismissReason) } : {}) })),
    };
    const key = `challenge-${ctx.now.toString(36)}-${textHash(ctx.caller.userId)}`;
    const prune = new Set(runs.slice(9).map((r) => r.key));
    const intents: Intent[] = [
      ...active.filter((r) => !prune.has(r.key)).map((r): Intent => move(r, "expired")),
      ...markets.filter((m) => prune.has(String(m.data.run))).map((m): Intent => ({ op: "delete", collection: "markets", key: m.key })),
      ...runs.filter((r) => prune.has(r.key)).map((r): Intent => ({ op: "delete", collection: "challenges", key: r.key })),
      { op: "put", collection: "challenges", key, data: { name: "Challenge my ICP", startedBy: ctx.caller.userId, startedAt: ctx.now, domain: c.vendorDomain ?? "", contextJson: JSON.stringify(c), crmText: contextText(c), url: CRM_SOURCE, homeUrls: c.vendorDomain ? safeUrls([`https://${c.vendorDomain}/`]) : [], requestedUrls: [], searches: [], homePages: [], citationPages: [] }, expect: [...runs.map((r) => expect("challenges", r)), ...markets.map((m) => expect("markets", m)), { collection: "challenges", key, version: null }], expectCount: [{ collection: "challenges", count: runs.length }, { collection: "markets", count: markets.length }] },
      { op: "transition", machine: "challenge", name: "start", key },
    ];
    return { intents, value: { key } };
  },
  prepareChallenge(_ctx, reads) {
    const run = waiting(reads.run, "reading");
    return { intents: [patch(run, { homePages: reads.pages }), move(run, "propose")] };
  },
  refineChallenge(_ctx, reads) {
    const run = waiting(reads.run, "proposing");
    const c = context(run), icp = c.icp as Icp | undefined;
    const current = icp ? { companyIndustries: { include: icpIndustriesToLeadsforge(icp.firmographics.industries) }, companyEmployeeNumberRange: employeeBandsToRange(icp.firmographics.employeeBands) ?? undefined } : {};
    const found = parseProposals({ proposals: run.data.proposals }, { icp: current, decided: c.decided }).map((p) => ({ ...p, countries: icpGeosToCountries(p.countries), readUrls: safeUrls(p.readUrls), claims: verifyClaims(p.claims, homeEvidence(run)) }));
    if (!found.length) throw new Error("The model proposed no usable markets outside your current ICP. Try again.");
    const searches = found.map((p) => { const q = proposalSearch(p, icp); freePopulationRequest(q); return q; });
    const intents: Intent[] = found.map((p, i) => ({ op: "put", collection: "markets", key: `${run.key}-${i}`, data: { ...marketData(p), run: run.key, position: i, search: searches[i] }, expect: [{ collection: "markets", key: `${run.key}-${i}`, version: null }] }));
    return { intents: [patch(run, { requestedUrls: safeUrls(found.flatMap((p) => p.readUrls)), searches }), ...intents, move(run, "readCitations")] };
  },
  readChallengeCitations(_ctx, reads) {
    const run = waiting(reads.run, "checking");
    const read = pages(reads.pages);
    return { intents: [patch(run, { citationPages: read }), move(run, read.length ? "cite" : "size")] };
  },
  finishCitations(_ctx, reads) {
    const run = waiting(reads.run, "citing");
    const markets = docs(reads.markets).filter((m) => m.data.run === run.key).sort((a, b) => Number(a.data.position) - Number(b.data.position));
    const cited = addCited(markets.map(proposal), { claims: run.data.citations }, pages(run.data.citationPages));
    return { intents: [patch(run, {}), ...markets.map((m, i): Intent => ({ op: "patch", collection: "markets", key: m.key, data: marketData(cited[i]), expect: [expect("markets", m)] })), move(run, "size")] };
  },
  sizeChallenge(_ctx, reads) {
    const run = waiting(reads.run, "sizing");
    const sizes = new Map((reads.sizes as Array<{ id: string; size?: { accounts: number; capped: boolean }; transport: string }>).map((s) => [s.id, s]));
    const markets = docs(reads.markets).filter((m) => m.data.run === run.key);
    const intents: Intent[] = markets.map((m) => {
      const result = sizes.get(String(m.data.search));
      return { op: "patch", collection: "markets", key: m.key, data: { sizeText: result?.size ? `${result.size.capped ? "At least " : ""}${result.size.accounts.toLocaleString("en-US")} accounts${result.transport === "fake" ? " (test transport, no provider called)" : ""}` : "Size unavailable" }, expect: [expect("markets", m)] };
    });
    return { intents: [patch(run, {}), ...intents, move(run, "done")] };
  },
};
