"use client";

import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import type { PlanChoices } from "../../../../../convex/lib/reports/targets";
import { LoadingRows } from "@/components/dashboard";
import { SettingsPage } from "../settings-ui";
import { TargetsEditor } from "../targets-editor";

/** The fiscal year's targets: everyone reads them, and holders of targets.set set them. Reports pacing reads the plan. */
export default function TargetsSettingsPage() {
  const router = useRouter();
  const current = useQuery(api.targets.get, {});
  if (current === undefined) return <SettingsPage area="targets"><LoadingRows count={5} /></SettingsPage>;
  const p = current.plan;
  const saved: PlanChoices | null = p ? { year: p.year, total: p.total, coverage: p.coverage, months: p.months, teams: p.teams, reps: p.reps } : null;
  return (
    <TargetsEditor key={p?._id ?? "new"} year={current.year} fyStart={current.fyStart} saved={saved} roster={current.roster} canEdit={current.canEdit}
      onDone={() => router.push("/dashboard/settings?selected=targets")} />
  );
}
