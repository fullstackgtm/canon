"use client";

import { SettingsPage } from "../settings-ui";
import { FeedsTab } from "../feeds-tab";

export default function FeedsSettingsPage() {
  return (
    <SettingsPage area="feeds">
      <FeedsTab />
    </SettingsPage>
  );
}
