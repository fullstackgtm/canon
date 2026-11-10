"use client";

import { SettingsPage } from "../settings-ui";
import { OutboundTab } from "../outbound-tab";

export default function OutboundSettingsPage() {
  return (
    <SettingsPage area="outbound">
      <OutboundTab />
    </SettingsPage>
  );
}
