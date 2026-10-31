"use client";

import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { LoadingRows } from "@/components/dashboard";
import { ReportBuilder } from "@/components/reports/report-builder";
import { useReportsModuleHref } from "@/components/shell/reports-module";

export default function ReportsPage() {
  return (
    <Suspense fallback={<LoadingRows />}>
      <Reports />
    </Suspense>
  );
}

function Reports() {
  const params = useSearchParams();
  const router = useRouter();
  const reportId = params.get("report");
  const legacy = useQuery(api.reports.legacyRoute, reportId ? { reportId } : "skip");
  const moduleTarget = useReportsModuleHref(false, "reports", params.toString());
  const target = reportId && legacy === undefined ? undefined : legacy ? null : moduleTarget;
  useEffect(() => { if (target) router.replace(target); }, [target, router]);
  if (target !== null) return <LoadingRows />;
  return <ReportBuilder />;
}
