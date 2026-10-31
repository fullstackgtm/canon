"use client";

import { Suspense } from "react";
import { LoadingRows } from "@/components/dashboard";
import { SettingsPage, useSettingsAccess } from "../settings-ui";
import { TeamTab } from "../team-tab";
import { TeamsTab } from "../teams-tab";

export default function TeamSettingsPage() {
  const { isAdmin } = useSettingsAccess();
  return (
    <SettingsPage area="team">
      <Suspense fallback={<LoadingRows count={3} />}>
        <TeamTab />
      </Suspense>
      {isAdmin && (
        <section className="mt-10">
          <h2 className="mb-3 text-xs font-medium text-muted-foreground">Teams</h2>
          <TeamsTab />
        </section>
      )}
    </SettingsPage>
  );
}
