"use client";

import { SettingsPage } from "../settings-ui";
import { WorkspaceForm } from "../workspace-form";
import { SampleDataSection } from "../sample-data-section";
import { ExportSection } from "../export-section";
import { ArrivedOffLink, ImportSection } from "../import-section";

export default function WorkspaceSettingsPage() {
  return (
    <SettingsPage area="workspace">
      <WorkspaceForm />
      <SampleDataSection />
      <ExportSection />
      <ImportSection />
      <ArrivedOffLink />
    </SettingsPage>
  );
}
