"use client";

import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { recordRelations } from "../../../recipes/recordRelations";
import { RecordPicker } from "./lookup-field";
import { relatedListHref } from "./record-relation-query";

export function RelatedPeopleFilters() {
  const router = useRouter();
  const company = useQuery(api.objects.describe, { object: "account" });
  const deal = useQuery(api.objects.describe, { object: "deal" });
  const person = useQuery(api.objects.describe, { object: "contact" });
  if (!person?.readable || (!company?.readable && !deal?.readable)) return null;
  const objects = [person];
  return (
    <details className="mt-2">
      <summary className="w-fit cursor-pointer border border-dashed border-border px-2 py-1 text-xs font-medium text-muted-foreground">Filter by related company or opportunity</summary>
      <p className="mt-2 text-xs text-muted-foreground">Open a related People list. Current field filters do not carry over.</p>
      <div className="mt-2 flex flex-wrap gap-3">
        {([
          { object: "account", description: company, relationship: "companyPeople", label: "Search company" },
          { object: "deal", description: deal, relationship: "dealPeople", label: "Search opportunity" },
        ] as const).map(({ object, description, relationship, label }) => {
          const relation = description?.readable && recordRelations(object, objects).find((r) => r.id === relationship);
          return relation ? <div key={object} className="w-64">
            <RecordPicker object={object} label={label} onPick={({ id }) => router.push(relatedListHref({ object, id }, relation))} />
          </div> : null;
        })}
      </div>
    </details>
  );
}
