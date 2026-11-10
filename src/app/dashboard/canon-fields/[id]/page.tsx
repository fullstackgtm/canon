"use client";

import { ViewFrame } from "@/components/dashboard";
import { FieldStandardPage } from "@/components/field-standards/detail-page";
import { EnrichmentCheck } from "../../integrations/hubspot/enrichment-check";

export default function CanonFieldPage() {
  return (
    <ViewFrame title="Canon fields">
      <FieldStandardPage notice={(c) => <EnrichmentCheck c={c} />} />
    </ViewFrame>
  );
}
