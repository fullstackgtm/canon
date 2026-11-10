"use client";

import { mapKey } from "../../../../convex/lib/consolidate";
import { ViewFrame } from "@/components/dashboard";
import { FieldStandardsList } from "@/components/field-standards/list-page";
import { useFreeFillReport } from "../integrations/hubspot/free-fill-panel";

export default function CanonFieldsPage() {
  const report = useFreeFillReport();
  return (
    <ViewFrame title="Canon fields">
      <FieldStandardsList
        note={(row) => {
          const field = report?.fields.find((f) => f.property === mapKey(row.concept) || mapKey(f.label) === mapKey(row.concept));
          return field && field.fillable > 0 ? <span className="block text-primary">Enrichment can add {field.fillable.toLocaleString()}</span> : null;
        }}
      />
    </ViewFrame>
  );
}
