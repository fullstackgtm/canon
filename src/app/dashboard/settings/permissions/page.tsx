"use client";

import { PermissionsTab } from "../permissions-tab";
import { SettingsPage } from "../settings-ui";

export default function PermissionsSettingsPage() {
  return (
    <SettingsPage area="permissions">
      <PermissionsTab />
    </SettingsPage>
  );
}
