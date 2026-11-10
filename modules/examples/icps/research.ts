import type { CallFunctions, Expect, Intent, ReadDoc } from "../../kernel/calls.ts";
import { textHash } from "../../kernel/ai.ts";
import { webPagesRequest } from "../../kernel/webPages.ts";
import { cleanResearchSpec, specFromIcp } from "../../kernel/icpResearchSpec.ts";
import { parseQuery, specToQuery, queryToSpec } from "../../kernel/icpQuery.ts";
import { researchTree } from "../../kernel/icpResearchTree.ts";
import type { IcpSpec } from "../../kernel/icpSpec.ts";
import { normalizeWebsiteIcpModelResult } from "../../../engine/src/portable/icpDeriveContract.ts";
import type { WebsiteSource } from "../../../engine/src/portable/icpDeriveContract.ts";

export const researchCalls: CallFunctions = {
  deriveFromWebsite(ctx) {
    const domain = webPagesRequest({ domain: ctx.args.domain }).domain!;
    const key = `derive-${ctx.now.toString(36)}-${textHash(domain)}-${ctx.caller.userId}`;
    return { intents: [
      { op: "put", collection: "derivations", key, data: { domain, startedBy: ctx.caller.userId }, expect: [{ collection: "derivations", key, version: null }] },
      { op: "transition", machine: "websiteResearch", name: "start", key },
    ], value: { key } };
  },
  adoptDerived(ctx, reads) {
    const run = reads.derivation as ReadDoc | null;
    if (!run || run.data.state !== "deriving") throw new Error("This website research is no longer waiting for adoption.");
    const raw = run.data.result as Record<string, unknown> | undefined;
    if (!raw) throw new Error("The model returned no research result.");
    const sources = run.data.sources as WebsiteSource[];
    const evidence = raw.evidence as Array<{ quote: string; source: string }>;
    if (!Array.isArray(sources) || !Array.isArray(evidence) || evidence.length < 2 || !evidence.every((q) => q.quote.trim().length >= 12 && sources.some((s) => s.id === q.source && s.text.includes(q.quote)))) throw new Error("Research stopped because it has fewer than two exact website quotes.");
    const derived = normalizeWebsiteIcpModelResult({ domain: String(run.data.domain), sources, raw, model: String(run.data.model) });
    const spec = cleanResearchSpec(specFromIcp(derived.icp));
    const query = specToQuery(spec);
    const parsed = parseQuery(query, "icp");
    if (parsed.errors.length) throw new Error(parsed.errors.join("; "));
    const definitions = reads.definitions as ReadDoc[];
    const key = run.key.replace(/^derive-/, "website-");
    const expect: Expect[] = [{ collection: "derivations", key: run.key, version: run.version }, ...definitions.map((d) => ({ collection: "icps", key: d.key, version: d.version })), { collection: "icps", key, version: null }];
    const company = derived.company.name;
    return { intents: [{ op: "put", collection: "icps", key,
      data: { name: `${company.slice(0, 65)} (from website)`, description: derived.company.summary, query, spec: queryToSpec(parsed.query), source: "website", sourceDomain: run.data.domain, active: definitions.length === 0, isDefault: definitions.length === 0, createdAt: ctx.now },
      expect, expectCount: [{ collection: "icps", count: definitions.length }],
    }], value: { key } };
  },
  importResearch(ctx, reads) {
    const research = (reads.signup as Array<{ id: string; domain: string; query: string; spec: IcpSpec; saved: boolean; heuristic: boolean }>)[0];
    if (!research) throw new Error("There is no claimed signup research to import.");
    if (research.saved) throw new Error("This signup research has already been saved.");
    const definitions = reads.definitions as ReadDoc[];
    const key = `signup-${research.id}`;
    const intents: Intent[] = [{ op: "put", collection: "icps", key, data: { name: `${research.domain.slice(0, 62)} (signup research)`, spec: research.spec, query: research.query, source: "research", sourceDomain: research.domain,
      active: !definitions.some((d) => d.data.active), isDefault: definitions.length === 0, createdAt: ctx.now },
      expect: [...definitions.map((d) => ({ collection: "icps", key: d.key, version: d.version })), { collection: "icps", key, version: null }], expectCount: [{ collection: "icps", count: definitions.length }],
    }];
    const nodes = reads.nodes as ReadDoc[];
    const tree = researchTree(research.spec);
    if (nodes.length + tree.length > 75) throw new Error("There is no room for the signup research's segments and personas.");
    for (const [index, { parent, ...node }] of tree.entries()) intents.push({ op: "put", collection: "nodes", key: `${key}-${index}`, data: {
      ...node, icp: key, ...(parent !== undefined ? { parent: `${key}-${parent}` } : {}), createdAt: ctx.now,
    }, expect: [{ collection: "nodes", key: `${key}-${index}`, version: null }] });
    intents[0].expectCount!.push({ collection: "nodes", count: nodes.length });
    return { intents, value: { key, heuristic: research.heuristic } };
  },
};
