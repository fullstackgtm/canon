"use client";

import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useReportsModuleHref } from "@/components/shell/reports-module";
import { LoadingRows } from "@/components/dashboard";
import { ReportsHome } from "@/components/reports/reports-home";

export default function ReportsPage() {
  return (
    <Suspense fallback={<LoadingRows />}>
      <Dashboards />
    </Suspense>
  );
}

function Dashboards() {
  const params = useSearchParams();
  const router = useRouter();
  const dashboardId = params.get("d");
  const legacy = useQuery(api.dashboards.legacyRoute, dashboardId ? { dashboardId } : "skip");
  const moduleTarget = useReportsModuleHref(false, "dashboards", params.toString());
  const target = dashboardId && legacy === undefined ? undefined : legacy ? null : moduleTarget;
  useEffect(() => { if (target) router.replace(target); }, [target, router]);
  if (target !== null) return <LoadingRows />;
  return <ReportsHome />;
}
