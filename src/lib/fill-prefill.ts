import type { IcpSpec } from "../../convex/lib/icpSpec";

type FillIcp = { key: string; active: boolean; updatedAt: number; spec: IcpSpec };
type FillContext = { canRun: boolean; configured: boolean; icps: readonly { key: string }[] };
export type FillPrefill =
  | { status: "none" }
  | { status: "loading" }
  | { status: "refused"; reason: string }
  | { status: "ready"; icp: FillIcp; revision: string };

export function resolveFillPrefill(
  request: string | undefined,
  source: { icps: readonly FillIcp[] } | null | undefined | Error,
  context: FillContext | null | undefined | Error,
): FillPrefill {
  if (request === undefined) return { status: "none" };
  if (!request) return { status: "refused", reason: "The fill link has no ICP key. Close it and choose an active ICP." };
  if (source instanceof Error || context instanceof Error || source === null || context === null) {
    return { status: "refused", reason: "This ICP could not be loaded for your workspace. Close this dialog and try the ICP link again." };
  }
  if (source === undefined || context === undefined) return { status: "loading" };
  const icp = source.icps.find((i) => i.key === request);
  if (!icp || !icp.active || !context.icps.some((i) => i.key === request)) {
    return { status: "refused", reason: "This ICP is unavailable or off. Close this dialog and choose a current active ICP." };
  }
  if (!context.canRun || !context.configured) {
    return { status: "refused", reason: "Filling from this ICP is unavailable for your current access or data-source configuration." };
  }
  return { status: "ready", icp, revision: JSON.stringify([icp.key, icp.updatedAt, icp.spec]) };
}
