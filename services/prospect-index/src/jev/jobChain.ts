// Standards-based JTBD chain; implementation shared with onboarding
// (convex/lib/segments/marketSegments.ts). Data: scripts/export-segment-data.ts.
import { jobChain as shared } from "../../../../convex/lib/segments/marketSegments.ts";
import { pacedAsk } from "./sharedSegments.ts";

export const jobChain = (domain: string, siteText: string, buyers?: Promise<string[]>) => shared(pacedAsk, domain, siteText, { buyers });
