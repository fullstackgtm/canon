"use client";

import { SettingsPage } from "../settings-ui";
import { WorkspaceForm } from "../workspace-form";
import { SampleDataSection } from "../sample-data-section";

export default function WorkspaceSettingsPage() {
  return (
    <SettingsPage area="workspace">
      <WorkspaceForm />
      <SampleDataSection />
    </SettingsPage>
  );
}
