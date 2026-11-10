"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { Panel } from "@/components/salesforce-sync/ui";
import { IntegrationPage } from "../integration-ui";
import { AccountSettings, IntakeSettings, LinkedinControls } from "../linkedin-card";
import { UnlinkedReads } from "../intake-settings";

export default function LinkedinIntegrationPage() {
  const mine = useQuery(api.linkedin.mine);
  const account = mine?.account;
  return (
    <IntegrationPage integration="linkedin">
      <Panel title="Account">
        <LinkedinControls />
      </Panel>
      {account && <IntakeSettings account={account} />}
      {account && (
        <Panel title="Limits and sending hours">
          <AccountSettings account={account} isAdmin={mine.isAdmin} />
        </Panel>
      )}
      {account && (
        <Panel title="Cadences">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <p className="text-sm text-muted-foreground">Build invite and message sequences and see how they perform.</p>
            <Link href="/dashboard/linkedin" className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-muted">
              Open cadences
            </Link>
          </div>
        </Panel>
      )}
      <UnlinkedReads channel="linkedin" />
    </IntegrationPage>
  );
}
