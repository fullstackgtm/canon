import { ConvexError } from "convex/values";
import type { Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { isEnabled, manifestOf, packageRow } from "../modules/packages";
import { recordObjectName, reportSource, reportsTakeover } from "../../../modules/kernel/reports.ts";
import type { ReportSpec } from "../../../modules/kernel/reportValidators";

export const REPORTS_MODULE = "@canon/reports";

export async function reportsLegacyState(ctx: QueryCtx, orgId: Id<"organizations">) {
  const pkg = await packageRow(ctx, orgId, REPORTS_MODULE);
  const takeover = !!pkg && reportsTakeover(pkg);
  return { takeover, fallback: !!pkg && !!manifestOf(pkg).imports?.includes("reports.legacy") && (!takeover || pkg.status !== "installed" || !await isEnabled(ctx, orgId, REPORTS_MODULE)) };
}

export const legacyReportSpec = (spec: ReportSpec): ReportSpec => ({ ...spec, object: recordObjectName(spec.object) ?? spec.object });

export function moduleReportSpec(spec: ReportSpec): ReportSpec {
  const object = reportSource(spec.object);
  if (!object) throw new ConvexError(`No Reports source for ${spec.object}`);
  return { ...spec, object };
}
