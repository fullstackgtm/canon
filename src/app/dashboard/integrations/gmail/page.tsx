"use client";

import { useQuery } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { Panel } from "@/components/salesforce-sync/ui";
import { IntegrationPage } from "../integration-ui";
import { GmailControls } from "../gmail-card";
import { ReadMyMessages, UnlinkedReads } from "../intake-settings";

export default function GmailIntegrationPage() {
  const mine = useQuery(api.emailAccounts.mine);
  return (
    <IntegrationPage integration="gmail">
      <Panel title="Linked accounts">
        <GmailControls />
      </Panel>
      {mine?.accounts.map((account) => (
        <ReadMyMessages key={account._id} accountId={account._id} intake={account.intake} channel="email" subject={account.address} />
      ))}
      <UnlinkedReads channel="email" />
    </IntegrationPage>
  );
}
