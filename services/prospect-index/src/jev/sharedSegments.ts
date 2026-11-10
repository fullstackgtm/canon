// Adapter: the segment logic lives in convex/lib/segments/marketSegments.ts so
// onboarding and this benchmark run the same code. This passes it the paced,
// usage-tracking Jev client.
import { systemOne } from "./client.ts";
import type { JevAsk } from "../../../../convex/lib/segments/marketSegments.ts";

export const pacedAsk: JevAsk = async (state, questions, est) => {
  const r = await systemOne(state, questions, est);
  return Object.fromEntries(Object.entries(r.answers).map(([k, a]) => [k, (a as { noul?: number }).noul ?? 0]));
};
