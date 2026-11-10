"use client";

import Link from "next/link";
import { Panel } from "@/components/salesforce-sync/ui";
import { IntegrationPage } from "../integration-ui";
import { DialerControls } from "../dialer-card";

export default function DialerIntegrationPage() {
  return (
    <IntegrationPage integration="dialer">
      <Panel title="Numbers, recording and do-not-call">
        <DialerControls />
      </Panel>
      <Panel title="Calling">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <p className="text-sm text-muted-foreground">Work a call queue, or call any contact from their page.</p>
          <Link href="/dashboard/dialer" className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-muted">
            Open the dialer
          </Link>
        </div>
      </Panel>
    </IntegrationPage>
  );
}
