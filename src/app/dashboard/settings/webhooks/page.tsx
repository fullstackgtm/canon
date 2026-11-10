"use client";

import { SettingsPage } from "../settings-ui";
import { WebhooksTab } from "../webhooks-tab";

export default function WebhooksSettingsPage() {
  return (
    <SettingsPage area="webhooks">
      <WebhooksTab />
    </SettingsPage>
  );
}
