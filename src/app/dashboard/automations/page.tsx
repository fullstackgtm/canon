"use client";

import { Suspense } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ViewFrame } from "@/components/dashboard";
import { AutomationRules } from "./automations";

/** Automation rules: when a record changes, or on a schedule, do the same thing every time. No AI and no plan behind it. */
export default function AutomationsPage() {
  return <Suspense><Automations /></Suspense>;
}

function Automations() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const selected = params.get("rule");
  const creating = params.get("new") === "1";
  const go = (query: string) => router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  return (
    <ViewFrame
      title="Automations"
      description="A rule acts when a record changes in Canon, or on a schedule over the records that match: it sets a field, creates a task or assigns an owner, the same way every time. Each rule acts as one admin, with that admin's access, and never on what an import or CRM sync brings in. No AI runs."
      actions={selected || creating ? [] : [{ id: "automations-new", primary: true, label: "New rule", onClick: () => go("new=1") }]}
    >
      <AutomationRules selected={selected} creating={creating} onSelect={(id) => go(id ? `rule=${id}` : "")} />
    </ViewFrame>
  );
}
