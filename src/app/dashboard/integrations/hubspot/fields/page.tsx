"use client";

import Link from "next/link";
import { fieldsHref } from "@/components/field-standards/shared";
import { FreeFillPanel } from "../free-fill-panel";

export default function HubspotFieldsPage() {
  return (
    <div>
      <p className="mb-4 max-w-[72ch] text-sm text-muted-foreground">
        Canon fields, such as one industry across HubSpot and Salesforce, sit above both CRMs and have{" "}
        <Link href={fieldsHref()} className="text-primary underline-offset-4 hover:underline">
          their own page
        </Link>
        .
      </p>
      <h2 className="mb-2 text-sm font-medium">Fill from enrichment sources</h2>
      <FreeFillPanel />
    </div>
  );
}
