"use client";

import { SyncNav } from "@/components/salesforce-sync/ui";
import { IntegrationPage } from "../integration-ui";

export default function SalesforceSyncLayout({ children }: { children: React.ReactNode }) {
  return (
    <IntegrationPage integration="salesforce" tabs={<SyncNav />}>
      {children}
    </IntegrationPage>
  );
}
