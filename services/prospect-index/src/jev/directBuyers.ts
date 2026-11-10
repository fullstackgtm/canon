// Direct buyer detection; implementation shared with onboarding
// (convex/lib/segments/marketSegments.ts).
import { directBuyers as shared, type BuyerScore } from "../../../../convex/lib/segments/marketSegments.ts";
import { pacedAsk } from "./sharedSegments.ts";

export type { BuyerScore };
export const directBuyers = (domain: string, siteText: string) => shared(pacedAsk, domain, siteText);
