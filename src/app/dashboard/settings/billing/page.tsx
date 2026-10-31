"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { BillingTab } from "../billing-tab";
import { SettingsPage, useSettingsAccess } from "../settings-ui";
import { UsageTab } from "../usage-tab";

/** Credits, invoices and this month's usage in one place. Stripe Checkout returns here with ?credits=success. */
function BillingContent() {
  const justBought = useSearchParams().get("credits") === "success";
  const { canEdit } = useSettingsAccess();
  return (
    <div className="max-w-3xl space-y-6">
      <BillingTab justBoughtCredits={justBought} />
      {canEdit && <UsageTab />}
    </div>
  );
}

export default function BillingSettingsPage() {
  return (
    <SettingsPage area="billing">
      <Suspense fallback={null}>
        <BillingContent />
      </Suspense>
    </SettingsPage>
  );
}
