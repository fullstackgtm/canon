/** A target account's engagement and status, on the workspace's abm.model. Pure. */
import type { AbmModel } from "../../recipes/models.ts";

export type AbmAccountStatus = "target" | "engaged" | "opportunity" | "customer" | "churned";

type Signals = { openDeals: number; openPipeline: number; contacts: number; owned: boolean; won: boolean };

export function engagementScore(m: AbmModel, s: Signals): number {
  const p = m.points;
  return Math.min(100, Math.round(
    (s.openDeals > 0 ? p.openDeal : 0) +
      Math.min(s.openPipeline / p.pipelinePerPoint, p.pipelineMax) +
      Math.min(s.contacts * p.contact, p.contactMax) +
      (s.owned ? p.owner : 0) +
      (s.won ? p.won : 0),
  ));
}

export function accountStatus(m: AbmModel, s: { score: number; openDeals: number; won: boolean }): AbmAccountStatus {
  if (s.won) return "customer";
  if (s.openDeals > 0) return "opportunity";
  return s.score >= m.engaged ? "engaged" : "target";
}
