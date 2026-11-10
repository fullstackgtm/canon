"use client";

import { SettingsPage } from "../settings-ui";
import { EmailLoggingTab } from "../email-logging-tab";

export default function EmailLoggingSettingsPage() {
  return (
    <SettingsPage area="emailLog">
      <EmailLoggingTab />
    </SettingsPage>
  );
}
